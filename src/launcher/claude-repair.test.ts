import { describe, it, expect } from 'vitest';
import type { SpawnSyncOptions } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildContext, claudeForSession, getClaude, getClaudeAsIs } from '../context.js';
import {
  nodeRepairFs,
  npmFor,
  placeProgram,
  repairClaudeInstalls,
  resolveClaudeForLaunch,
  runNpm,
  stampOf,
  takeRepairLock,
  LOCK_MAX_HOLD_MS,
  LOCK_WAIT_MS,
  type FailedRepair,
  type LaunchDeps,
  type NpmRun,
  type RepairMemory,
  type SizeMemory,
  type SizeSeen,
} from './claude-repair.js';
import { inspectNpmInstall, type BrokenNpmInstall } from './real-claude.js';
import { RealClaudeError } from '../util/errors.js';
import type { LockHandle } from '../claude/locks.js';
import {
  memoryWindowsFs,
  NPM_CLI_JS_CMD_SHIM,
  NPM_CMD_SHIM,
  NPM_PLACEHOLDER,
  NPM_SH_SHIM,
  WINDOWS_PROGRAM,
  windowsProgram,
  type MemoryFs,
} from '../../test/memory-claude-fs.js';

const PREFIX = 'C:\\nvm4w\\nodejs';
const SHIM = `${PREFIX}\\claude`;
const CMD = `${PREFIX}\\claude.cmd`;
const PKG = `${PREFIX}\\node_modules\\@anthropic-ai\\claude-code`;
const PKG_JSON = `${PKG}\\package.json`;
const PACKAGE_JSON = '{"name":"@anthropic-ai/claude-code","version":"2.1.302","bin":{"claude":"bin/claude.exe"}}';
const OLD_PACKAGE_JSON = '{"name":"@anthropic-ai/claude-code","version":"2.1.110","bin":{"claude":"cli.js"}}';
const BIN = `${PKG}\\bin\\claude.exe`;
const BIN_DIR = `${PKG}\\bin`;
const NESTED = `${PKG}\\node_modules\\@anthropic-ai\\claude-code-win32-x64\\claude.exe`;
const NODE = `${PREFIX}\\node.exe`;
const NPM_CLI = `${PREFIX}\\node_modules\\npm\\bin\\npm-cli.js`;
const NATIVE = 'C:\\Users\\me\\.local\\bin\\claude.exe';
const LOCK = 'C:\\Users\\me\\.claude-auto-switch\\claude-repair.lock';

/** npm's shims, and an install whose bin\claude.exe is the placeholder. */
function placeholderInstall(extra: Record<string, string | null> = {}): Record<string, string | null> {
  return {
    [SHIM]: '',
    [CMD]: NPM_CMD_SHIM,
    [PKG_JSON]: PACKAGE_JSON,
    [BIN]: NPM_PLACEHOLDER,
    [NODE]: WINDOWS_PROGRAM,
    [NPM_CLI]: '',
    ...extra,
  };
}

/** npm's shims, and an install with an empty bin folder. */
function missingInstall(extra: Record<string, string | null> = {}): Record<string, string | null> {
  return {
    [SHIM]: '',
    [CMD]: NPM_CMD_SHIM,
    [PKG_JSON]: PACKAGE_JSON,
    [BIN_DIR]: null,
    [NODE]: WINDOWS_PROGRAM,
    [NPM_CLI]: '',
    ...extra,
  };
}

interface Harness {
  deps: LaunchDeps;
  said: string[];
  npmCalls: Array<{ node: string; args: string[] }>;
  locks: number[];
  memory: RepairMemory & { all: Map<string, FailedRepair> };
}

/** Failed repairs kept in memory, as the file in ccx's folder keeps them. */
function memoryOfRepairs(): RepairMemory & { all: Map<string, FailedRepair> } {
  const all = new Map<string, FailedRepair>();
  return {
    all,
    get: (folder) => all.get(folder.toLowerCase()) ?? null,
    set: (folder, failed) => {
      if (failed) all.set(folder.toLowerCase(), failed);
      else all.delete(folder.toLowerCase());
    },
  };
}

/** Sizes of cut-short platform programs, kept in memory as the file in ccx's folder keeps them. */
function sizesSeen(): SizeMemory {
  const all = new Map<string, SizeSeen>();
  return {
    get: (file) => all.get(file.toLowerCase()) ?? null,
    set: (file, seen) => {
      if (seen) all.set(file.toLowerCase(), seen);
      else all.delete(file.toLowerCase());
    },
  };
}

/**
 * Everything the repair talks to, on a Windows disk in memory. npm is a stand-in
 * that never runs: `npm` decides what it leaves on the disk and how it exits.
 */
