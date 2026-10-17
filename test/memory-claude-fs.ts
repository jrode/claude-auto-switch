import path from 'node:path';
import type { RepairFs } from '../src/launcher/claude-repair.js';

/**
 * A Windows program as small as one can be and still say how long it is: an
 * MZ header, a PE header with one section, and that section's bytes. Cut to
 * `length`, it is one npm is still writing.
 */
export function windowsProgram(declared = 1024, length = declared, kind: 'PE32+' | 'PE32' = 'PE32+'): string {
  const bytes = Buffer.alloc(Math.max(declared, length));
  // A PE32 optional header is 224 bytes, its directory count at 92; PE32+'s is 240, at 108.
  const optionalSize = kind === 'PE32' ? 224 : 240;
  const table = 0x58 + optionalSize;
  bytes.write('MZ', 0, 'latin1');
  bytes.writeUInt32LE(0x40, 0x3c); // where the PE header is
  bytes.writeUInt32LE(0x00004550, 0x40); // "PE" and two zero bytes
  bytes.writeUInt16LE(1, 0x46); // one section
  bytes.writeUInt16LE(optionalSize, 0x54); // the optional header's size
  bytes.writeUInt16LE(kind === 'PE32' ? 0x10b : 0x20b, 0x58);
  bytes.writeUInt32LE(16, 0x58 + (kind === 'PE32' ? 92 : 108)); // sixteen data directories, none of them a signature
  bytes.writeUInt32LE(declared - 0x200, table + 16); // the section's size
  bytes.writeUInt32LE(0x200, table + 20); // and where it starts
  bytes.write(', a Windows program', 0x200, 'latin1');
  return bytes.subarray(0, length).toString('latin1');
}

/** A whole Windows program, which is what the resolver reads to tell one. */
export const WINDOWS_PROGRAM = windowsProgram();

/** The first lines of the bin/claude.exe that Claude Code's npm package ships. */
export const NPM_PLACEHOLDER = [
  'echo "Error: claude native binary not installed." >&2',
  'echo "" >&2',
  'echo "Either postinstall did not run (--ignore-scripts, some pnpm configs)" >&2',
  'exit 1',
  '',
].join('\n');

/** The `claude.cmd` npm writes for a package whose bin is `bin/claude.exe`. */
export const NPM_CMD_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
  '',
].join('\r\n');

/** The `claude.ps1` npm writes beside it. */
export const NPM_PS1_SHIM = [
  '#!/usr/bin/env pwsh',
  '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent',
  '& "$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe"   $args',
  'exit $LASTEXITCODE',
  '',
].join('\n');

/** The extensionless `claude` npm writes for Git Bash. */
export const NPM_SH_SHIM = [
  '#!/bin/sh',
  'basedir=$(dirname "$0")',
  'exec "$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe"   "$@"',
  '',
].join('\n');

/** The `claude.cmd` npm writes for an older Claude Code, whose bin is `cli.js`, run by node. */
export const NPM_CLI_JS_CMD_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  '',
].join('\r\n');

export interface MemoryFsOptions {
  /** Files another process holds open in a way that stops Windows renaming or removing them. */
  inUse?: string[];
  /** Files that exist but cannot be opened. */
  unreadable?: string[];
  /** Make link or copy fail with this error code. */
  refuse?: { link?: string; copy?: string };
  /** When files and folders last changed. The rest of the layout changed long ago. */
  modified?: Record<string, number>;
}

export interface MemoryFs extends RepairFs {
  /** A file's content, or undefined when there is none. */
  content(file: string): string | undefined;
  /** Put a file in place, as another process (npm, another ccx) would, by default now. */
  put(file: string, content: string, at?: number): void;
  /** Every change made through this file system, in order. */
  changes: string[];
}

/**
 * A Windows disk in memory, for laying out an npm install on any host.
 * `layout` maps a path to its content, or to null for an empty folder.
 * Paths compare the way Windows compares them, without regard to case, and a
 * rename replaces a file already at its target, as Node's does on Windows
 * (MoveFileEx with MOVEFILE_REPLACE_EXISTING); a link and a copy never do.
 */
