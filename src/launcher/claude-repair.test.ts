import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildContext, getClaude, getClaudeAsIs } from '../context.js';
import {
  placeProgram,
  repairClaudeInstalls,
  resolveClaudeForLaunch,
  type LaunchDeps,
  type NpmRun,
} from './claude-repair.js';
import { inspectNpmInstall, type BrokenNpmInstall } from './real-claude.js';
import { RealClaudeError } from '../util/errors.js';
import type { LockHandle } from '../claude/locks.js';
import {
  memoryWindowsFs,
  NPM_CMD_SHIM,
  NPM_PLACEHOLDER,
  WINDOWS_PROGRAM,
  type MemoryFs,
} from '../../test/memory-claude-fs.js';

const PREFIX = 'C:\\nvm4w\\nodejs';
const SHIM = `${PREFIX}\\claude`;
const CMD = `${PREFIX}\\claude.cmd`;
const PKG = `${PREFIX}\\node_modules\\@anthropic-ai\\claude-code`;
const PKG_JSON = `${PKG}\\package.json`;
const PACKAGE_JSON = '{"name":"@anthropic-ai/claude-code","version":"2.1.302"}';
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
}

/**
 * Everything the repair talks to, on a Windows disk in memory. npm is a stand-in
 * that never runs: `npm` decides what it leaves on the disk and how it exits.
 */
function harness(
  fs: MemoryFs,
  options: {
    npm?: (fs: MemoryFs) => NpmRun;
    lock?: (waitMs: number) => LockHandle;
    candidates?: string[];
  } = {},
): Harness {
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
      return options.npm(fs);
    },
    say: (line) => said.push(line),
    run: { repairTried: false },
  };
  return { deps, said, npmCalls, locks };
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
    expect(fs.changes.some((c) => c.startsWith('link') || c.startsWith('copy'))).toBe(false);
  });

  it('leaves bin\\claude.exe alone when it is in use, and launches from the platform package', () => {
    const fs = memoryWindowsFs(placeholderInstall({ [NESTED]: WINDOWS_PROGRAM }), { inUse: [BIN] });
    const h = harness(fs);
    expect(resolveClaudeForLaunch(h.deps).bin).toBe(NESTED);
    expect(fs.content(BIN)).toBe(NPM_PLACEHOLDER);
    expect(fs.changes).toEqual([]);
    expect(h.said.at(-1)).toContain('in use');
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
    const fs = memoryWindowsFs(missingInstall({ [PKG_JSON]: 'not json' }));
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

  it('gives the manual steps when no npm can be found for the folder', () => {
    const fs = memoryWindowsFs(missingInstall({ [NPM_CLI]: null, [NODE]: null }));
    const h = harness(fs);
    expect(messageOf(() => resolveClaudeForLaunch(h.deps))).toContain('found no npm');
    expect(h.npmCalls).toEqual([]);
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

  it('never off Windows', () => {
    const fs = memoryWindowsFs(missingInstall());
    const h = harness(fs, { candidates: [] });
    expect(() => resolveClaudeForLaunch({ ...h.deps, platform: 'linux' })).toThrow(RealClaudeError);
    expect(h.locks).toEqual([]);
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
    expect(h.locks).toEqual([0]);
    expect(h.npmCalls).toEqual([]);
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
});