function harness(
  fs: MemoryFs,
  options: {
    npm?: (fs: MemoryFs, args: string[]) => NpmRun;
    lock?: (waitMs: number) => LockHandle;
    candidates?: string[];
  } = {},
): Harness {
  const memory = memoryOfRepairs();
  const said: string[] = [];
  const npmCalls: Harness['npmCalls'] = [];
  const locks: number[] = [];
  const held: LockHandle = { held: true, release: () => {} };
  const deps: LaunchDeps = {
    platform: 'win32',
    arch: 'x64',
    fs,
    findCandidates: () => options.candidates ?? [SHIM, CMD],
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    lockFile: () => LOCK,
    lock: (waitMs) => {
      locks.push(waitMs);
      return options.lock ? options.lock(waitMs) : held;
    },
    runNpm: (node, args) => {
      npmCalls.push({ node, args });
      if (!options.npm) throw new Error('npm must not run here');
      return options.npm(fs, args);
    },
    say: (line) => said.push(line),
    memory,
    sizes: sizesSeen(),
    run: { repairTried: false },
  };
  return { deps, said, npmCalls, locks, memory };
}

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(RealClaudeError);
    return (err as Error).message;
  }
  throw new Error('expected claude to stay unlaunchable');
}

function brokenAt(fs: MemoryFs): BrokenNpmInstall {
  const install = inspectNpmInstall(PKG, fs, 'x64');
  if (!install) throw new Error('expected a broken install');
  return install;
}

describe('repairing an npm install from its platform package (no network)', () => {
  it('puts the real program in place with a hardlink, as install.cjs does, and launches it', () => {
    const fs = memoryWindowsFs(placeholderInstall({ [NESTED]: WINDOWS_PROGRAM }));
    const h = harness(fs);
    expect(resolveClaudeForLaunch(h.deps).bin).toBe(BIN);
    expect(fs.content(BIN)).toBe(WINDOWS_PROGRAM);
    expect(fs.changes.some((c) => c.startsWith(`link ${NESTED} -> ${BIN}`))).toBe(true);
    expect(h.npmCalls).toEqual([]);
    expect(h.said).toHaveLength(2);
    expect(h.said[1]).toContain('put');
  });

  it('removes the placeholder it moved aside once the program is in place', () => {
    const fs = memoryWindowsFs(placeholderInstall({ [NESTED]: WINDOWS_PROGRAM }));
    resolveClaudeForLaunch(harness(fs).deps);
    const aside = fs.changes.find((c) => c.startsWith(`rename ${BIN} -> `))?.split(' -> ')[1];
    expect(aside).toBeDefined();
    expect(fs.content(aside as string)).toBeUndefined();
  });

  it('fills in a bin\\claude.exe that is not there at all', () => {
    const fs = memoryWindowsFs(missingInstall({ [NESTED]: WINDOWS_PROGRAM }));
    expect(resolveClaudeForLaunch(harness(fs).deps).bin).toBe(BIN);
    expect(fs.content(BIN)).toBe(WINDOWS_PROGRAM);
  });

  it('copies the program when a hardlink is refused', () => {
    const fs = memoryWindowsFs(placeholderInstall({ [NESTED]: WINDOWS_PROGRAM }), { refuse: { link: 'EPERM' } });
    expect(resolveClaudeForLaunch(harness(fs).deps).bin).toBe(BIN);
    expect(fs.changes.some((c) => c.startsWith(`copy ${NESTED} -> ${BIN}`))).toBe(true);
  });

  it('never overwrites a file that is a real program', () => {
    const fs = memoryWindowsFs(placeholderInstall({ [NESTED]: WINDOWS_PROGRAM }));
    const install = brokenAt(fs);
    // Another process puts a program there between the check and the repair.
    fs.put(BIN, 'MZ, a newer program');
    const result = placeProgram(install, { fs, say: () => {} });
    expect(result.repaired).toBe(false);
    expect(fs.content(BIN)).toBe('MZ, a newer program');
    expect(fs.changes).toEqual([]);
  });

  it('puts back, untouched, a program that lands in bin\\claude.exe while it repairs', () => {
    const fs = memoryWindowsFs(placeholderInstall({ [NESTED]: WINDOWS_PROGRAM }));
    const rename = fs.rename;
    let landed = false;
    fs.rename = (from, to) => {
      if (!landed) {
        landed = true;
        fs.put(BIN, 'MZ, what npm just put there');
      }
      rename(from, to);
    };
    const result = placeProgram(brokenAt(fs), { fs, say: () => {} });
    expect(result.repaired).toBe(false);
    expect(fs.content(BIN)).toBe('MZ, what npm just put there');
    expect(fs.changes.some((c) => c.startsWith(`link ${NESTED}`) || c.startsWith(`copy ${NESTED}`))).toBe(false);
  });

  it('keeps a real program that lands in bin\\claude.exe after the placeholder was moved aside', () => {
    // Claude's own setup finishing at that moment. A rename on Windows replaces
    // its target, so putting the placeholder back by renaming it would undo that.
    const fs = memoryWindowsFs(placeholderInstall({ [NESTED]: WINDOWS_PROGRAM }));
    const link = fs.link;
    fs.link = (from, to) => {
      if (from === NESTED) fs.put(BIN, "MZ, what Claude's setup put there");
      link(from, to);
    };
    const result = placeProgram(brokenAt(fs), { fs, say: () => {} });
    expect(result.repaired).toBe(false);
    expect(fs.content(BIN)).toBe("MZ, what Claude's setup put there");
    const aside = fs.changes.find((c) => c.startsWith(`rename ${BIN} -> `))?.split(' -> ')[1];
    expect(aside).toBeDefined();
    expect(fs.content(aside as string)).toBeUndefined();
  });

  it('leaves bin\\claude.exe alone when it is in use, and launches from the platform package', () => {
    const fs = memoryWindowsFs(placeholderInstall({ [NESTED]: WINDOWS_PROGRAM }), { inUse: [BIN] });
    const h = harness(fs);
    expect(resolveClaudeForLaunch(h.deps).bin).toBe(NESTED);
    expect(fs.content(BIN)).toBe(NPM_PLACEHOLDER);
    expect(fs.changes).toEqual([]);
    // Claude starts anyway, so the launch keeps quiet about the repair it could not make.
    expect(h.said).toEqual([]);
    const said: string[] = [];
    expect(placeProgram(brokenAt(fs), { fs, say: (line) => said.push(line) })).toMatchObject({ repaired: false });
    expect(said.at(-1)).toContain('in use');
  });

  it('never puts in place a platform program shorter than its own headers say', () => {
    const fs = memoryWindowsFs(placeholderInstall({ [NESTED]: WINDOWS_PROGRAM }));
    const install = brokenAt(fs);
    fs.put(NESTED, windowsProgram(4096, 2048), 0);
    expect(placeProgram(install, { fs, say: () => {} }).repaired).toBe(false);
    expect(fs.content(BIN)).toBe(NPM_PLACEHOLDER);
  });

  it('puts the placeholder back when neither a link nor a copy can be made', () => {
    const fs = memoryWindowsFs(placeholderInstall({ [NESTED]: WINDOWS_PROGRAM }), {
      refuse: { link: 'EPERM', copy: 'EACCES' },
    });
    const h = harness(fs);
    expect(resolveClaudeForLaunch(h.deps).bin).toBe(NESTED);
    expect(fs.content(BIN)).toBe(NPM_PLACEHOLDER);
  });

  it('does not take a platform program that stopped being one', () => {
    const fs = memoryWindowsFs(placeholderInstall({ [NESTED]: WINDOWS_PROGRAM }));
    const install = brokenAt(fs);
    fs.put(NESTED, 'half a download');
    expect(placeProgram(install, { fs, say: () => {} }).repaired).toBe(false);
    expect(fs.content(BIN)).toBe(NPM_PLACEHOLDER);
  });
});

