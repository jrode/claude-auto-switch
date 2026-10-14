import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { homeDir, type PathCtx } from '../config/paths.js';
import { hasShimBlock, type ShellKind } from './install-shim.js';
import {
  queryPowerShell,
  shouldAskPowerShell,
  type PowerShellExe,
  type PowerShellFacts,
} from './profile-path.js';

/**
 * Every shell on the machine that a person might type `claude` into, and the
 * files each one reads at startup.
 *
 * Which shells get the shim, by default:
 * - A shell already carrying it, so an existing install stays current.
 * - On Windows, Windows PowerShell always (it ships with Windows and is what
 *   the Start menu opens), PowerShell 7 when it is installed, and Git Bash when
 *   it is installed and has been used.
 * - On macOS and Linux, zsh and bash when used: the login shell, or one with a
 *   startup file or a history file. A shell with none of those has never been
 *   set up or opened here, and writing its files would only leave litter.
 */

export type ShellId = 'zsh' | 'bash' | 'powershell' | 'pwsh';

/** `use`: set up by `ccx on`. `unused`: present, left alone. `absent`: not installed. */
export type ShellState = 'use' | 'unused' | 'absent';

export interface ShellPlan {
  id: ShellId;
  /** The shell's name for people: `Git Bash`, `PowerShell 7`. */
  label: string;
  kind: ShellKind;
  state: ShellState;
  /** Where the shim belongs, so that every way of starting this shell reads it once. */
  files: string[];
  /** Files this shell also reads, which must not keep a second, possibly older copy. */
  retired: string[];
  /** Every file `ccx off` cleans for this shell, including where older ccx versions wrote. */
  sweep: string[];
  /** Why ccx leaves an unused shell alone. */
  why?: string;
  /** Something on the machine that stops the shim from running in this shell. */
  blocked?: { detail: string; fix?: string };
}

export interface ShellFs {
  exists(file: string): boolean;
  read(file: string): string | null;
}

/** What the plans are made from. Gathered by readMachine; built by hand in tests. */
export interface Machine {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  fs: ShellFs;
  /** Windows only. Absent: not asked. Null: asked, and it did not answer. */
  powershell: Partial<Record<PowerShellExe, PowerShellFacts | null>>;
  gitBash: boolean;
}

export interface ShellDeps {
  /** The machine really being run on. Injected so the Windows path is testable anywhere. */
  hostPlatform?: NodeJS.Platform;
  queryPowerShell?: (exe: PowerShellExe) => PowerShellFacts | null;
  fs?: ShellFs;
  findGitBash?: (env: NodeJS.ProcessEnv, fs: ShellFs) => boolean;
}

const realFs: ShellFs = {
  exists: (file) => existsSync(file),
  read: (file) => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  },
};

/**
 * Gather what the plans need. The real PowerShell is asked only when nothing
 * was injected (shouldAskPowerShell); otherwise everything comes from the
 * environment given, so a test pointed at a temporary home stays inside it.
 */
export function readMachine(c: PathCtx = {}, deps: ShellDeps = {}): Machine {
  const host = deps.hostPlatform ?? process.platform;
  const platform = c.platform ?? host;
  const env = c.env ?? process.env;
  const fs = deps.fs ?? realFs;
  const powershell: Machine['powershell'] = {};
  if (platform === 'win32' && shouldAskPowerShell(c, host)) {
    const ask = deps.queryPowerShell ?? queryPowerShell;
    powershell.powershell = ask('powershell');
    powershell.pwsh = ask('pwsh');
  }
  const gitBash = platform === 'win32' && (deps.findGitBash ?? findGitBash)(env, fs);
  return { platform, env, fs, powershell, gitBash };
}

