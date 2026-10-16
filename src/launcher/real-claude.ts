import { execFileSync } from 'node:child_process';
import {
  accessSync,
  closeSync,
  constants,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import type { ClaudeInvoker } from '../invoker.js';
import { RealClaudeError } from '../util/errors.js';

/** The file reads the search makes, so a test can lay out any install on any host. */
export interface ClaudeFs {
  exists(file: string): boolean;
  /** A regular file, not a folder. */
  isFile(file: string): boolean;
  isDirectory(dir: string): boolean;
  /** POSIX: may this process run it. */
  isExecutable(file: string): boolean;
  /** Up to `bytes` from the start of the file, or null when it cannot be read. */
  readStart(file: string, bytes: number): Uint8Array | null;
  readText(file: string): string | null;
  /** The names in a folder, none when it cannot be read. */
  list(dir: string): string[];
  /** When a file or folder last changed, in milliseconds, or null when it is not there. */
  modifiedAt(file: string): number | null;
}

export const nodeClaudeFs: ClaudeFs = {
  exists: (file) => {
    try {
      lstatSync(file);
      return true;
    } catch {
      return false;
    }
  },
  isFile: (file) => {
    try {
      return statSync(file).isFile();
    } catch {
      return false;
    }
  },
  isDirectory: (dir) => {
    try {
      return statSync(dir).isDirectory();
    } catch {
      return false;
    }
  },
  isExecutable: (file) => {
    try {
      accessSync(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  readStart: (file, bytes) => {
    let fd: number | undefined;
    try {
      fd = openSync(file, 'r');
      const buffer = Buffer.alloc(bytes);
      return buffer.subarray(0, readSync(fd, buffer, 0, bytes, 0));
    } catch {
      return null;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  },
  readText: (file) => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  },
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  modifiedAt: (file) => {
    try {
      return statSync(file).mtimeMs;
    } catch {
      return null;
    }
  },
};

export interface ResolveDeps {
  config?: { realClaudePath?: string | null };
  /** Returns candidate absolute paths for `claude` (like `where`/`which -a`). */
  findCandidates?: () => string[];
  /**
   * Just the PATH lookup, so a test can simulate a machine where PATH knows
   * nothing while still exercising the real search of known locations. Without
   * this seam the only way to test discovery is to replace all of it, which
   * leaves a test that passes whether the discovery exists or not.
   */
  onPath?: () => string[];
  /** Predicate marking a candidate as our own shim, to be skipped. */
  isShim?: (candidate: string) => boolean;
  platform?: NodeJS.Platform;
  fs?: ClaudeFs;
  /** The processor, as `process.arch` names it, which picks Claude Code's platform package. */
  arch?: string;
  /** The node running ccx, which runs an older Claude Code (its cli.js) when the prefix has no node.exe. */
  execPath?: string;
  /** The clock, which tells an install npm is still writing from one it has left. */
  now?: () => number;
}

/**
 * A Claude Code npm install whose `bin\claude.exe` is not the program: it is
 * not there, it is still the placeholder the package ships, or the whole
 * package folder is gone while npm's shims still point into it.
 */
export interface BrokenNpmInstall {
  /** `<prefix>\node_modules\@anthropic-ai\claude-code` */
  folder: string;
  /** The npm prefix, where npm put the `claude` and `claude.cmd` shims. */
  prefix: string;
  /** `<folder>\bin\claude.exe`, which the shims run. */
  program: string;
  state: 'missing' | 'placeholder' | 'folder-missing';
  /** The platform package's own program, when npm left a real one and is not still writing it. */
  platformProgram: string | null;
  /** From its package.json, or the one npm left in the folder it moved aside; null when neither names one. */
  version: string | null;
  /** Changed in the last few minutes, so npm may still be installing it: nothing is taken from it or done to it. */
  busy: boolean;
}

export interface ClaudeSearch {
  /** What to launch, or null when nothing can be. */
  bin: string | null;
  /** What goes before Claude's own arguments: an older Claude Code's cli.js, run by node. */
  prefixArgs: string[];
  /** The platform package's program, taken because the install's own is missing. */
  fromPlatformPackage: boolean;
  /** Every candidate looked at, our own shim left out. */
  candidates: string[];
  broken: BrokenNpmInstall[];
}

/**
 * Resolve the REAL claude launcher to an absolute path and return it as an
 * invoker. On Windows this resolves to the actual `.exe` (not the `.cmd` shim,
 * which node-pty cannot launch). Invoking by absolute path (never the bare name)
 * is what stops the transparent shim from calling itself. An explicit
 * `config.realClaudePath` always wins.
 */
export function resolveRealClaude(deps: ResolveDeps = {}): ClaudeInvoker {
  const configured = deps.config?.realClaudePath;
  if (configured) return { bin: configured, prefixArgs: [] };

  const search = findRealClaude(deps);
  if (!search.bin) {
    throw new RealClaudeError(
      cannotFindClaude(search.candidates, deps.platform ?? process.platform, search.broken),
    );
  }
  return { bin: search.bin, prefixArgs: search.prefixArgs };
}

/** Look for claude, ignoring `realClaudePath`, and say what was found broken on the way. */
export function findRealClaude(deps: ResolveDeps = {}): ClaudeSearch {
  const platform = deps.platform ?? process.platform;
  const fs = deps.fs ?? nodeClaudeFs;
  const findCandidates =
    deps.findCandidates ?? (() => defaultFindCandidates(platform, deps.onPath, fs));
  const isShim = deps.isShim ?? defaultIsShim;

  const candidates = findCandidates().filter((candidate) => !isShim(candidate));
  if (platform !== 'win32') {
    return { bin: candidates[0] ?? null, prefixArgs: [], fromPlatformPackage: false, candidates, broken: [] };
  }
  const broken = brokenNpmInstalls(candidates, fs, deps.arch ?? process.arch, (deps.now ?? Date.now)());
  const picked = pickOnWindows(candidates, fs, deps.execPath ?? process.execPath);
  if (picked) return { ...picked, fromPlatformPackage: false, candidates, broken };
  const fallback = broken.find((install) => install.platformProgram !== null)?.platformProgram ?? null;
  return { bin: fallback, prefixArgs: [], fromPlatformPackage: fallback !== null, candidates, broken };
}

/**
 * Say what was actually looked for, and what to do about it.
 *
 * The old message named a config key and stopped there, which reads as "you
 * have not installed Claude" to someone who plainly has. The two real causes
 * are a PATH this process never inherited and an install somewhere unusual,
 * and both are acted on differently. A third, on Windows, is an npm install
 * that has lost its program, and that one has a fix of its own.
 */
export function cannotFindClaude(
  candidates: string[],
  platform: NodeJS.Platform,
  broken: BrokenNpmInstall[] = [],
  repairFailures: string[] = [],
): string {
  if (broken.length > 0) return brokenInstallMessage(broken, repairFailures);
  const looked = whereItIsUsuallyInstalled(platform);
  const found = candidates.length > 0;
  const lines = [
    found
      ? `found claude at ${candidates.join(', ')}, but none of them can be launched directly` +
        (platform === 'win32' ? ' (Windows needs the real .exe, not a .cmd shim)' : '')
      : 'could not find the claude binary, on PATH or where it is normally installed',
    '',
    'looked on PATH, and in:',
    ...looked.map((p) => `  ${p}`),
    '',
    'if it is somewhere else, point ccx straight at it, once:',
    '  set realClaudePath in ~/.claude-auto-switch/config.json',
    '  or set CAS_REAL_CLAUDE_PATH in the environment',
  ];
  return lines.join('\n');
}

/** One line per install: where it is and what is wrong with its program. */
export function describeBrokenInstall(install: BrokenNpmInstall): string {
  if (install.state === 'missing') return `${install.folder}: its bin\\claude.exe is not there`;
  if (install.state === 'placeholder') {
    return `${install.folder}: its bin\\claude.exe is only the placeholder npm puts there first, a short script rather than the program`;
  }
  return `${install.folder}: the folder is not there, though npm's claude shims in ${install.prefix} still point into it`;
}

function brokenInstallMessage(broken: BrokenNpmInstall[], repairFailures: string[]): string {
  return [
    "Claude Code's npm install is missing its program, so Claude cannot start:",
    ...broken.map((install) => `  ${describeBrokenInstall(install)}`),
    'This usually happens when an update ran while Claude was open.',
    ...(broken.some((install) => install.busy)
      ? ['It changed in the last few minutes, so npm may still be installing it; try again once that has finished.']
      : []),
    ...(repairFailures.length > 0
      ? ['', 'ccx tried to repair it and could not:', ...repairFailures.map((reason) => `  ${reason}`)]
      : []),
    '',
    'to fix it, close every Claude window, then either:',
    '  run: npm i -g @anthropic-ai/claude-code',
    '  or install the native build, in PowerShell: irm https://claude.ai/install.ps1 | iex',
    '  or have ccx repair it: ccx doctor --fix',
    '',
    'if Claude is installed somewhere else, point ccx straight at it:',
    '  set realClaudePath in ~/.claude-auto-switch/config.json, or CAS_REAL_CLAUDE_PATH',
  ].join('\n');
}

/**
 * Choose the launchable binary on Windows: a real `.exe` (node-pty and
 * CreateProcess cannot run a `.cmd`/`.ps1`/shell shim), deriving it from the
 * `.cmd` shim when needed. An older Claude Code, whose package runs `cli.js`,
 * is started as node running that script, as its `.cmd` does.
 */
function pickOnWindows(
  candidates: string[],
  fs: ClaudeFs,
  execPath: string,
): { bin: string; prefixArgs: string[] } | undefined {
  const p = path.win32;
  const directExe = candidates.find((c) => /\.exe$/i.test(c) && isWindowsProgram(fs, c) !== false);
  if (directExe) return { bin: directExe, prefixArgs: [] };

  // Prefer the standard npm install layout (a real file) BEFORE trusting text
  // scraped from a .cmd shim.
  for (const candidate of candidates) {
    const guess = p.join(p.dirname(candidate), ...NPM_PACKAGE, 'bin', 'claude.exe');
    if (fs.isFile(guess) && isWindowsProgram(fs, guess) !== false) return { bin: guess, prefixArgs: [] };
  }
  for (const candidate of candidates) {
    const folder = p.join(p.dirname(candidate), ...NPM_PACKAGE);
    const bin = packageBin(folder, fs);
    const script = bin !== null && /\.js$/i.test(bin) ? p.join(folder, bin) : null;
    if (script && fs.isFile(script)) {
      const own = p.join(p.dirname(candidate), 'node.exe');
      return { bin: fs.isFile(own) ? own : execPath, prefixArgs: [script] };
    }
  }
  for (const candidate of candidates) {
    const derived = deriveExeFromCmd(candidate, fs);
    if (derived && fs.isFile(derived) && isWindowsProgram(fs, derived) !== false) return { bin: derived, prefixArgs: [] };
  }
  // Never fall back to a non-.exe on Windows: node-pty cannot launch a .cmd
  // (and routing a .cmd through cmd.exe is an argument-escaping hazard). Failing
  // loudly is safer than executing whatever `where claude` printed first.
  return undefined;
}

/**
 * What the package's package.json runs as `claude`, with forward slashes:
 * `bin/claude.exe` since the native builds, `cli.js` before them (2.1.110 and
 * older). Null when it cannot be read.
 */
function packageBin(folder: string, fs: ClaudeFs): string | null {
  const text = fs.readText(path.win32.join(folder, 'package.json'));
  if (text === null) return null;
  try {
    const bin = (JSON.parse(text) as { bin?: unknown }).bin;
    const claude = typeof bin === 'string' ? bin : (bin as { claude?: unknown } | null | undefined)?.claude;
    return typeof claude === 'string' ? claude.replace(/\\/g, '/').replace(/^\.\//, '') : null;
  } catch {
    return null;
  }
}

/**
 * Whether a file is a Windows program, read from its first two bytes: every
 * one starts with "MZ". Null when it cannot be read, which is no sign either way.
 *
 * Claude Code's npm package ships `bin\claude.exe` as a placeholder, a
 * 500-byte shell script, and its postinstall puts the real program over it. The
 * name is `claude.exe` either way, so it tells nothing; what the file starts
 * with does, and Windows reads the same bytes when it refuses to start a file
 * that lacks them.
 */
export function isWindowsProgram(fs: ClaudeFs, file: string): boolean | null {
  const start = fs.readStart(file, 2);
  if (start === null) return null;
  return start.length === 2 && start[0] === 0x4d && start[1] === 0x5a;
}

const NPM_PACKAGE = ['node_modules', '@anthropic-ai', 'claude-code'];

/** The platform package npm installs for each processor, as install.cjs names them. */
const PLATFORM_PACKAGES: Record<string, string> = {
  x64: 'claude-code-win32-x64',
  arm64: 'claude-code-win32-arm64',
};

/**
 * Claude Code npm installs beside the candidates whose `bin\claude.exe` is not
 * the program. A shim's install sits in the `node_modules` beside it; the
 * install's own `bin\claude.exe`, found in a known location, sits inside one.
 */
function brokenNpmInstalls(candidates: string[], fs: ClaudeFs, arch: string, now: number): BrokenNpmInstall[] {
  const p = path.win32;
  const folders = candidates.map((candidate) =>
    endsWithParts(candidate, [...NPM_PACKAGE, 'bin', 'claude.exe'])
      ? p.dirname(p.dirname(candidate))
      : p.join(p.dirname(candidate), ...NPM_PACKAGE),
  );
  const unique = folders.filter(
    (folder, index) => folders.findIndex((f) => f.toLowerCase() === folder.toLowerCase()) === index,
  );
  return unique.flatMap((folder) => {
    const install = inspectNpmInstall(folder, fs, arch, { now });
    return install ? [install] : [];
  });
}

/**
 * How long an install must have gone unchanged before ccx takes anything from
 * it or repairs it. npm writes the placeholder, then streams the platform
 * package's program of about 290 MB, and a half-written one already starts "MZ".
 */
export const SETTLED_MS = 3 * 60_000;

export interface InspectOptions {
  now?: number;
  /** 0 right after ccx's own npm run, which is known to have finished. */
  settledMs?: number;
}

/**
 * The install in `folder`, when it is verifiably broken: its package.json runs
 * `bin/claude.exe` and that is missing or reads as no program, or the folder is
 * gone and one of npm's shims in the prefix still points into it. Null for a
 * healthy install, for no install, for an older Claude Code that runs cli.js,
 * for a package.json that cannot be read, and for a program that cannot be read.
 */
export function inspectNpmInstall(
  folder: string,
  fs: ClaudeFs,
  arch: string = process.arch,
  options: InspectOptions = {},
): BrokenNpmInstall | null {
  const p = path.win32;
  const prefix = p.dirname(p.dirname(p.dirname(folder)));
  const program = p.join(folder, 'bin', 'claude.exe');
  const scope = p.dirname(folder);
  const now = options.now ?? Date.now();
  const settledMs = options.settledMs ?? SETTLED_MS;
  // What npm touches while it replaces the package: the scope folder it renames
  // the old package within, the folder it moves aside, and the new package.
  const changing = (files: string[]): boolean =>
    [scope, ...retiredFolders(folder, fs), ...files].some((file) => {
      const at = fs.modifiedAt(file);
      return at !== null && now - at < settledMs;
    });

  if (!fs.isDirectory(folder)) {
    if (!shimsPointInto(prefix, fs)) return null;
    // Nothing is left to put a program back into, so this is npm's to repair.
    return {
      folder,
      prefix,
      program,
      state: 'folder-missing',
      platformProgram: null,
      version: leftoverVersion(folder, fs),
      busy: changing([]),
    };
  }
  // Classed by what the package says it runs, never by the absence of a file
  // an older Claude Code never had.
  if (packageBin(folder, fs) !== 'bin/claude.exe') return null;
  const state = !fs.exists(program)
    ? 'missing'
    : fs.isFile(program) && isWindowsProgram(fs, program) === false
      ? 'placeholder'
      : null;
  if (!state) return null;
  const places = platformPrograms(folder, arch);
  const busy = changing([folder, program, ...places]);
  return {
    folder,
    prefix,
    program,
    state,
    platformProgram: busy ? null : (places.find((exe) => fs.isFile(exe) && isWindowsProgram(fs, exe) === true) ?? null),
    version: versionOf(folder, fs),
    busy,
  };
}

/**
 * How npm's shims name the package's program: inside their own folder, as
 * `%dp0%\node_modules\...` in `claude.cmd` and `$basedir/node_modules/...` in
 * `claude.ps1` and `claude`. A shim naming any other place, an absolute path
 * into another npm folder included, says nothing about this prefix.
 */
const POINTS_INTO_PACKAGE = /(?:%~?dp0%?|\$basedir)[\\/]+node_modules[\\/]+@anthropic-ai[\\/]+claude-code[\\/]/i;

function shimsPointInto(prefix: string, fs: ClaudeFs): boolean {
  return ['claude.cmd', 'claude.ps1', 'claude'].some((name) =>
    POINTS_INTO_PACKAGE.test(fs.readText(path.win32.join(prefix, name)) ?? ''),
  );
}

/**
 * While npm replaces a package it first renames the old folder beside it, to
 * `.claude-code-` and eight letters or digits (npm's retire-path), and puts it
 * back if the install fails. One left behind still holds the old package.json.
 */
const RETIRED_FOLDER = /^\.claude-code-[a-z0-9]{8}$/i;

function retiredFolders(folder: string, fs: ClaudeFs): string[] {
  const scope = path.win32.dirname(folder);
  return fs
    .list(scope)
    .filter((name) => RETIRED_FOLDER.test(name))
    .sort()
    .map((name) => path.win32.join(scope, name));
}

function leftoverVersion(folder: string, fs: ClaudeFs): string | null {
  for (const retired of retiredFolders(folder, fs)) {
    const version = versionOf(retired, fs);
    if (version) return version;
  }
  return null;
}

/**
 * Where the platform package's program can be. A global install nests the
 * package under the install (npm never places a global package's dependencies
 * above its own folder); a local or hoisted one puts it beside the install.
 */
function platformPrograms(folder: string, arch: string): string[] {
  const p = path.win32;
  const name = PLATFORM_PACKAGES[arch];
  if (!name) return [];
  return [p.join(folder, 'node_modules', '@anthropic-ai', name, 'claude.exe'), p.join(p.dirname(folder), name, 'claude.exe')];
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function versionOf(folder: string, fs: ClaudeFs): string | null {
  const text = fs.readText(path.win32.join(folder, 'package.json'));
  if (text === null) return null;
  try {
    const version = (JSON.parse(text) as { version?: unknown }).version;
    return typeof version === 'string' && VERSION.test(version) ? version : null;
  } catch {
    return null;
  }
}

function endsWithParts(file: string, parts: string[]): boolean {
  const have = file.split(/[\\/]+/).slice(-parts.length).map((part) => part.toLowerCase());
  return have.length === parts.length && have.every((part, i) => part === parts[i]);
}

/**
 * Read the `.exe` path out of an npm `.cmd` shim, resolved next to the shim.
 * The derived path is constrained to the shim's own directory tree so a crafted
 * or hijacked shim cannot point ccx at an arbitrary executable elsewhere.
 */
function deriveExeFromCmd(cmdPath: string, fs: ClaudeFs): string | null {
  const p = path.win32;
  if (!/\.cmd$/i.test(cmdPath)) return null;
  const content = fs.readText(cmdPath);
  if (content === null) return null;
  const match = content.match(/dp0%?\\?([^"\r\n%]*?\.exe)/i);
  const raw = match?.[1];
  if (!raw || raw.includes('..') || p.isAbsolute(raw)) return null;
  const dir = p.resolve(p.dirname(cmdPath));
  const exe = p.resolve(dir, raw.replace(/^[\\/]/, ''));
  // Reject anything that escapes the shim directory.
  if (exe !== dir && !exe.startsWith(dir + p.sep)) return null;
  // The .cmd npm writes for a script names node.exe first, as the program that
  // runs the script; node is never Claude.
  if (p.basename(exe).toLowerCase() === 'node.exe') return null;
  return exe;
}

/**
 * Ask the OS where `claude` lives, then look where it is normally installed.
 *
 * PATH alone was not enough, and the way it fails is confusing: Claude is
 * installed, the operator can run it in their own shell, and ccx says it does
 * not exist. That happens whenever the installer added a directory to PATH
 * that this process never inherited, which is the ordinary case for a shell
 * (or an editor) started before the install, and for anything launched from a
 * process with a frozen environment.
 *
 * So a miss on PATH is not an answer, it is a reason to go and look.
 */
export function defaultFindCandidates(
  platform: NodeJS.Platform,
  fromPath: () => string[] = () => onPath(platform),
  fs: ClaudeFs = nodeClaudeFs,
): string[] {
  return [...fromPath(), ...whereItIsUsuallyInstalled(platform)].filter((candidate) =>
    canBeLaunched(candidate, platform, fs),
  );
}

/**
 * Is this something we could actually run?
 *
 * Existing is not enough. A directory can be named `claude`, and on POSIX a
 * file can exist without the executable bit. Either would be taken as the
 * answer, and since the first candidate wins, an unusable one hides a working
 * install further down the list. Failing to find Claude at all is a better
 * outcome than that: it says so, where this would report a launch failure
 * nobody could explain.
 */
function canBeLaunched(candidate: string, platform: NodeJS.Platform, fs: ClaudeFs): boolean {
  if (!fs.isFile(candidate)) return false;
  return platform === 'win32' || fs.isExecutable(candidate); // Windows has no executable bit
}

function onPath(platform: NodeJS.Platform): string[] {
  const cmd = platform === 'win32' ? 'where' : 'which';
  const args = platform === 'win32' ? ['claude'] : ['-a', 'claude'];
  try {
    // stderr is silenced deliberately. Finding nothing here is normal now that
    // the known locations are searched too, and `where` announces a miss with
    // "INFO: could not find files for the given patterns", which landed in the
    // operator's terminal looking like a fault.
    const out = execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/**
 * The places Claude Code actually installs itself.
 *
 * Listed rather than guessed at: the native installer, the local install that
 * `claude migrate-installer` produces, and the two npm global layouts. An
 * absent one costs a stat, and a present one turns "could not resolve the real
 * claude binary" into a session that simply starts.
 */
export function whereItIsUsuallyInstalled(platform: NodeJS.Platform): string[] {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const npmPackage = path.join(...NPM_PACKAGE, 'bin');

  if (platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    return [
      path.join(home, '.local', 'bin', 'claude.exe'),
      path.join(localAppData, 'Programs', 'claude', 'claude.exe'),
      path.join(home, '.claude', 'local', 'claude.exe'),
      path.join(appData, 'npm', npmPackage, 'claude.exe'),
      path.join(programFiles, 'nodejs', npmPackage, 'claude.exe'),
      path.join(home, '.bun', 'bin', 'claude.exe'),
    ];
  }

  return [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    path.join(home, '.bun', 'bin', 'claude'),
    path.join('/usr/local/lib', npmPackage, 'claude'),
  ];
}

/**
 * Detect our own shim so it is never selected. The shim is normally a shell
 * function (not a PATH file), so this defaults to false in practice; it guards
 * the rare case a shim file lands on PATH.
 */
function defaultIsShim(candidate: string): boolean {
  return /claude-auto-switch|[\\/]ccx(\.|$)/i.test(candidate);
}
