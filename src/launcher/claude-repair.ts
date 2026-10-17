import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { constants, copyFileSync, linkSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { acquireOwnedLock, type LockHandle, type OwnedLockOptions } from '../claude/locks.js';
import { configHome } from '../config/paths.js';
import type { ClaudeInvoker } from '../invoker.js';
import { RealClaudeError } from '../util/errors.js';
import { writeJsonFile } from '../util/fs-json.js';
import {
  aboutTime,
  cannotFindClaude,
  CLOCK_AHEAD_MS,
  findRealClaude,
  SETTLED_MS,
  inspectNpmInstall,
  isCutShortWindowsProgram,
  isWholeWindowsProgram,
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
  /** Where a repair that failed is written down, so the next run does not repeat it. */
  memoryFile?: () => string;
  memory?: RepairMemory;
  /** Where the size of a platform program seen cut short is written down, to tell a download from a leftover. */
  sizesFile?: () => string;
  sizes?: SizeMemory;
  /** Shared by every resolve in one ccx run, so the repair is tried at most once. */
  run?: { repairTried: boolean };
}

export type RepairResult = { repaired: true } | { repaired: false; reason: string };

/** A repair that did not work, and what the install looked like after it. */
export interface FailedRepair {
  stamp: string;
  version: string | null;
  at: string;
  reason: string;
}

export interface RepairMemory {
  get(folder: string): FailedRepair | null;
  set(folder: string, failed: FailedRepair | null): void;
}

/** A platform program's size when first seen at that size. */
export interface SizeSeen {
  size: number;
  at: string;
}

export interface SizeMemory {
  get(file: string): SizeSeen | null;
  set(file: string, seen: SizeSeen | null): void;
}

/**
 * How long a platform program cut short of its headers must stay one size
 * before ccx takes it for a dead npm's leftover and reinstalls. Twice npm's
 * own fetch timeout (fetch-timeout, five minutes by default): an npm still
 * waiting on a slow registry has given up by then, and a download that has
 * not moved for that long is not going to finish.
 */
export const STALLED_MS = 10 * 60_000;

export interface RepairOptions {
  /** Repair only this install folder: the one a launch is about to start. */
  only?: string;
  /**
   * Repair what an earlier repair failed on, and what npm may still be
   * writing, as `ccx doctor --fix` asks.
   */
  force?: boolean;
  /**
   * Claude starts anyway (from the platform package): say what is done, not
   * why something is not. Doctor reports those.
   */
  quiet?: boolean;
}

/**
 * How long a failed repair holds off the next automatic one while the install
 * stays as it was. A failure that cannot be fixed by trying again (npm leaving
 * no program) then costs one npm run an hour of use, where a passing one (no
 * network, the registry, npm's own timeout) clears within the hour, without
 * waiting for anyone to run ccx doctor --fix.
 */
export const FAILED_REPAIR_HOLD_MS = 60 * 60_000;

/** Whether a failed repair still holds off the next one, by the time it was written. */
function stillHolds(failed: FailedRepair, now: number): boolean {
  const age = now - Date.parse(failed.at);
  return age >= -CLOCK_AHEAD_MS && age < FAILED_REPAIR_HOLD_MS;
}

const PACKAGE = '@anthropic-ai/claude-code';
export const REPAIR_LOCK = 'claude-repair.lock';
export const REPAIR_MEMORY = 'claude-repair.json';
export const REPAIR_SIZES = 'claude-repair-sizes.json';
const NPM_TIMEOUT_MS = 10 * 60_000;
/**
 * The longest one hold of the lock can last: it covers one install's repair,
 * which is at most one npm run and then placing the program. A lock older than
 * that is abandoned whatever pid it names, since Windows reuses the pid of a
 * ccx that was killed.
 */
export const LOCK_MAX_HOLD_MS = NPM_TIMEOUT_MS + 60_000;
/** Long enough for a running repair to finish, or for its abandoned lock to be taken over. */
export const LOCK_WAIT_MS = LOCK_MAX_HOLD_MS + 30_000;

const thisRun = { repairTried: false };

/**
 * The real claude for a launch. On Windows, when the only Claude to be had is
 * an npm install that has lost its program, that install is repaired first:
 * from its platform package when that is there, or by reinstalling it with
 * npm. A Claude that starts as it is, a configured `realClaudePath` included,
 * is launched untouched.
 */
export function resolveClaudeForLaunch(deps: LaunchDeps = {}): ClaudeInvoker {
  const configured = deps.config?.realClaudePath;
  if (configured) return { bin: configured, prefixArgs: [] };

  const platform = deps.platform ?? process.platform;
  const withFs = { ...deps, fs: deps.fs ?? nodeRepairFs };
  // Off Windows the search finds nothing broken, so nothing is repaired there.
  const search = findRealClaude(withFs);
  const target = search.fromPlatformPackage
    ? search.broken.find((install) => install.platformProgram === search.bin)
    : search.bin === null
      ? search.broken[0]
      : undefined;
  if (!target) return launchable(search, platform, []);
  const failures = repairClaudeInstalls(withFs, { only: target.folder, quiet: search.fromPlatformPackage });
  return launchable(findRealClaude(withFs), platform, failures);
}

function launchable(search: ClaudeSearch, platform: NodeJS.Platform, failures: string[]): ClaudeInvoker {
  if (search.bin) return { bin: search.bin, prefixArgs: search.prefixArgs };
  throw new RealClaudeError(cannotFindClaude(search.candidates, platform, search.broken, failures));
}

/**
 * Repair the broken npm installs the search finds (or only the one named),
 * each under ccx's repair lock, at most once in a run. Returns why any of them
 * could not be repaired.
 */
export function repairClaudeInstalls(deps: LaunchDeps, options: RepairOptions = {}): string[] {
  const run = deps.run ?? thisRun;
  if (run.repairTried) return ['ccx already tried to repair it once in this run'];
  run.repairTried = true;

  const fs = deps.fs ?? nodeRepairFs;
  const say = deps.say ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const notRepaired = (reason: string): string[] => {
    if (!options.quiet) say(`ccx: did not repair Claude Code: ${reason}`);
    return [reason];
  };
  let lockFile: string;
  let memory: RepairMemory;
  let sizes: SizeMemory;
  try {
    lockFile = (deps.lockFile ?? (() => path.join(configHome({}), REPAIR_LOCK)))();
    memory = deps.memory ?? fileRepairMemory((deps.memoryFile ?? (() => path.join(configHome({}), REPAIR_MEMORY)))());
    sizes = deps.sizes ?? fileSizeMemory((deps.sizesFile ?? (() => path.join(configHome({}), REPAIR_SIZES)))());
  } catch (err) {
    return [`ccx could not find its own folder for its repair lock (${(err as Error).message})`];
  }
  const lock = deps.lock ?? ((waitMs: number) => takeRepairLock(lockFile, waitMs, deps.platform));
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

  const failures: string[] = [];
  const folders = findRealClaude({ ...deps, fs })
    .broken.filter((install) => options.only === undefined || same(install.folder, options.only))
    .map((install) => install.folder);
  for (const folder of folders) {
    // One hold per install, so no hold outlasts LOCK_MAX_HOLD_MS.
    let handle = lock(0);
    // No lock file and no lock: it may have been released in between, so try once more.
    if (!handle.held && !fs.exists(lockFile)) handle = lock(0);
    if (!handle.held) {
      if (!fs.exists(lockFile)) return [...failures, ...notRepaired(`ccx could not make its repair lock, ${lockFile}`)];
      // Claude starts from the platform program anyway, and the repair is the
      // other ccx's: no reason to make this launch wait for it.
      if (options.quiet) return failures;
      say('ccx: another ccx is repairing Claude Code; waiting for it to finish');
      handle = lock(LOCK_WAIT_MS);
      if (!handle.held) {
        return [...failures, ...notRepaired('another ccx was still repairing it; try again once it has finished')];
      }
    }
    try {
      // Looked at again under the lock: the ccx that held it may have repaired it.
      const install = findRealClaude({ ...deps, fs }).broken.find((found) => same(found.folder, folder));
      if (install) failures.push(...repairOne(install, { ...deps, fs, say }, memory, sizes, options));
    } finally {
      handle.release();
    }
  }
  return failures;
}

function repairOne(
  install: BrokenNpmInstall,
  deps: LaunchDeps & RepairDeps,
  memory: RepairMemory,
  sizes: SizeMemory,
  options: RepairOptions,
): string[] {
  const fs = deps.fs ?? nodeRepairFs;
  const force = options.force === true;
  const notRepaired = (reason: string): string[] => {
    if (!options.quiet) deps.say(`ccx: did not repair Claude Code: ${reason}`);
    return [reason];
  };
  // Asked first: what a failed repair of ccx's own left behind is recent too,
  // and is not npm at work.
  const remembered = memory.get(install.folder);
  if (!force && remembered && stillHolds(remembered, (deps.now ?? Date.now)()) && remembered.stamp === stampOf(install, fs)) {
    return notRepaired(
      `ccx tried on ${remembered.at} and could not (${remembered.reason}); it tries again once the install changes or an hour has passed, or when you run ccx doctor --fix`,
    );
  }
  const now = (deps.now ?? Date.now)();
  const busyWhy = `${install.folder} changed moments ago, so npm may still be installing it`;
  if (install.busy) {
    // A whole platform program can be put in place beside a running npm, as
    // its own setup step does; a second npm on the same folder cannot run
    // beside it, so nothing starts one while the install may be busy.
    if (!(force && install.platformProgram)) {
      return notRepaired(
        `${busyWhy}; ccx leaves it alone until nothing in it has changed for ${SETTLED_MS / 60_000} minutes, ` +
          `${aboutTime(install.settlesInMs ?? 0)} more. Start Claude or run ccx doctor --fix again then`,
      );
    }
  }
  // A program shorter than its headers say is one npm is still downloading, or
  // install.cjs still copying, or one left when either died. Windows may not
  // move a change time while a handle writes, so the file's own size is what
  // shows whether it still grows: nothing is replaced, and no npm is started,
  // until each such file has stayed one size for STALLED_MS. Every file's size
  // is written down on the same pass, so two such files wait once, not twice.
  if (install.platformProgram) sizes.set(install.platformProgram, null); // whole now: nothing to watch
  const watched = [
    ...(install.state === 'cut-short' ? [install.program] : []),
    ...(install.partialProgram && !install.platformProgram ? [install.partialProgram.file] : []),
  ];
  const waiting: string[] = [];
  for (const file of watched) {
    const size = fs.size(file) ?? -1;
    const seen = sizes.get(file);
    const since = seen ? Date.parse(seen.at) : Number.NaN;
    if (!seen || seen.size !== size || Number.isNaN(since) || now - since < -CLOCK_AHEAD_MS) {
      sizes.set(file, { size, at: new Date(now).toISOString() });
      waiting.push(
        `${file} is shorter than its own headers say (${size} bytes), so it may still be being written. ` +
          `ccx repairs it only once it has stayed that size for ${STALLED_MS / 60_000} minutes`,
      );
    } else if (now - since < STALLED_MS) {
      waiting.push(
        `${file} has stayed at ${size} bytes for ${aboutTime(Math.max(0, now - since))}; ccx repairs it once ` +
          `that reaches ${STALLED_MS / 60_000} minutes, ${aboutTime(STALLED_MS - Math.max(0, now - since))} more`,
      );
    }
    // Otherwise it stopped growing long ago, so what is there was left by a writer that died.
  }
  if (waiting.length > 0) return notRepaired(waiting.join('; '));
  // Said only once the repair is really going ahead.
  if (install.busy) deps.say(`ccx: ${busyWhy}; putting its program in place anyway, as ccx doctor --fix asks`);
  // When Claude starts anyway, what the repair says is kept back unless it worked.
  const heldBack: string[] = [];
  const repairDeps = options.quiet ? { ...deps, say: (line: string) => void heldBack.push(line) } : deps;
  const result = install.platformProgram ? placeProgram(install, repairDeps) : reinstallWithNpm(install, repairDeps);
  if (result.repaired) heldBack.forEach((line) => deps.say(line));
  // ccx's own changes are finished, so nothing here is still being written.
  const after = inspectNpmInstall(install.folder, fs, deps.arch, { settledMs: 0 });
  if (result.repaired || after === null) {
    memory.set(install.folder, null);
    for (const file of watched) sizes.set(file, null);
    return [];
  }
  memory.set(install.folder, {
    stamp: stampOf(after, fs),
    version: install.version,
    at: new Date((deps.now ?? Date.now)()).toISOString(),
    reason: result.reason,
  });
  return [result.reason];
}

/** What an install looked like, to tell whether it has changed since a repair failed on it. */
export function stampOf(install: BrokenNpmInstall, fs: ClaudeFs): string {
  const p = path.win32;
  const at = (file: string): string => String(fs.modifiedAt(file) ?? '-');
  return [
    install.state,
    install.version ?? '-',
    at(install.folder),
    at(install.program),
    at(p.join(install.folder, 'package.json')),
    at(p.join(install.prefix, 'claude.cmd')),
  ].join('|');
}

/** Failed repairs, kept in a JSON file in ccx's folder, one per install folder. */
export function fileRepairMemory(file: string): RepairMemory {
  return jsonRecords<FailedRepair>(
    file,
    (entry): entry is FailedRepair =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as FailedRepair).stamp === 'string' &&
      typeof (entry as FailedRepair).reason === 'string',
  );
}