/** Is Git Bash installed? Looked for where Git's installers put it, and beside the git on PATH. */
export function findGitBash(env: NodeJS.ProcessEnv, fs: ShellFs): boolean {
  const p = path.win32;
  const roots: string[] = [];
  for (const base of [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']]) {
    if (base) roots.push(p.join(base, 'Git'));
  }
  if (env.LOCALAPPDATA) roots.push(p.join(env.LOCALAPPDATA, 'Programs', 'Git'));
  // git.exe sits in Git\cmd or Git\mingw64\bin, so the root is one or two up.
  for (const dir of (env.PATH ?? env.Path ?? '').split(';')) {
    if (dir && fs.exists(p.join(dir, 'git.exe'))) roots.push(p.dirname(dir), p.dirname(p.dirname(dir)));
  }
  return roots.some((root) => fs.exists(p.join(root, 'bin', 'bash.exe')));
}

/**
 * Whether a bash login file loads ~/.bashrc itself, as the files most Linux
 * distributions and Git for Windows create do. Errs towards no: a miss only
 * means the shim is in both files and defined twice, identically, while a
 * wrong yes would leave login shells without it.
 */
export function loadsBashrc(text: string): boolean {
  return text.split(/\r?\n/).some((line) => {
    const code = line.replace(/(^|\s)#.*$/, '');
    return /(^|[\s;&|({])(\.|source)\s+["']?[^\s;&|"']*\.bashrc(?=$|["'\s;&|)])/.test(code);
  });
}

export function planShells(m: Machine): ShellPlan[] {
  return m.platform === 'win32'
    ? [powershellPlan(m, 'powershell'), powershellPlan(m, 'pwsh'), gitBashPlan(m)]
    : [zshPlan(m), bashPlan(m, path.posix, homeDir(m), 'bash', true), posixPwshPlan(m)];
}

/** The plans for this machine. */
export function shellPlans(c: PathCtx = {}, deps: ShellDeps = {}): ShellPlan[] {
  return planShells(readMachine(c, deps));
}

function loginShell(m: Machine): string {
  return m.platform === 'win32' ? '' : path.posix.basename(m.env.SHELL ?? '');
}

function carriesShim(m: Machine, files: string[]): boolean {
  return files.some((f) => hasShimBlock(m.fs.read(f) ?? ''));
}

/** A shell that already has the shim stays set up whatever else is true of it. */
function settle(m: Machine, plan: Omit<ShellPlan, 'state'>, natural: ShellState): ShellPlan {
  const state = carriesShim(m, [...plan.files, ...plan.retired]) ? 'use' : natural;
  const { why, ...rest } = plan;
  return state === 'unused' && why ? { ...rest, state, why } : { ...rest, state };
}

function unique(files: string[]): string[] {
  return [...new Set(files)];
}

function noSignOfUse(label: string): string {
  return `nothing shows ${label} is used here: it is not the login shell and has no startup file or history`;
}

function zshPlan(m: Machine): ShellPlan {
  const p = path.posix;
  const home = homeDir(m);
  const dot = m.env.ZDOTDIR || home;
  const used =
    loginShell(m) === 'zsh' ||
    [dot, home].some((dir) =>
      ['.zshrc', '.zprofile', '.zshenv', '.zlogin', '.zsh_history'].some((f) => m.fs.exists(p.join(dir, f))),
    );
  const rc = p.join(dot, '.zshrc');
  return settle(
    m,
    {
      id: 'zsh',
      label: 'zsh',
      kind: 'posix',
      files: [rc],
      retired: [],
      sweep: unique([rc, p.join(home, '.zshrc')]),
      why: noSignOfUse('zsh'),
    },
    used ? 'use' : 'unused',
  );
}

function bashPlan(
  m: Machine,
  p: path.PlatformPath,
  home: string,
  label: string,
  installed: boolean,
): ShellPlan {
  const rc = p.join(home, '.bashrc');
  const logins = ['.bash_profile', '.bash_login', '.profile'].map((f) => p.join(home, f));
  // A login shell reads the first of these that exists, and only that one.
  const login = logins.find((f) => m.fs.exists(f));
  const loginLoadsRc = login !== undefined && loadsBashrc(m.fs.read(login) ?? '');
  // With no login file, .profile: a new .bash_profile would hide a .profile
  // made later, while bash reads .profile last and so it hides nothing.
  const loginFiles = login === undefined ? [p.join(home, '.profile')] : loginLoadsRc ? [] : [login];
  const used =
    loginShell(m) === 'bash' ||
    [rc, ...logins.slice(0, 2), p.join(home, '.bash_history')].some((f) => m.fs.exists(f));
  return settle(
    m,
    {
      id: 'bash',
      label,
      kind: 'posix',
      files: [rc, ...loginFiles],
      retired: login !== undefined && loginLoadsRc ? [login] : [],
      sweep: [rc, ...logins],
      why: noSignOfUse(label),
    },
    !installed ? 'absent' : used ? 'use' : 'unused',
  );
}

function gitBashPlan(m: Machine): ShellPlan {
  // Git Bash uses HOME when it is set to a Windows folder, otherwise the
  // profile folder. A HOME like /c/Users/me is Git Bash's own view of it.
  const home = /^[A-Za-z]:[\\/]/.test(m.env.HOME ?? '') ? (m.env.HOME as string) : homeDir(m);
  return bashPlan(m, path.win32, home, 'Git Bash', m.gitBash);
}

/** Documents folders an older ccx could have used, the OneDrive one first. */
function documentsFolders(m: Machine): string[] {
  const p = path.win32;
  const home = homeDir(m);
  return unique([...(m.env.OneDrive ? [p.join(m.env.OneDrive, 'Documents')] : []), p.join(home, 'Documents')]);
}

const POLICIES_THAT_RUN_NO_UNSIGNED_SCRIPTS = new Set(['restricted', 'allsigned']);

function powershellPlan(m: Machine, exe: PowerShellExe): ShellPlan {
  const p = path.win32;
  const facts = m.powershell[exe];
  const folder = exe === 'pwsh' ? 'PowerShell' : 'WindowsPowerShell';
  const label = exe === 'pwsh' ? 'PowerShell 7' : 'Windows PowerShell';
  const docs = documentsFolders(m);
  const dir = facts ? p.dirname(facts.allHosts) : p.join(docs[0] as string, folder);
  // All hosts, not the console's own $PROFILE: Windows Terminal, a standalone
  // window and an editor's plain terminal are all the console host, but the
  // VS Code PowerShell extension's terminal and the ISE are hosts of their
  // own, and read only their own profile and this one.
  const allHosts = facts?.allHosts ?? p.join(dir, 'profile.ps1');
  const consoleHost = facts?.currentHost ?? p.join(dir, 'Microsoft.PowerShell_profile.ps1');
  const installed = exe === 'powershell' || (facts === undefined ? m.fs.exists(dir) : facts !== null);
  const plan: Omit<ShellPlan, 'state'> = {
    id: exe,
    label,
    kind: 'powershell',
    files: [allHosts],
    retired: [consoleHost],
    sweep: unique([
      allHosts,
      consoleHost,
      ...docs.flatMap((d) => [p.join(d, folder, 'profile.ps1'), p.join(d, folder, 'Microsoft.PowerShell_profile.ps1')]),
    ]),
  };
  if (facts && POLICIES_THAT_RUN_NO_UNSIGNED_SCRIPTS.has(facts.policy.toLowerCase())) {
    const what = `its execution policy is ${facts.policy}, so it runs neither its profile nor npm's ccx command`;
    plan.blocked = facts.policyFromGroupPolicy
      ? { detail: `${what}; Group Policy sets it, so only an administrator can change it` }
      : { detail: what, fix: `${exe} -NoProfile -Command Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` };
  }
  return settle(m, plan, installed ? 'use' : 'absent');
}

/** PowerShell on macOS or Linux: set up only when asked, or when it already has the shim. */
function posixPwshPlan(m: Machine): ShellPlan {
  const p = path.posix;
  const home = homeDir(m);
  const dir = p.join(m.env.XDG_CONFIG_HOME || p.join(home, '.config'), 'powershell');
  const allHosts = p.join(dir, 'profile.ps1');
  const consoleHost = p.join(dir, 'Microsoft.PowerShell_profile.ps1');
  return settle(
    m,
    {
      id: 'pwsh',
      label: 'PowerShell',
      kind: 'powershell',
      files: [allHosts],
      retired: [consoleHost],
      // Where `ccx on --shell powershell` here used to write, which pwsh never reads.
      sweep: [allHosts, consoleHost, p.join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1')],
    },
    'absent',
  );
}

/**
 * How far the shim reaches: in no shell, in some, or in every file of every
 * shell `ccx on` would set up. A shell its execution policy blocks is left out,
 * because `ccx on` cannot change that.
 */
export function shellCoverage(plans: ShellPlan[], fs: ShellFs = realFs): 'none' | 'some' | 'all' {
  const has = (f: string) => hasShimBlock(fs.read(f) ?? '');
  if (!plans.some((p) => [...p.files, ...p.retired].some(has))) return 'none';
  const wanted = plans.filter((p) => p.state === 'use' && !p.blocked);
  // A shim only where nothing can run it routes nothing through ccx.
  if (wanted.length === 0) return 'none';
  return wanted.every((p) => p.files.every(has)) ? 'all' : 'some';
}

export type ShellSelection = { ok: true; chosen: ShellPlan[] } | { ok: false; reason: string };

const NAMED: Record<string, ShellId> = { zsh: 'zsh', bash: 'bash', pwsh: 'pwsh' };

/**
 * Which plans `ccx on --shell <name>` acts on. With no name, every shell in
 * use. A named shell is set up even when nothing shows it is used, because
 * the person asked for it. On Windows `powershell` is Windows PowerShell and
 * `pwsh` PowerShell 7; elsewhere both name pwsh. `posix` is kept from before,
 * when it chose the shim's flavour: the shells in use among zsh and bash.
 */
export function selectShells(plans: ShellPlan[], shell: string | undefined): ShellSelection {
  if (shell === undefined) {
    return { ok: true, chosen: plans.filter((p) => p.state === 'use') };
  }
  if (shell === 'posix') {
    return { ok: true, chosen: plans.filter((p) => p.kind === 'posix' && p.state === 'use') };
  }
  const id: ShellId | undefined =
    shell === 'powershell' ? (plans.some((p) => p.id === 'powershell') ? 'powershell' : 'pwsh') : NAMED[shell];
  const plan = plans.find((p) => p.id === id);
  if (!plan) {
    return {
      ok: false,
      reason:
        id === undefined
          ? `unknown shell "${shell}": use ${plans.map((p) => p.id).join(', ')}`
          : `ccx does not set up ${shell} on this system: use ${plans.map((p) => p.id).join(', ')}`,
    };
  }
  return { ok: true, chosen: [plan] };
}