describe('repairing an npm install by reinstalling it with npm', () => {
  const reinstalled = (fs: MemoryFs): NpmRun => {
    fs.put(BIN, WINDOWS_PROGRAM);
    return { status: 0 };
  };

  it("reinstalls the same version with the npm that belongs to the shims' folder, then launches", () => {
    const fs = memoryWindowsFs(missingInstall());
    const h = harness(fs, { npm: reinstalled });
    expect(resolveClaudeForLaunch(h.deps).bin).toBe(BIN);
    expect(h.npmCalls).toEqual([
      {
        node: NODE,
        args: [NPM_CLI, 'install', '--global', '--prefix', PREFIX, '@anthropic-ai/claude-code@2.1.302'],
      },
    ]);
    expect(h.said).toHaveLength(2);
    expect(h.said[0]).toContain('npm install --global --prefix');
    expect(h.said[0]).toContain('@anthropic-ai/claude-code@2.1.302');
    expect(h.said[1]).toContain('reinstalled');
  });

  it('uses the npm beside the node running ccx when the folder has none of its own', () => {
    const appData = 'C:\\Users\\me\\AppData\\Roaming\\npm';
    const pkg = `${appData}\\node_modules\\@anthropic-ai\\claude-code`;
    const bin = `${pkg}\\bin\\claude.exe`;
    const nodeDir = 'C:\\Program Files\\nodejs';
    const fs = memoryWindowsFs({
      [`${appData}\\claude.cmd`]: NPM_CMD_SHIM,
      [`${pkg}\\package.json`]: PACKAGE_JSON,
      [bin]: NPM_PLACEHOLDER,
      [`${nodeDir}\\node.exe`]: WINDOWS_PROGRAM,
      [`${nodeDir}\\node_modules\\npm\\bin\\npm-cli.js`]: '',
    });
    const h = harness(fs, {
      candidates: [`${appData}\\claude.cmd`],
      npm: (f) => {
        f.put(bin, WINDOWS_PROGRAM);
        return { status: 0 };
      },
    });
    expect(resolveClaudeForLaunch(h.deps).bin).toBe(bin);
    expect(h.npmCalls[0]?.node).toBe(`${nodeDir}\\node.exe`);
    expect(h.npmCalls[0]?.args.slice(0, 5)).toEqual([
      `${nodeDir}\\node_modules\\npm\\bin\\npm-cli.js`,
      'install',
      '--global',
      '--prefix',
      appData,
    ]);
  });

  it('installs the latest when the version cannot be read', () => {
    const fs = memoryWindowsFs(missingInstall({ [PKG_JSON]: '{"bin":{"claude":"bin/claude.exe"}}' }));
    const h = harness(fs, { npm: reinstalled });
    resolveClaudeForLaunch(h.deps);
    expect(h.npmCalls[0]?.args.at(-1)).toBe('@anthropic-ai/claude-code');
  });

  it('puts the program in place itself when npm leaves the platform package but not the program', () => {
    // As npm does when install scripts are turned off.
    const fs = memoryWindowsFs(missingInstall());
    const h = harness(fs, {
      npm: (f) => {
        f.put(BIN, NPM_PLACEHOLDER);
        f.put(NESTED, WINDOWS_PROGRAM);
        return { status: 0 };
      },
    });
    expect(resolveClaudeForLaunch(h.deps).bin).toBe(BIN);
    expect(fs.content(BIN)).toBe(WINDOWS_PROGRAM);
  });

  it("says npm failed, then gives the manual steps, when npm cannot reinstall it", () => {
    const fs = memoryWindowsFs(missingInstall());
    const h = harness(fs, { npm: () => ({ status: 1 }) });
    const message = messageOf(() => resolveClaudeForLaunch(h.deps));
    expect(message).toContain('ccx tried to repair it and could not');
    expect(message).toContain('npm stopped with exit code 1');
    expect(message).toContain('close every Claude window');
    expect(message).toContain('npm i -g @anthropic-ai/claude-code');
    expect(message).toContain('native build');
    expect(h.said.at(-1)).toContain('could not');
  });

  it('says so when npm cannot be started at all', () => {
    const fs = memoryWindowsFs(missingInstall());
    const h = harness(fs, { npm: () => ({ status: null, error: 'spawn EACCES' }) });
    expect(messageOf(() => resolveClaudeForLaunch(h.deps))).toContain('spawn EACCES');
  });

  it('says so when npm finishes and the program is still not there', () => {
    // As npm does when optional packages are turned off: no platform package.
    const fs = memoryWindowsFs(missingInstall());
    const h = harness(fs, {
      npm: (f) => {
        f.put(BIN, NPM_PLACEHOLDER);
        return { status: 0 };
      },
    });
    expect(messageOf(() => resolveClaudeForLaunch(h.deps))).toContain('still only the placeholder');
  });

  it('reinstalls a package folder that is gone, at the version npm left in the folder it moved aside', () => {
    const retired = `${PREFIX}\\node_modules\\@anthropic-ai\\.claude-code-Ab3dE9xQ\\package.json`;
    const fs = memoryWindowsFs({
      [SHIM]: NPM_SH_SHIM,
      [CMD]: NPM_CMD_SHIM,
      [retired]: '{"name":"@anthropic-ai/claude-code","version":"2.1.300"}',
      [NODE]: WINDOWS_PROGRAM,
      [NPM_CLI]: '',
    });
    const h = harness(fs, { npm: reinstalled });
    expect(resolveClaudeForLaunch(h.deps).bin).toBe(BIN);
    expect(h.npmCalls).toEqual([
      {
        node: NODE,
        args: [NPM_CLI, 'install', '--global', '--prefix', PREFIX, '@anthropic-ai/claude-code@2.1.300'],
      },
    ]);
  });

  it('installs the current release when the folder is gone and left no package.json', () => {
    const fs = memoryWindowsFs({ [SHIM]: NPM_SH_SHIM, [CMD]: NPM_CMD_SHIM, [NODE]: WINDOWS_PROGRAM, [NPM_CLI]: '' });
    const h = harness(fs, { npm: reinstalled });
    expect(resolveClaudeForLaunch(h.deps).bin).toBe(BIN);
    expect(h.npmCalls[0]?.args.at(-1)).toBe('@anthropic-ai/claude-code');
  });

  it('says so when npm finishes and the folder is still not there', () => {
    const fs = memoryWindowsFs({ [CMD]: NPM_CMD_SHIM, [NODE]: WINDOWS_PROGRAM, [NPM_CLI]: '' });
    const h = harness(fs, { candidates: [CMD], npm: () => ({ status: 0 }) });
    expect(messageOf(() => resolveClaudeForLaunch(h.deps))).toContain(`${PKG} is still not there`);
  });

  it('never reinstalls for shims that point somewhere other than their own node_modules', () => {
    const fs = memoryWindowsFs({
      [CMD]: '"D:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n',
      [SHIM]: 'exec "$basedir/tools/claude.exe" "$@"\n',
      [NODE]: WINDOWS_PROGRAM,
      [NPM_CLI]: '',
    });
    const h = harness(fs);
    expect(() => resolveClaudeForLaunch(h.deps)).toThrow(RealClaudeError);
    expect(h.npmCalls).toEqual([]);
    expect(h.locks).toEqual([]);
  });

  it('gives the manual steps when no npm can be found for the folder', () => {
    const fs = memoryWindowsFs(missingInstall({ [NPM_CLI]: null, [NODE]: null }));
    const h = harness(fs);
    expect(messageOf(() => resolveClaudeForLaunch(h.deps))).toContain('found no npm');
    expect(h.npmCalls).toEqual([]);
  });
});