/** Sizes of platform programs seen cut short, kept in a JSON file in ccx's folder, one per file. */
export function fileSizeMemory(file: string, now: () => number = Date.now): SizeMemory {
  return jsonRecords<SizeSeen>(
    file,
    (entry): entry is SizeSeen =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as SizeSeen).size === 'number' &&
      typeof (entry as SizeSeen).at === 'string',
    // A size is needed for STALLED_MS; one a day old is for a file long since
    // repaired or gone, and is dropped when the next is written.
    (entry) => !(now() - Date.parse(entry.at) < SIZE_RECORD_MS),
  );
}

const SIZE_RECORD_MS = 24 * 60 * 60_000;

/** Records in a JSON file, one per path, compared the way Windows compares paths. */
function jsonRecords<T>(
  file: string,
  isEntry: (entry: unknown) => entry is T,
  isStale: (entry: T) => boolean = () => false,
): { get(key: string): T | null; set(key: string, value: T | null): void } {
  const read = (): Record<string, unknown> => {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      return data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  return {
    get: (key) => {
      const entry = read()[key.toLowerCase()];
      return isEntry(entry) ? entry : null;
    },
    set: (key, value) => {
      const all = read();
      const name = key.toLowerCase();
      if (!value && !(name in all)) return;
      if (value) all[name] = value;
      else delete all[name];
      for (const [other, entry] of Object.entries(all)) {
        if (other !== name && isEntry(entry) && isStale(entry)) delete all[other];
      }
      try {
        writeJsonFile(file, all);
      } catch {
        // Only a courtesy: without it the next run judges afresh.
      }
    },
  };
}

export function takeRepairLock(
  lockFile: string,
  waitMs: number,
  platform?: NodeJS.Platform,
  clock: Pick<OwnedLockOptions, 'now' | 'isRunning'> = {},
): LockHandle {
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
    ...clock,
  });
}