export function memoryWindowsFs(layout: Record<string, string | null>, options: MemoryFsOptions = {}): MemoryFs {
  const p = path.win32;
  const key = (f: string): string => p.normalize(f).toLowerCase();
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const times = new Map<string, number>();
  for (const [file, content] of Object.entries(layout)) {
    if (content === null) dirs.add(key(file));
    else files.set(key(file), content);
  }
  for (const [file, at] of Object.entries(options.modified ?? {})) times.set(key(file), at);
  const inUse = new Set((options.inUse ?? []).map(key));
  const unreadable = new Set((options.unreadable ?? []).map(key));
  const changes: string[] = [];

  const fail = (code: string, file: string): never => {
    throw Object.assign(new Error(`${code}: ${file}`), { code });
  };
  const isDirectory = (dir: string): boolean => {
    const k = key(dir);
    if (dirs.has(k)) return true;
    const inside = `${k}\\`;
    return [...files.keys(), ...dirs].some((f) => f.startsWith(inside));
  };
  const exists = (f: string): boolean => files.has(key(f)) || isDirectory(f);
  const needParent = (f: string): void => {
    if (!isDirectory(p.dirname(f))) fail('ENOENT', f);
  };
  const place = (from: string, to: string, refused: string | undefined, verb: string, at: number): void => {
    if (refused) fail(refused, to);
    const content = files.get(key(from));
    if (content === undefined) fail('ENOENT', from);
    if (exists(to)) fail('EEXIST', to);
    needParent(to);
    files.set(key(to), content as string);
    times.set(key(to), at);
    changes.push(`${verb} ${from} -> ${to}`);
  };

  return {
    exists,
    isFile: (f) => files.has(key(f)),
    isDirectory,
    isExecutable: (f) => files.has(key(f)),
    readStart: (f, bytes) => {
      const content = files.get(key(f));
      if (content === undefined || unreadable.has(key(f))) return null;
      return Buffer.from(content, 'latin1').subarray(0, bytes);
    },
    readText: (f) => (unreadable.has(key(f)) ? null : (files.get(key(f)) ?? null)),
    list: (dir) => {
      const inside = `${key(dir)}\\`;
      const names = new Set<string>();
      for (const f of [...files.keys(), ...dirs]) {
        const name = f.startsWith(inside) ? f.slice(inside.length).split('\\')[0] : undefined;
        if (name) names.add(name);
      }
      return [...names];
    },
    modifiedAt: (f) => (exists(f) ? (times.get(key(f)) ?? 0) : null),
    size: (f) => {
      const content = files.get(key(f));
      return content === undefined ? null : Buffer.byteLength(content, 'latin1');
    },
    // A link is the same file, so it changed when its source did.
    link: (from, to) => place(from, to, options.refuse?.link, 'link', times.get(key(from)) ?? 0),
    copyNew: (from, to) => place(from, to, options.refuse?.copy, 'copy', Date.now()),
    rename: (from, to) => {
      if (inUse.has(key(from))) fail('EBUSY', from);
      const content = files.get(key(from));
      if (content === undefined) fail('ENOENT', from);
      if (isDirectory(to)) fail('EPERM', to);
      if (inUse.has(key(to))) fail('EBUSY', to);
      needParent(to);
      const at = times.get(key(from)) ?? 0;
      files.delete(key(from));
      times.delete(key(from));
      files.set(key(to), content as string);
      times.set(key(to), at);
      changes.push(`rename ${from} -> ${to}`);
    },
    remove: (f) => {
      if (inUse.has(key(f))) fail('EBUSY', f);
      if (!files.delete(key(f))) fail('ENOENT', f);
      times.delete(key(f));
      changes.push(`remove ${f}`);
    },
    content: (f) => files.get(key(f)),
    put: (f, content, at = Date.now()) => {
      files.set(key(f), content);
      times.set(key(f), at);
    },
    changes,
  };
}