describe('how the repair starts npm', () => {
  it('runs the node it is given on npm-cli.js, with no shell and its output on stderr', () => {
    // npm on Windows is npm.cmd, which Node 20.12 and later refuse to start
    // without a shell. Starting node.exe on npm's own script needs none.
    const calls: Array<{ command: string; args: string[]; options: SpawnSyncOptions }> = [];
    const run = runNpm(NODE, [NPM_CLI, 'install'], (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0 };
    });
    expect(run).toEqual({ status: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe(NODE);
    expect(calls[0]?.args).toEqual([NPM_CLI, 'install']);
    expect(calls[0]?.options.shell).toBeUndefined();
    expect(calls[0]?.options.stdio).toEqual(['ignore', 2, 2]);
  });

  it('reports a timeout as npm taking too long', () => {
    const timedOut = Object.assign(new Error('spawnSync node.exe ETIMEDOUT'), { code: 'ETIMEDOUT' });
    const run = runNpm(NODE, [NPM_CLI], () => ({ status: null, error: timedOut }));
    expect(run.error).toContain('took longer than');
  });

  // The real thing, where it matters: on Windows, npm started exactly as a
  // repair starts it answers, so the repair is not refused before npm runs.
  it.skipIf(process.platform !== 'win32')('starts the real npm on Windows the way a repair does', () => {
    const npm = npmFor(path.dirname(process.execPath), nodeRepairFs, process.execPath);
    expect(npm).not.toBeNull();
    if (!npm) return;
    expect(npm.node.toLowerCase().endsWith('node.exe')).toBe(true);
    expect(runNpm(npm.node, [npm.cli, '--version'])).toEqual({ status: 0 });
  });
});

describe('when the repair is allowed to run', () => {
  it('never on a healthy install', () => {
    const fs = memoryWindowsFs(placeholderInstall({ [BIN]: WINDOWS_PROGRAM }));
    const h = harness(fs);
    expect(resolveClaudeForLaunch(h.deps).bin).toBe(BIN);
    expect(h.locks).toEqual([]);
    expect(fs.changes).toEqual([]);
    expect(h.said).toEqual([]);
  });

  it('never when another Claude is the one being launched', () => {
    const fs = memoryWindowsFs(missingInstall({ [NATIVE]: WINDOWS_PROGRAM }));
    const h = harness(fs, { candidates: [NATIVE, SHIM, CMD] });
    expect(resolveClaudeForLaunch(h.deps).bin).toBe(NATIVE);
    expect(h.locks).toEqual([]);
    expect(h.npmCalls).toEqual([]);
  });

  it('never when realClaudePath is set', () => {
    const fs = memoryWindowsFs(missingInstall());
    const h = harness(fs);
    const claude = resolveClaudeForLaunch({ ...h.deps, config: { realClaudePath: 'D:\\claude.exe' } });
    expect(claude.bin).toBe('D:\\claude.exe');
    expect(h.locks).toEqual([]);
  });

  it('never when CAS_REAL_CLAUDE_PATH names claude, through getClaude as through doctor', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-repair-'));
    const env = { CLAUDE_AUTO_SWITCH_HOME: home, CAS_REAL_CLAUDE_PATH: 'D:\\claude\\claude.exe' };
    const context = buildContext({ ctx: { env, platform: 'win32' } });
    expect(getClaude(context).bin).toBe('D:\\claude\\claude.exe');
    expect(getClaudeAsIs(context).bin).toBe('D:\\claude\\claude.exe');
    const h = harness(memoryWindowsFs(missingInstall()));
    expect(resolveClaudeForLaunch({ ...h.deps, config: context.config }).bin).toBe('D:\\claude\\claude.exe');
    expect(h.locks).toEqual([]);
  });

  it('never off Windows, where the first candidate is taken as it is', () => {
    // The same broken layout: only the search's platform gate keeps it out.
    const fs = memoryWindowsFs(missingInstall());
    const h = harness(fs);
    expect(resolveClaudeForLaunch({ ...h.deps, platform: 'linux' }).bin).toBe(SHIM);
    expect(h.locks).toEqual([]);
    expect(h.npmCalls).toEqual([]);
  });

  it('at most once in one ccx run', () => {
    const fs = memoryWindowsFs(missingInstall());
    const h = harness(fs, { npm: () => ({ status: 1 }) });
    messageOf(() => resolveClaudeForLaunch(h.deps));
    const second = messageOf(() => resolveClaudeForLaunch(h.deps));
    expect(h.npmCalls).toHaveLength(1);
    expect(second).toContain('already tried');
  });

  it('waits for another ccx that is repairing, and leaves alone what it fixed', () => {
    const fs = memoryWindowsFs(missingInstall({ [LOCK]: '4242' }));
    const h = harness(fs, {
      lock: (waitMs) => {
        if (waitMs === 0) return { held: false, release: () => {} };
        fs.put(BIN, WINDOWS_PROGRAM); // the other ccx finished its repair
        return { held: true, release: () => {} };
      },
    });
    expect(resolveClaudeForLaunch(h.deps).bin).toBe(BIN);
    expect(h.locks[0]).toBe(0);
    expect(h.locks[1]).toBeGreaterThan(0);
    expect(h.said[0]).toContain('another ccx is repairing');
    expect(h.npmCalls).toEqual([]);
  });

  it('does not repair while another ccx still holds the lock', () => {
    const fs = memoryWindowsFs(missingInstall({ [LOCK]: '4242' }));
    const h = harness(fs, { lock: () => ({ held: false, release: () => {} }) });
    expect(messageOf(() => resolveClaudeForLaunch(h.deps))).toContain('another ccx');
    expect(h.npmCalls).toEqual([]);
  });

  it('does not repair when its lock cannot be made', () => {
    const fs = memoryWindowsFs(missingInstall());
    const h = harness(fs, { lock: () => ({ held: false, release: () => {} }) });
    expect(messageOf(() => resolveClaudeForLaunch(h.deps))).toContain(LOCK);
    // Tried twice, since a lock released in between looks the same at first.
    expect(h.locks).toEqual([0, 0]);
    expect(h.npmCalls).toEqual([]);
  });

  it('takes the lock when it was released between the first try and the look', () => {
    const fs = memoryWindowsFs(missingInstall());
    let tries = 0;
    const h = harness(fs, {
      lock: () => ({ held: ++tries > 1, release: () => {} }),
      npm: (f) => {
        f.put(BIN, WINDOWS_PROGRAM);
        return { status: 0 };
      },
    });
    expect(resolveClaudeForLaunch(h.deps).bin).toBe(BIN);
    expect(h.locks).toEqual([0, 0]);
  });

  it('takes over a lock older than any repair, whatever pid it names', () => {
    // Windows reuses the pid of a ccx that was killed, so a live pid proves
    // nothing; the age does. The clock runs fast; the lock file is real.
    const dir = mkdtempSync(path.join(tmpdir(), 'cas-repair-lock-'));
    const lockFile = path.join(dir, 'claude-repair.lock');
    writeFileSync(lockFile, '4242');
    const start = Date.now();
    let ticks = 0;
    const handle = takeRepairLock(lockFile, LOCK_WAIT_MS, undefined, {
      now: () => start + ticks++ * 10_000,
      isRunning: () => true,
    });
    expect(handle.held).toBe(true);
    handle.release();
    expect(LOCK_WAIT_MS).toBeGreaterThan(LOCK_MAX_HOLD_MS);
  });

  it('releases the lock however the repair ends', () => {
    let released = 0;
    const fs = memoryWindowsFs(missingInstall());
    const h = harness(fs, {
      lock: () => ({ held: true, release: () => (released += 1) }),
      npm: () => {
        throw new Error('npm blew up');
      },
    });
    expect(() => resolveClaudeForLaunch(h.deps)).toThrow('npm blew up');
    expect(released).toBe(1);
  });

  it('repairs every broken install it finds when asked directly, as doctor --fix does', () => {
    const fs = memoryWindowsFs(missingInstall({ [NATIVE]: WINDOWS_PROGRAM, [NESTED]: WINDOWS_PROGRAM }));
    const h = harness(fs, { candidates: [NATIVE, SHIM, CMD] });
    expect(repairClaudeInstalls(h.deps)).toEqual([]);
    expect(fs.content(BIN)).toBe(WINDOWS_PROGRAM);
  });

  // A second npm prefix on PATH, with its own broken install, npm and node.
  const SECOND = 'C:\\Users\\me\\AppData\\Roaming\\npm';
  const secondInstall = {
    [`${SECOND}\\claude.cmd`]: NPM_CMD_SHIM,
    [`${SECOND}\\node_modules\\@anthropic-ai\\claude-code\\package.json`]: PACKAGE_JSON,
    [`${SECOND}\\node_modules\\@anthropic-ai\\claude-code\\bin`]: null,
    [`${SECOND}\\node.exe`]: WINDOWS_PROGRAM,
    [`${SECOND}\\node_modules\\npm\\bin\\npm-cli.js`]: '',
  };
  /** npm putting the program back into whichever prefix it was given. */
  const reinstallsPrefix = (fs: MemoryFs, args: string[]): NpmRun => {
    fs.put(`${args[4]}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`, WINDOWS_PROGRAM);
    return { status: 0 };
  };

  it('at a launch, only the install about to be started', () => {
    const fs = memoryWindowsFs(missingInstall(secondInstall));
    const h = harness(fs, { candidates: [SHIM, CMD, `${SECOND}\\claude.cmd`], npm: reinstallsPrefix });
    expect(resolveClaudeForLaunch(h.deps).bin).toBe(BIN);
    expect(h.npmCalls.map((call) => call.args[4])).toEqual([PREFIX]);
  });

  it('with doctor --fix, every install it finds', () => {
    const fs = memoryWindowsFs(missingInstall(secondInstall));
    const h = harness(fs, { candidates: [SHIM, CMD, `${SECOND}\\claude.cmd`], npm: reinstallsPrefix });
    expect(repairClaudeInstalls(h.deps, { force: true })).toEqual([]);
    expect(h.npmCalls.map((call) => call.args[4])).toEqual([PREFIX, SECOND]);
  });

  it('never on an older install that runs cli.js, which has no bin\\claude.exe to lose', () => {
    const fs = memoryWindowsFs({
      [SHIM]: '',
      [CMD]: NPM_CLI_JS_CMD_SHIM,
      [PKG_JSON]: OLD_PACKAGE_JSON,
      [`${PKG}\\cli.js`]: '#!/usr/bin/env node\n',
      [NODE]: WINDOWS_PROGRAM,
      [NPM_CLI]: '',
    });
    const h = harness(fs);
    expect(resolveClaudeForLaunch(h.deps)).toEqual({ bin: NODE, prefixArgs: [`${PKG}\\cli.js`] });
    expect(h.npmCalls).toEqual([]);
    expect(h.locks).toEqual([]);
  });

  it('not again, after it failed, until the install changes', () => {
    const fs = memoryWindowsFs(missingInstall());
    const h = harness(fs, { npm: () => ({ status: 1 }) });
    messageOf(() => resolveClaudeForLaunch(h.deps));
    expect(h.memory.all.size).toBe(1);

    // The next ccx run: the same install, so npm is not run again for it.
    const next = messageOf(() => resolveClaudeForLaunch({ ...h.deps, run: { repairTried: false } }));
    expect(next).toContain('ccx tried on');
    expect(next).toContain('ccx doctor --fix');
    expect(h.npmCalls).toHaveLength(1);

    // Reinstalled by hand since, and settled: tried again.
    fs.put(PKG_JSON, PACKAGE_JSON, Date.now() - 10 * 60_000);
    messageOf(() => resolveClaudeForLaunch({ ...h.deps, run: { repairTried: false } }));
    expect(h.npmCalls).toHaveLength(2);
  });

  it('again with doctor --fix, even after it failed', () => {
    const fs = memoryWindowsFs(missingInstall());
    const h = harness(fs, { npm: () => ({ status: 1 }) });
    messageOf(() => resolveClaudeForLaunch(h.deps));
    repairClaudeInstalls({ ...h.deps, run: { repairTried: false } }, { force: true });
    expect(h.npmCalls).toHaveLength(2);
  });

  it('forgets a failure once a repair works', () => {
    const fs = memoryWindowsFs(missingInstall());
    let first = true;
    const h = harness(fs, {
      npm: (f) => {
        if (first) {
          first = false;
          return { status: 1 };
        }
        f.put(BIN, WINDOWS_PROGRAM);
        return { status: 0 };
      },
    });
    messageOf(() => resolveClaudeForLaunch(h.deps));
    repairClaudeInstalls({ ...h.deps, run: { repairTried: false } }, { force: true });
    expect(h.memory.all.size).toBe(0);
  });

  it('never while npm may still be writing the install, and says how long it holds off', () => {
    const now = Date.parse('2026-10-16T22:00:00Z');
    const fs = memoryWindowsFs(missingInstall(), {
      modified: { [`${PREFIX}\\node_modules\\@anthropic-ai`]: now - 60_000 },
    });
    const h = harness(fs);
    const message = messageOf(() => resolveClaudeForLaunch({ ...h.deps, now: () => now }));
    expect(message).toContain('npm may still be installing it');
    expect(message).toContain('about 2 minutes more');
    expect(fs.changes).toEqual([]);
    expect(h.npmCalls).toEqual([]);
  });

  it('starts Claude at once from a whole platform program while the rest settles, and says nothing of the repair it holds off', () => {
    // Right after `npm i -g` with install scripts off: everything is new and
    // the platform program is whole, but nothing has put it in place.
    const now = Date.parse('2026-10-16T22:00:00Z');
    const fs = memoryWindowsFs(placeholderInstall({ [NESTED]: WINDOWS_PROGRAM }), {
      modified: { [`${PREFIX}\\node_modules\\@anthropic-ai`]: now - 10_000, [BIN]: now - 10_000, [NESTED]: now - 40_000 },
    });
    const h = harness(fs);
    expect(resolveClaudeForLaunch({ ...h.deps, now: () => now }).bin).toBe(NESTED);
    expect(h.said).toEqual([]);
    expect(fs.changes).toEqual([]);
  });

  it('with doctor --fix even while npm may still be writing the install, after saying so', () => {
    const now = Date.parse('2026-10-16T22:00:00Z');
    const fs = memoryWindowsFs(placeholderInstall({ [NESTED]: WINDOWS_PROGRAM }), {
      modified: { [`${PREFIX}\\node_modules\\@anthropic-ai`]: now - 60_000, [NESTED]: now - 60_000 },
    });
    const h = harness(fs);
    expect(repairClaudeInstalls({ ...h.deps, now: () => now }, { force: true })).toEqual([]);
    expect(fs.content(BIN)).toBe(WINDOWS_PROGRAM);
    expect(h.said.some((line) => line.includes('putting its program in place anyway'))).toBe(true);
  });

  it('never starts npm while npm may still be writing the install, with doctor --fix or without', () => {
    // A second npm on the same folder would work against the one still running.
    const now = Date.parse('2026-10-16T22:00:00Z');
    const fs = memoryWindowsFs(missingInstall(), {
      modified: { [`${PREFIX}\\node_modules\\@anthropic-ai`]: now - 60_000 },
    });
    const h = harness(fs);
    const failures = repairClaudeInstalls({ ...h.deps, now: () => now }, { force: true });
    expect(h.npmCalls).toEqual([]);
    expect(failures.join('\n')).toContain('run ccx doctor --fix again then');
  });

  it('never starts npm over a platform program still being downloaded, however old its times', () => {
    // Windows may not move a change time while npm writes, so only the size
    // shows the download going on: once it holds still long enough, npm left it.
    const start = Date.parse('2026-10-16T22:00:00Z');
    const fs = memoryWindowsFs(missingInstall({ [NESTED]: windowsProgram(4096, 2048) }));
    const h = harness(fs, {
      npm: (f) => {
        f.put(BIN, WINDOWS_PROGRAM);
        return { status: 0 };
      },
    });
    const at = (ms: number): LaunchDeps => ({ ...h.deps, now: () => ms, run: { repairTried: false } });
    messageOf(() => resolveClaudeForLaunch(at(start)));
    fs.put(NESTED, windowsProgram(4096, 3072), 0); // it grew
    messageOf(() => resolveClaudeForLaunch(at(start + 9 * 60_000)));
    messageOf(() => resolveClaudeForLaunch(at(start + 18 * 60_000)));
    expect(h.npmCalls).toEqual([]);
    // The same size for ten minutes and more: a dead npm's leftover, repaired.
    expect(resolveClaudeForLaunch(at(start + 20 * 60_000)).bin).toBe(BIN);
    expect(h.npmCalls).toHaveLength(1);
  });

  it('does not make a launch that starts from the platform program wait for another ccx's repair', () => {
    const fs = memoryWindowsFs(placeholderInstall({ [NESTED]: WINDOWS_PROGRAM, [LOCK]: String(process.pid + 1) }));
    const h = harness(fs, { lock: () => ({ held: false, release: () => {} }) });
    expect(resolveClaudeForLaunch(h.deps).bin).toBe(NESTED);
    expect(h.locks).toEqual([0]);
    expect(h.said).toEqual([]);
  });

  it('by itself again an hour after a repair failed, though the install is as it was', () => {
    // No network, the registry or npm's timeout: trying again later can work.
    const start = Date.parse('2026-10-16T22:00:00Z');
    const fs = memoryWindowsFs(missingInstall());
    const h = harness(fs, { npm: () => ({ status: 1 }) });
    const at = (ms: number): LaunchDeps => ({ ...h.deps, now: () => ms, run: { repairTried: false } });
    messageOf(() => resolveClaudeForLaunch(at(start)));
    messageOf(() => resolveClaudeForLaunch(at(start + 30 * 60_000)));
    expect(h.npmCalls).toHaveLength(1);
    messageOf(() => resolveClaudeForLaunch(at(start + 61 * 60_000)));
    expect(h.npmCalls).toHaveLength(2);
  });

  it('says nothing at a launch that starts from the platform package about a repair that failed before', () => {
    // Doctor reports it; saying it on every launch of a Claude that starts is noise.
    const fs = memoryWindowsFs(placeholderInstall({ [NESTED]: WINDOWS_PROGRAM }));
    const h = harness(fs);
    const failed = { stamp: stampOf(brokenAt(fs), fs), version: '2.1.302', at: new Date().toISOString(), reason: 'it was in use' };
    h.memory.set(PKG, failed);
    expect(resolveClaudeForLaunch(h.deps).bin).toBe(NESTED);
    expect(h.said).toEqual([]);
  });

  it('never in a worker, which stops at once, naming ccx doctor --fix', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-repair-worker-'));
    const context = buildContext({ ctx: { env: { CLAUDE_AUTO_SWITCH_HOME: home }, platform: 'win32' } });
    const h = harness(memoryWindowsFs(missingInstall()));
    context.claudeSearch = h.deps;
    let message = '';
    try {
      claudeForSession(context, true);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('ccx doctor --fix');
    expect(h.npmCalls).toEqual([]);
    expect(h.locks).toEqual([]);
  });

  it('in a session that is not a worker', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-repair-session-'));
    const context = buildContext({ ctx: { env: { CLAUDE_AUTO_SWITCH_HOME: home }, platform: 'win32' } });
    const h = harness(memoryWindowsFs(missingInstall()), {
      npm: (f) => {
        f.put(BIN, WINDOWS_PROGRAM);
        return { status: 0 };
      },
    });
    context.claudeSearch = h.deps;
    expect(claudeForSession(context, false).bin).toBe(BIN);
    expect(h.npmCalls).toHaveLength(1);
  });
});
