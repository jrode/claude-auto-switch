import path from 'node:path';
import type { RepairFs } from '../src/launcher/claude-repair.js';

/** How a Windows program starts, which is what the resolver reads to tell one. */
export const WINDOWS_PROGRAM = 'MZ, a Windows program';

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

export interface MemoryFsOptions {
  /** Files another process has open, which Windows will not let anyone rename or remove. */
  inUse?: string[];
  /** Files that exist but cannot be opened. */
  unreadable?: string[];
  /** Make link or copy fail with this error code. */
  refuse?: { link?: string; copy?: string };
}

export interface MemoryFs extends RepairFs {
  /** A file's content, or undefined when there is none. */
  content(file: string): string | undefined;
  /** Put a file in place, as another process (npm, another ccx) would. */
  put(file: string, content: string): void;
  /** Every change made through this file system, in order. */
  changes: string[];
}

/**
 * A Windows disk in memory, for laying out an npm install on any host.
 * `layout` maps a path to its content, or to null for an empty folder.
 * Paths compare the way Windows compares them, without regard to case.
 */
export function memoryWindowsFs(layout: Record<string, string | null>, options: MemoryFsOptions = {}): MemoryFs {
  const p = path.win32;
  const key = (f: string): string => p.normalize(f).toLowerCase();
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  for (const [file, content] of Object.entries(layout)) {
    if (content === null) dirs.add(key(file));
    else files.set(key(file), content);
  }
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
  const place = (from: string, to: string, refused: string | undefined, verb: string): void => {
    if (refused) fail(refused, to);
    const content = files.get(key(from));
    if (content === undefined) fail('ENOENT', from);
    if (exists(to)) fail('EEXIST', to);
    needParent(to);
    files.set(key(to), content as string);
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
    link: (from, to) => place(from, to, options.refuse?.link, 'link'),
    copyNew: (from, to) => place(from, to, options.refuse?.copy, 'copy'),
    rename: (from, to) => {
      if (inUse.has(key(from))) fail('EBUSY', from);
      const content = files.get(key(from));
      if (content === undefined) fail('ENOENT', from);
      if (exists(to)) fail('EEXIST', to);
      needParent(to);
      files.delete(key(from));
      files.set(key(to), content as string);
      changes.push(`rename ${from} -> ${to}`);
    },
    remove: (f) => {
      if (inUse.has(key(f))) fail('EBUSY', f);
      if (!files.delete(key(f))) fail('ENOENT', f);
      changes.push(`remove ${f}`);
    },
    content: (f) => files.get(key(f)),
    put: (f, content) => {
      files.set(key(f), content);
    },
    changes,
  };
}
