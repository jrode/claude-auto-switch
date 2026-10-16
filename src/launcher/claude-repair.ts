import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { constants, copyFileSync, linkSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { acquireOwnedLock, type LockHandle } from '../claude/locks.js';
import { configHome } from '../config/paths.js';
import type { ClaudeInvoker } from '../invoker.js';
import { RealClaudeError } from '../util/errors.js';
import {
  cannotFindClaude,
  findRealClaude,
  inspectNpmInstall,
  isWindowsProgram,
  nodeClaudeFs,
  type BrokenNpmInstall,
  type ClaudeFs,
  type ClaudeSearch,
  type ResolveDeps,
} from './real-claude.js';

/**
 * Repairing a Claude Code npm install on Windows that has lost its program.
 *
 * The package ships `bin\claude.exe` as a placeholder script, and its
 * postinstall puts the real program over it from the platform package
 * (`@anthropic-ai/claude-code-win32-x64` or `-arm64`). An install can lose
 * that program and keep the placeholder, or nothing, under npm's shims; an
 * update that ran while Claude was open is the suspected cause (#138). Claude
 * then cannot start at all, so ccx repairs it before launching, and only then.
 */

/** The file changes a repair makes, on top of what the search reads. */
export interface RepairFs extends ClaudeFs {
  link(from: string, to: string): void;
  /** Copy, failing when `to` exists, so a repair never overwrites anything. */
  copyNew(from: string, to: string): void;
  rename(from: string, to: string): void;
  remove(file: string): void;
}

export const nodeRepairFs: RepairFs = {
  ...nodeClaudeFs,
  link: (from, to) => linkSync(from, to),
  copyNew: (from, to) => copyFileSync(from, to, constants.COPYFILE_EXCL),
  rename: (from, to) => renameSync(from, to),
  remove: (file) => unlinkSync(file),
};

/** How npm ended: its exit code, or why it never finished. */
export interface NpmRun {
  status: number | null;
  error?: string;
}

/** Runs npm's own script under a node. Injected in tests, which never run npm. */
export type NpmRunner = (node: string, args: string[]) => NpmRun;

export interface RepairDeps {
  fs?: RepairFs;
  /** One plain line for the person, on stderr by default. */
  say: (line: string) => void;
  arch?: string;
  runNpm?: NpmRunner;
  /** The node running ccx, used when the npm prefix has no node of its own. */
  execPath?: string;
}

export interface LaunchDeps extends Omit<ResolveDeps, 'fs'>, Partial<RepairDeps> {
  fs?: RepairFs;
  /** ccx's repair lock. A function, so a machine with no home folder fails only when a repair is due. */
  lockFile?: () => string;
  /** Takes the repair lock, waiting up to `waitMs` for another ccx that holds it. */
  lock?: (waitMs: number) => LockHandle;
  /** Shared by every resolve in one ccx run, so the repair is tried at most once. */
  run?: { repairTried: boolean };
}

export type RepairResult = { repaired: true } | { repaired: false; reason: string };

const PACKAGE = '@anthropic-ai/claude-code';
export const REPAIR_LOCK = 'claude-repair.lock';
const NPM_TIMEOUT_MS = 10 * 60_000;
/** Longer than npm may take, so a running repair is never taken over. */
const LOCK_MAX_HOLD_MS = 20 * 60_000;
const LOCK_WAIT_MS = 15 * 60_000;

const thisRun = { repairTried: false };

/**
 * The real claude for a launch. On Windows, when the only Claude to be had is
 * an npm install that has lost its program, the install is repaired first:
 * from its platform package when that is there, or by reinstalling it with
 * npm. A Claude that starts as it is, a configured `realClaudePath` included,
 * is launched untouched.
 */
export function resolveClaudeForLaunch(deps: LaunchDeps = {}): ClaudeInvoker {
  const configured = deps.config?.realClaudePath;
  if (configured) return { bin: configured, prefixArgs: [] };

  const platform = deps.platform ?? process.platform;
  const withFs = { ...deps, fs: deps.fs ?? nodeRepairFs };
  const search = findRealClaude(withFs);
  const usesBrokenInstall = search.bin === null || search.fromPlatformPackage;
  if (platform !== 'win32' || search.broken.length === 0 || !usesBrokenInstall) {
    return launchable(search, platform, []);
  }
  const failures = repairClaudeInstalls(withFs);
  return launchable(findRealClaude(withFs), platform, failures);
}

function launchable(search: ClaudeSearch, platform: NodeJS.Platform, failures: string[]): ClaudeInvoker {
  if (search.bin) return { bin: search.bin, prefixArgs: [] };
  throw new RealClaudeError(cannotFindClaude(search.candidates, platform, search.broken, failures));
}

/**
 * Repair every broken npm install the search finds, under ccx's repair lock,
 * at most once in a run. Returns why any of them could not be repaired.
 */
export function repairClaudeInstalls(deps: LaunchDeps): string[] {
  const run = deps.run ?? thisRun;
  if (run.repairTried) return ['ccx already tried to repair it once in this run'];
  run.repairTried = true;

  const fs = deps.fs ?? nodeRepairFs;
  const say = deps.say ?? ((line: string) => void process.stderr.write(`${line}\n`));
  let lockFile: string;
  try {
    lockFile = (deps.lockFile ?? (() => path.join(configHome({}), REPAIR_LOCK)))();
  } catch (err) {
    return [`ccx could not find its own folder for its repair lock (${(err as Error).message})`];
  }
  const lock = deps.lock ?? ((waitMs: number) => takeRepairLock(lockFile, waitMs, deps.platform));

  const notRepaired = (reason: string): string[] => {
    say(`ccx: did not repair Claude Code: ${reason}`);
    return [reason];
  };
  let handle = lock(0);
  if (!handle.held) {
    if (!fs.exists(lockFile)) return notRepaired(`ccx could not make its repair lock, ${lockFile}`);
    say('ccx: another ccx is repairing Claude Code; waiting for it to finish');
    handle = lock(LOCK_WAIT_MS);
    if (!handle.held) return notRepaired('another ccx was still repairing it; try again once it has finished');
  }
  try {
    // Looked at again under the lock: the ccx that held it may have repaired it.
    const failures: string[] = [];
    for (const install of findRealClaude({ ...deps, fs }).broken) {
      const repairDeps = { ...deps, fs, say };
      const result = install.platformProgram ? placeProgram(install, repairDeps) : reinstallWithNpm(install, repairDeps);
      if (!result.repaired) failures.push(result.reason);
    }
    return failures;
  } finally {
    handle.release();
  }
}

function takeRepairLock(lockFile: string, waitMs: number, platform?: NodeJS.Platform): LockHandle {
  try {
    mkdirSync(path.dirname(lockFile), { recursive: true });
  } catch {
    // acquireOwnedLock reports the lock as not held, which is the answer.
  }
  return acquireOwnedLock(lockFile, {
    waitMs,
    staleMs: 60_000,
    maxHoldMs: LOCK_MAX_HOLD_MS,
    ...(platform ? { platform } : {}),
  });
}

/**
 * Put the platform package's program in place as `bin\claude.exe`, the way
 * the package's own install.cjs does: a hardlink, else a copy. No network.
 *
 * Only a placeholder or an empty spot is ever replaced. The placeholder is
 * renamed aside first and put back if nothing could take its place, and a
 * rename Windows refuses means another process has the file open, so the
 * repair stops there without touching it.
 */
export function placeProgram(install: BrokenNpmInstall, deps: Pick<RepairDeps, 'fs' | 'say'>): RepairResult {
  const fs = deps.fs ?? nodeRepairFs;
  const from = install.platformProgram;
  const to = install.program;
  if (!from || isWindowsProgram(fs, from) !== true) {
    return { repaired: false, reason: `the platform package has no program to put in place for ${install.folder}` };
  }
  const isPlaceholder = (file: string): boolean => fs.isFile(file) && isWindowsProgram(fs, file) === false;
  const occupied = fs.exists(to);
  if (occupied && !isPlaceholder(to)) {
    return { repaired: false, reason: `${to} is no longer the placeholder, so ccx left it alone` };
  }

  const p = path.win32;
  deps.say(
    `ccx: Claude Code's npm install has lost its program; putting it back from ${p.basename(p.dirname(from))}`,
  );
  const failed = (reason: string): RepairResult => {
    deps.say(`ccx: could not put Claude Code's program back: ${reason}`);
    return { repaired: false, reason };
  };

  const aside = `${to}.placeholder-${process.pid}`;
  if (occupied) {
    try {
      fs.rename(to, aside);
    } catch (err) {
      return failed(`${to} is in use (${codeOf(err)}), so ccx left it alone`);
    }
    if (!isPlaceholder(aside)) {
      putBack(fs, aside, to);
      return failed(`${to} changed while ccx was repairing it, so ccx left it alone`);
    }
  }
  try {
    try {
      fs.link(from, to);
    } catch {
      fs.copyNew(from, to);
    }
  } catch (err) {
    if (occupied) putBack(fs, aside, to);
    return failed(`could not link or copy ${from} to ${to} (${codeOf(err)})`);
  }
  if (occupied) {
    try {
      fs.remove(aside);
    } catch {
      // A placeholder left beside the program does no harm.
    }
  }
  deps.say("ccx: put Claude Code's program back in place");
  return { repaired: true };
}

function putBack(fs: RepairFs, aside: string, to: string): void {
  try {
    fs.rename(aside, to);
  } catch {
    // It stays beside, under its own name; nothing is lost.
  }
}

/**
 * Reinstall the same Claude Code version with npm, into the prefix the broken
 * install is in, then put the program in place if npm left only the platform
 * package (as it does with install scripts turned off).
 */
export function reinstallWithNpm(install: BrokenNpmInstall, deps: RepairDeps): RepairResult {
  const fs = deps.fs ?? nodeRepairFs;
  const npm = npmFor(install.prefix, fs, deps.execPath ?? process.execPath);
  if (!npm) return { repaired: false, reason: `ccx found no npm for ${install.prefix}` };

  // --prefix names the folder that is broken, whichever npm runs, and whatever
  // prefix that npm's own settings name.
  const spec = install.version ? `${PACKAGE}@${install.version}` : PACKAGE;
  const args = ['install', '--global', '--prefix', install.prefix, spec];
  deps.say(
    `ccx: Claude Code's npm install has lost its program; reinstalling it, which can take a few minutes: npm ${args.join(' ')}`,
  );
  const run = (deps.runNpm ?? runNpm)(npm.node, [npm.cli, ...args]);
  if (run.error !== undefined || run.status !== 0) {
    const reason =
      run.error !== undefined
        ? `npm could not finish: ${run.error}`
        : run.status === null
          ? 'npm was stopped before it finished'
          : `npm stopped with exit code ${run.status}; its output is above`;
    deps.say(`ccx: could not reinstall Claude Code: ${reason}`);
    return { repaired: false, reason };
  }

  const after = inspectNpmInstall(install.folder, fs, deps.arch);
  if (after?.platformProgram) {
    deps.say('ccx: npm reinstalled Claude Code but did not put its program in place');
    return placeProgram(after, deps);
  }
  if (after) {
    const still =
      after.state === 'folder-missing'
        ? `${after.folder} is still not there`
        : after.state === 'missing'
          ? `${after.program} is still not there`
          : `${after.program} is still only the placeholder`;
    const reason = `npm finished, but ${still}`;
    deps.say(`ccx: ${reason}`);
    return { repaired: false, reason };
  }
  deps.say(`ccx: reinstalled Claude Code${install.version ? ` ${install.version}` : ''}`);
  return { repaired: true };
}

/**
 * The npm that belongs to the prefix: the one installed in it (as with
 * nvm-windows and the Node.js installer), else the one beside the node running
 * ccx. It is run as `node.exe npm-cli.js`, which is what `npm.cmd` runs, and
 * never as `npm.cmd` itself: Node 20.12 and later refuse to start a .cmd
 * without a shell (EINVAL), and a shell would have to quote every argument.
 */
export function npmFor(prefix: string, fs: ClaudeFs, execPath: string): { node: string; cli: string } | null {
  const p = path.win32;
  const own = p.join(prefix, 'node.exe');
  const node = fs.isFile(own) ? own : execPath;
  const cli = [prefix, p.dirname(node)]
    .map((dir) => p.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
    .find((file) => fs.isFile(file));
  return cli ? { node, cli } : null;
}

/** How a test stands in for spawnSync. */
export type SpawnNpm = (
  command: string,
  args: string[],
  options: SpawnSyncOptions,
) => { status: number | null; error?: Error };

/**
 * npm with its output on stderr, so what Claude writes to stdout (`claude -p`)
 * stays Claude's alone. No shell: the program is node.exe (see npmFor).
 */
export function runNpm(
  node: string,
  args: string[],
  spawn: SpawnNpm = (command, spawnArgs, options) => spawnSync(command, spawnArgs, options),
): NpmRun {
  const result = spawn(node, args, {
    stdio: ['ignore', 2, 2],
    timeout: NPM_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) {
    const timedOut = (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    return {
      status: result.status,
      error: timedOut
        ? `it took longer than ${NPM_TIMEOUT_MS / 60_000} minutes and was stopped`
        : `it could not be started (${result.error.message})`,
    };
  }
  return { status: result.status };
}

function codeOf(err: unknown): string {
  return (err as NodeJS.ErrnoException).code ?? (err as Error).message;
}