/**
 * Put the platform package's program in place as `bin\claude.exe`, the way
 * the package's own install.cjs does: a hardlink, else a copy. No network.
 *
 * Only a placeholder, a copy cut short of its own headers, or an empty spot is
 * ever replaced, never a whole program. What is there is renamed aside first
 * and put back if nothing could take its place, and a rename Windows refuses
 * means another process has the file open, so the repair stops there without
 * touching it.
 */
export function placeProgram(install: BrokenNpmInstall, deps: Pick<RepairDeps, 'fs' | 'say'>): RepairResult {
  const fs = deps.fs ?? nodeRepairFs;
  const from = install.platformProgram;
  const to = install.program;
  if (!from || isWindowsProgram(fs, from) !== true || !isWholeWindowsProgram(fs, from)) {
    return { repaired: false, reason: `the platform package has no whole program to put in place for ${install.folder}` };
  }
  const isPlaceholder = (file: string): boolean =>
    fs.isFile(file) && (isWindowsProgram(fs, file) === false || isCutShortWindowsProgram(fs, file));
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

/**
 * Put the placeholder back where it was, unless something took its place
 * meanwhile, such as Claude's own setup finishing. A link never replaces a
 * file, where a rename on Windows does, so it goes first; a real program that
 * arrived is kept and the placeholder beside it removed.
 */
function putBack(fs: RepairFs, aside: string, to: string): void {
  const keepWhatArrived = (): void => {
    if (isWindowsProgram(fs, to) !== true) return; // left beside, under its own name
    try {
      fs.remove(aside);
    } catch {
      // A placeholder beside the program does no harm.
    }
  };
  try {
    fs.link(aside, to);
  } catch (err) {
    if (codeOf(err) === 'EEXIST' || fs.exists(to)) return keepWhatArrived();
    try {
      fs.rename(aside, to);
    } catch {
      // It stays beside, under its own name; nothing is lost.
    }
    return;
  }
  try {
    fs.remove(aside);
  } catch {
    // Both names hold the placeholder, which does no harm.
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

  // npm has exited, so what it wrote is finished, however recent.
  const after = inspectNpmInstall(install.folder, fs, deps.arch, { settledMs: 0 });
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
          : after.state === 'cut-short'
            ? `${after.program} is still cut short`
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
