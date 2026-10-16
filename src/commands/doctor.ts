import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { browserPortReachable } from '../login/browser.js';
import { findKeepalive } from '../keepalive/crontab.js';
import {
  expectedKeepalive,
  keepaliveIsCurrent,
  systemCrontab,
  type KeepaliveDeps,
} from './keepalive.js';
import { isHeadlessSession } from '../util/headless.js';
import { auditSessionAccount } from './doctor-session-account.js';
import { configHome, profilesDir } from '../config/paths.js';
import { detectEditors } from '../editor/settings.js';
import { readEditorEnvVar } from '../editor/install.js';
import { editorTargetAccount } from '../editor/junction.js';
import { isShimInstalled, shimHasFallback, shimIsCurrent } from '../shell/install-shim.js';
import { shellPlans, type ShellPlan } from '../shell/shells.js';
import { isLink, readTarget } from '../daemon/junction.js';
import { hasWorkingLogin } from '../accounts/account-login.js';
import { defaultClaudeRoot } from '../session/shared-root.js';
import { getAccount, listAccounts } from '../accounts/registry.js';
import { liveLeases } from '../session/lease.js';
import { verifyAccountIdentities } from '../accounts/identity-check.js';
import { sharedLoginGroups } from '../accounts/duplicate-guard.js';
import { loadLedger } from '../ledger/ledger.js';
import { probeAll } from '../health/prober.js';
import { codes, paint } from '../ui/style.js';
import { claudeRepairDeps, getClaudeAsIs, type CliContext } from '../context.js';
import {
  cannotFindClaude,
  describeBrokenInstall,
  findRealClaude,
  type ClaudeSearch,
} from '../launcher/real-claude.js';
import { repairClaudeInstalls } from '../launcher/claude-repair.js';
import type { ClaudeInvoker } from '../invoker.js';
import { signedInAndNotRejected } from '../health/signed-in.js';
import { settingsPath, readSettings, isOurs } from '../statusline/settings-install.js';
import { installedHooksProblem, readInstalledHandoff } from '../desktop/hooks.js';
import { artifactHooksInstalled, artifactHooksProblem, withoutArtifactHooks } from '../artifacts/hooks.js';
import { routingOn } from '../artifacts/route.js';

export interface DoctorCheck {
  name: string;
  /** For a shell's check: which shell, by its ccx name (`zsh`, `pwsh`, `cmd`). */
  shell?: string;
  /** Shown instead of the name's label: a shell's own name. */
  label?: string;
  ok: boolean;
  detail: string;
  /** Commands that would resolve this, shown together at the end. */
  fix?: string[];
  /** Worth mentioning, but not a failure (e.g. an optional integration is off). */
  note?: boolean;
}

export interface DoctorDeps {
  /** Tracked file list (defaults to `git ls-files`); injected in tests. */
  gitTrackedFiles?: () => string[];
  /** Claude resolver, standing in for the whole search; injected in tests. */
  resolveClaude?: () => ClaudeInvoker;
  /** The search for Claude, repairing nothing; injected in tests. */
  findClaude?: () => ClaudeSearch;
  /** What `--fix` runs for a broken Claude Code npm install; injected in tests, which never run npm. */
  repairClaude?: () => string[];
  /** Browser debug-port reachability probe; injected in tests. */
  checkBrowserPort?: (port: number) => Promise<boolean>;
  /** Whether nobody is at a browser here; read from the session when absent. */
  headless?: boolean;
  /** The user's crontab, or null when cron is unavailable; injected in tests. */
  readCrontab?: () => Promise<string | null>;
  /** The node and ccx keepalive should be running; injected in tests. */
  keepalive?: KeepaliveDeps;
  /** The shells and their files; injected in tests, worked out from the machine otherwise. */
  shellPlans?: ShellPlan[];
  /** Skip checks that need the network (used by tests and offline runs). */
  skipNetwork?: boolean;
  /** Injected in tests for the identity check. */
  fetchImpl?: typeof fetch;
}

/** Files that must never be committed. */
const SECRET_PATTERNS = [
  /(^|[\\/])\.credentials\.json$/,
  /(^|[\\/])accounts\.json$/,
  /(^|[\\/])ledger\.json$/,
  /(^|[\\/])oauth-token$/,
  /(^|[\\/])session-debug\.log$/,
  /(^|[\\/])last-setup-token-output\.txt$/,
  /(^|[\\/])profiles[\\/]/,
];

/** Fail if any credential or profile file is tracked in git. */
export function auditGitSafety(trackedFiles: string[]): DoctorCheck {
  const dangerous = trackedFiles.filter((f) => SECRET_PATTERNS.some((re) => re.test(f)));
  return {
    name: 'git-safety',
    ok: dangerous.length === 0,
    detail:
      dangerous.length === 0
        ? 'no credential or profile files are tracked in git'
        : `secrets tracked in git: ${dangerous.join(', ')}`,
  };
}

function auditConfig(context: CliContext): DoctorCheck {
  const home = configHome(context.ctx);
  const profiles = profilesDir(context.config, context.ctx);
  return {
    name: 'config',
    ok: true,
    detail: `${home}${existsSync(home) ? '' : ' (not created yet)'}`,
    ...(profiles.startsWith(home) ? {} : { note: false }),
  };
}

/**
 * Which claude ccx would start. Only looks: a Claude Code npm install that has
 * lost its program is reported with `ccx doctor --fix`, which repairs it, as
 * starting Claude through ccx would.
 */
function auditRealClaude(context: CliContext, deps: DoctorDeps): DoctorCheck {
  const name = 'real-claude';
  if (deps.resolveClaude || context.claude || context.config.realClaudePath) {
    try {
      const claude = (deps.resolveClaude ?? (() => getClaudeAsIs(context)))();
      return { name, ok: true, detail: `resolved to ${claude.bin}` };
    } catch (err) {
      return { name, ok: false, detail: (err as Error).message };
    }
  }
  const platform = context.ctx.platform ?? process.platform;
  const search = (deps.findClaude ?? (() => findRealClaude({ platform })))();
  const repair = search.broken.length > 0 ? { fix: ['ccx doctor --fix'] } : {};
  if (!search.bin) {
    return { name, ok: false, detail: cannotFindClaude(search.candidates, platform, search.broken), ...repair };
  }
  if (search.broken.length === 0) return { name, ok: true, detail: `resolved to ${search.bin}` };
  return {
    name,
    ok: true,
    note: true,
    detail: `resolved to ${search.bin}, but Claude Code's npm install is missing its program: ${search.broken
      .map(describeBrokenInstall)
      .join('; ')}`,
    ...repair,
  };
}

/** `ccx doctor --fix`: the repair a launch makes, run when the search finds a broken npm install. */
function repairClaudeIfBroken(context: CliContext, deps: DoctorDeps): void {
  if (deps.resolveClaude || context.claude || context.config.realClaudePath) return;
  const platform = context.ctx.platform ?? process.platform;
  const search = (deps.findClaude ?? (() => findRealClaude({ platform })))();
  if (search.broken.length === 0) return;
  (deps.repairClaude ?? (() => repairClaudeInstalls(claudeRepairDeps(context))))();
}

/** Informational: is Chrome listening on the debug port (needed only for auto-login)? */
async function auditBrowserPort(context: CliContext, deps: DoctorDeps): Promise<DoctorCheck> {
  const port = context.config.browser.debugPort;
  const reachable = await (deps.checkBrowserPort ?? browserPortReachable)(port);
  if (reachable) {
    return {
      name: 'browser-debug-port',
      ok: true,
      detail: `Chrome is reachable for automatic sign-in (port ${port})`,
    };
  }
  return {
    name: 'browser-debug-port',
    ok: true,
    note: true,
    detail: headless(context, deps)
      ? 'no browser on this machine; ccx login shows a link and takes the pasted code, or sign in from a machine with one: ccx login --host <this machine>'
      : 'automatic sign-in unavailable; ccx login opens a browser for you instead',
  };
}

/**
 * On a machine nobody sits at, is anything renewing idle logins? Asked only
 * there: a desktop renews them whenever Claude or the status line runs.
 */
async function auditKeepalive(context: CliContext, deps: DoctorDeps): Promise<DoctorCheck | null> {
  if (!headless(context, deps) || (context.ctx.platform ?? process.platform) === 'win32') return null;
  const crontab = await (deps.readCrontab ?? (() => systemCrontab.read()))();
  if (crontab === null) return null;
  const line = findKeepalive(crontab);
  if (line && keepaliveIsCurrent(line, expectedKeepalive(context, deps.keepalive), deps.keepalive?.exists)) {
    return { name: 'keepalive', ok: true, detail: 'idle logins are renewed every four hours' };
  }
  return {
    name: 'keepalive',
    ok: true,
    note: true,
    detail: line
      ? 'the keepalive job runs a node or ccx that is not this one, so it renews nothing'
      : 'nothing renews idle logins here, and a machine nobody uses for a day can lose them',
    fix: ['ccx keepalive on'],
  };
}

function headless(context: CliContext, deps: DoctorDeps): boolean {
  return (
    deps.headless ??
    isHeadlessSession(context.ctx.env ?? process.env, context.ctx.platform ?? process.platform)
  );
}

function defaultTrackedFiles(): string[] {
  try {
    return execFileSync('git', ['ls-files'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

/**
 * Each shell, and whether typing `claude` in it goes through ccx. Read from
 * the files each shell loads at startup, never by starting the shell, which
 * would run whatever else those files do. Changes nothing, the execution
 * policy included: that is for the person to decide.
 */
export function auditShells(context: CliContext, deps: DoctorDeps = {}): DoctorCheck[] {
  let plans: ShellPlan[];
  try {
    plans = deps.shellPlans ?? shellPlans(context.ctx);
  } catch {
    return [{ name: 'terminal-shim', ok: true, detail: 'could not work out your shells (skipped)' }];
  }
  const has = (file: string): boolean => {
    try {
      return isShimInstalled(file);
    } catch {
      return false;
    }
  };
  const onSomewhere = plans.some((p) => [...p.files, ...p.retired].some(has));
  const checks = plans.filter((p) => p.state !== 'absent').map((plan) => auditShell(plan, has, onSomewhere));
  if ((context.ctx.platform ?? process.platform) === 'win32') {
    checks.push({
      name: 'terminal-shim',
      shell: 'cmd',
      label: 'cmd',
      ok: true,
      note: true,
      detail: 'not covered: cmd has no profile to put `claude` in, so there it runs on its own (use ccx run, or PowerShell)',
    });
  }
  return checks;
}

function auditShell(plan: ShellPlan, has: (file: string) => boolean, onSomewhere: boolean): DoctorCheck {
  const base = { name: 'terminal-shim', shell: plan.id, label: plan.label };
  if (plan.state === 'unused') {
    return { ...base, ok: true, note: true, detail: `left alone, ${plan.why} (ccx on --shell ${plan.id} adds it)` };
  }
  if (plan.blocked) {
    // A note, not a failure: the policy is the machine's, often chosen, and
    // plenty of people never open this shell. It also stops npm's ccx command.
    return {
      ...base,
      ok: true,
      note: true,
      detail: `\`claude\` skips ccx here: ${plan.blocked.detail}`,
      ...(plan.blocked.fix ? { fix: [plan.blocked.fix] } : {}),
    };
  }
  const missing = plan.files.filter((f) => !has(f));
  if (missing.length === plan.files.length) {
    return onSomewhere
      ? {
          ...base,
          ok: false,
          detail: `\`claude\` skips ccx here, while other shells have it: no shim in ${missing.join(', ')}`,
          fix: ['ccx on'],
        }
      : { ...base, ok: true, note: true, detail: '`claude` runs on its own here', fix: ['ccx on'] };
  }
  if (missing.length > 0) {
    return {
      ...base,
      ok: false,
      detail: `\`claude\` skips ccx in some ${plan.label} windows: no shim in ${missing.join(', ')}`,
      fix: ['ccx on'],
    };
  }
  if (plan.files.some((f) => !shimHasFallback(f))) {
    return { ...base, ok: false, detail: 'an old shim is installed; removing ccx would break `claude`', fix: ['ccx on'] };
  }
  if (plan.files.some((f) => !shimIsCurrent(f, plan.kind))) {
    return {
      ...base,
      ok: false,
      detail: 'the shim is from an older ccx (in PowerShell, `claude --version` and `claude --help` reached ccx)',
      fix: ['ccx on'],
    };
  }
  const extra = plan.retired.filter(has);
  if (extra.length > 0) {
    return {
      ...base,
      ok: false,
      detail: `${plan.label} also loads an older copy from ${extra.join(', ')}`,
      fix: ['ccx on'],
    };
  }
  return { ...base, ok: true, detail: `\`claude\` goes through ccx (${plan.files.join(', ')})` };
}

/**
 * Is ccx visible while Claude is running?
 *
 * The shim is transparent by design, so nothing on screen says ccx is on. The
 * status line is the one place that can, which makes "is it wired up" worth
 * reporting rather than leaving someone to wonder whether switching is
 * happening at all.
 */
export function auditStatusline(context: CliContext): DoctorCheck {
  const file = (() => {
    try {
      return settingsPath(context.ctx);
    } catch {
      return null;
    }
  })();
  if (!file) return { name: 'statusline', ok: true, detail: 'no Claude settings to check (skipped)' };

  const read = readSettings(file);
  if (!read.ok) {
    return {
      name: 'statusline',
      ok: false,
      // Unreadable covers more than bad syntax: no permission to read the
      // file, or valid JSON that is not a settings object. Naming only one
      // cause would send someone looking in the wrong place.
      detail: `${file} could not be read as settings, so ccx will not change it`,
      fix: ['make the file readable and a valid JSON object, then run: ccx on'],
    };
  }
  if (isOurs(read.settings.statusLine)) {
    return { name: 'statusline', ok: true, detail: 'Claude shows your account and remaining room' };
  }
  if (read.settings.statusLine) {
    return {
      name: 'statusline',
      ok: true,
      note: true,
      detail: 'your own status line is in place; ccx is not shown in it',
      fix: ['ccx on'],
    };
  }
  return {
    name: 'statusline',
    ok: true,
    note: true,
    detail: 'nothing on screen says which account you are on',
    fix: ['ccx on'],
  };
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * The session directory worth inspecting.
 *
 * Sessions get one each now, so there is no single fixed path to look at. A
 * running one is the honest subject; the pre-split single directory is the
 * fallback so a session started before the upgrade is still reported on.
 */
function currentSessionDir(context: CliContext): string {
  const live = liveLeases(context.ctx)
    .map((lease) => lease.configDir)
    .filter((dir): dir is string => typeof dir === 'string' && dir.length > 0);
  // liveLeases sorts oldest first, so the LAST entry is the most recently
  // refreshed session, which is the honest subject to inspect.
  return live[live.length - 1] ?? path.join(configHome(context.ctx), 'session');
}

/** Session history: ccx must SHARE ~/.claude/projects, never fork it. */
export function auditSharedHistory(context: CliContext): DoctorCheck {
  const name = 'shared-history';
  const sessionDir = currentSessionDir(context);
  const link = path.join(sessionDir, 'projects');
  if (!existsSync(sessionDir)) {
    return { name, ok: true, detail: 'no ccx session yet (links on first session)' };
  }
  if (isLink(link)) {
    let expected: string;
    try {
      expected = path.join(defaultClaudeRoot(context.ctx), 'projects');
    } catch {
      return { name, ok: true, detail: 'linked (no resolvable home to compare against)' };
    }
    const target = readTarget(link) ?? '';
    return samePath(target, expected)
      ? { name, ok: true, detail: '/resume history and memories shared with ~/.claude' }
      : { name, ok: false, detail: `session projects points at ${target}, expected ${expected}` };
  }
  if (existsSync(link)) {
    return {
      name,
      ok: false,
      detail: 'session history is FORKED from ~/.claude (self-heals at the start of your next ccx session)',
    };
  }
  return { name, ok: true, detail: 'links to ~/.claude/projects on the next session' };
}

/** Account health: REAL login state per account (probed), naming who needs login. */
export async function auditAccounts(context: CliContext): Promise<DoctorCheck> {
  const name = 'accounts';
  const accounts = listAccounts(context.ctx);
  if (accounts.length === 0) {
    return { name, ok: true, detail: 'no accounts registered yet (run: ccx add <name>)' };
  }
  let loggedInNames: Set<string>;
  try {
    // Ask claude itself: a credential FILE can exist while its token is dead,
    // and a doctor that reports a dead login as healthy is worse than none.
    const healths = await probeAll(accounts, { claude: getClaudeAsIs(context) });
    loggedInNames = signedInAndNotRejected(healths, accounts, context.ctx);
  } catch {
    loggedInNames = new Set(
      accounts
        .filter((a) => hasWorkingLogin(a.dir, context.ctx))
        .map((a) => a.name),
    );
  }
  const out = accounts.filter((a) => !loggedInNames.has(a.name));
  return {
    name,
    ok: accounts.some((a) => a.enabled && loggedInNames.has(a.name)),
    detail: `${loggedInNames.size} of ${accounts.length} signed in`,
    ...(out.length > 0 ? { fix: out.map((a) => `ccx login ${a.name}`), note: true } : {}),
  };
}

/**
 * Confirm each profile holds the account it claims to. This is the only check
 * that can catch profiles that have been scrambled or that share one login,
 * because local files report the recorded identity, not the token's owner.
 */
export async function auditIdentities(
  context: CliContext,
  deps: DoctorDeps = {},
): Promise<DoctorCheck> {
  const name = 'account-identity';
  const accounts = listAccounts(context.ctx);
  if (accounts.length === 0) return { name, ok: true, detail: 'no accounts registered' };
  if (deps.skipNetwork) return { name, ok: true, detail: 'skipped (no network checks)' };

  const findings = await verifyAccountIdentities(
    accounts.map((a) => ({ name: a.name, dir: a.dir, ...(a.email ? { email: a.email } : {}) })),
    deps.fetchImpl ?? fetch,
  );
  const broken = findings.filter((f) => f.kind === 'mismatch' || f.kind === 'duplicate');
  if (broken.length === 0) {
    const loggedOut = findings.filter((f) => f.kind === 'logged-out').length;
    return {
      name,
      ok: true,
      detail:
        loggedOut > 0
          ? `${findings.length - loggedOut} confirmed, ${loggedOut} not signed in`
          : 'every profile holds the account it should',
    };
  }
  return {
    name,
    ok: false,
    detail: broken.map((f) => `${f.account} ${f.detail.replace(/ \(run: [^)]+\)/, '')}`).join('; '),
    fix: broken.map((f) => `ccx login ${f.account}`),
  };
}

/**
 * Do any two profiles hold the same login?
 *
 * Checked locally and without the network, because this is the state that
 * destroys accounts: renewing a shared login ends it for the other profile. It
 * needs to be visible immediately, not only when a network check is possible.
 */
export function auditSharedLogins(context: CliContext): DoctorCheck {
  const name = 'separate-logins';
  const groups = sharedLoginGroups(listAccounts(context.ctx));
  if (groups.length === 0) {
    return { name, ok: true, detail: 'no two accounts share a sign-in that renewal could end' };
  }
  return {
    name,
    ok: false,
    detail: groups
      .map((g) => `${g.names.join(' and ')} hold the SAME sign-in; renewing either would end the other`)
      .join('; '),
    fix: groups.flatMap((g) => g.names.slice(1)).map((n) => `ccx login ${n}`),
  };
}

/**
 * Cap state: informational, unless nothing is left to run on.
 *
 * "Left to run on" counts the accounts that could ACTUALLY start a session, not
 * the enabled ones. An account whose login the token endpoint has refused is
 * still enabled and cannot be used, so counting it hid the situation this check
 * exists for: every usable account capped while a couple of dead profiles made
 * the total look healthy. That is exactly the state it reported "ok" in.
 */
export function auditCaps(context: CliContext): DoctorCheck {
  const name = 'caps';
  const now = Date.now();
  const active = loadLedger(context.ctx).caps.filter((c) => c.capUntil && c.capUntil > now);
  if (active.length === 0) return { name, ok: true, detail: 'no accounts marked capped' };

  const enabled = listAccounts(context.ctx).filter((a) => a.enabled);
  const usable = enabled.filter((a) => hasWorkingLogin(a.dir, context.ctx));
  const isCapped = (account: { name: string }): boolean =>
    active.some((c) => c.account === account.name);
  const list = active
    .map((c) => `${c.account} (${Math.max(1, Math.round(((c.capUntil ?? now) - now) / 60000))}m left)`)
    .join(', ');

  if (usable.length > 0 && usable.every(isCapped)) {
    const needSignIn = enabled.filter((a) => !usable.includes(a)).map((a) => a.name);
    return {
      name,
      ok: false,
      detail:
        `every account you can actually use is capped: ${list}` +
        (needSignIn.length
          ? `. The rest need signing in first: ${needSignIn.join(', ')}`
          : ''),
      ...(needSignIn.length ? { fix: needSignIn.map((n) => `ccx login ${n}`) } : {}),
    };
  }
  return { name, ok: true, detail: `capped: ${list}` };
}

/** Informational: report which installed editors are pointed at ccx. */
export function auditEditor(context: CliContext): DoctorCheck {
  const editors = detectEditors(context.ctx);
  if (editors.length === 0) {
    return { name: 'editor', ok: true, detail: 'no Cursor or VS Code found' };
  }
  const target = editorTargetAccount(context);
  const unset = editors.filter((e) => readEditorEnvVar(e, 'CLAUDE_CONFIG_DIR', context.ctx) === null);
  if (unset.length === editors.length) {
    return {
      name: 'editor',
      ok: true,
      note: true,
      detail: `${editors.join(' and ')} not set up to follow your account`,
      fix: ['ccx on'],
    };
  }
  const following = target ? `following "${target.name}"` : 'set up';
  return {
    name: 'editor',
    ok: true,
    detail: unset.length === 0 ? `${editors.join(' and ')} ${following}` : `${following}; ${unset.join(', ')} not set up`,
    ...(unset.length > 0 ? { fix: ['ccx on'], note: true } : {}),
  };
}

/**
 * Can Claude run the Desktop handoff hooks? They name a node and a ccx by
 * path, and Claude runs them in every session, so a ccx moved or removed since
 * shows up as a broken hook everywhere.
 */
function auditDesktopHooks(context: CliContext): DoctorCheck | null {
  const when = readInstalledHandoff(context.ctx);
  if (when === 'off') return null;
  const problem = installedHooksProblem(context.ctx);
  return problem
    ? {
        name: 'desktop-hooks',
        ok: false,
        detail: `the Claude Desktop hooks cannot run: ${problem}`,
        fix: ['ccx on'],
      }
    : { name: 'desktop-hooks', ok: true, detail: `Desktop conversations move on: ${when}` };
}

/**
 * Page routing: its hooks are in Claude's settings exactly while it is on, can
 * run, and the home account is one of the accounts. Null when it is off and
 * nothing of it is installed, which is how most setups are.
 */
export function auditArtifactHooks(context: CliContext): DoctorCheck | null {
  const { home, updates } = context.config.artifacts;
  const on = routingOn(context.config.artifacts);
  // Setting it again writes the hooks as the settings call for, pointed at
  // this ccx, and touches nothing else: ccx on would also put back what a
  // ccx off took out. A home that is no account cannot be set again.
  let homeKnown = false;
  try {
    homeKnown = home !== null && getAccount(home, context.ctx) !== undefined;
  } catch {
    /* an unreadable account list is the accounts check's to report */
  }
  const reapply = homeKnown
    ? `ccx config artifacts.home ${home}`
    : updates === 'owner'
      ? 'ccx config artifacts.updates owner'
      : 'ccx config artifacts.home <account>';
  let file: string;
  try {
    file = settingsPath(context.ctx);
  } catch {
    return on
      ? { name: 'page-routing', ok: false, detail: 'could not find your Claude settings folder, so page routing cannot be checked' }
      : null;
  }
  const read = readSettings(file);
  if (!read.ok) {
    // ccx on refuses to rewrite a file that does not parse, so it is no fix here.
    return on
      ? {
          name: 'page-routing',
          ok: false,
          detail: `${file} is not valid JSON, so the page routing hooks cannot be checked or installed; fix that file, then run ${reapply}`,
        }
      : null;
  }
  const settings = read.settings;
  const installed = artifactHooksInstalled(settings);
  if (!on) {
    if (JSON.stringify(withoutArtifactHooks(settings)) === JSON.stringify(settings)) return null;
    return {
      name: 'page-routing',
      ok: false,
      detail: 'page routing is off, but its hooks are still in your Claude settings',
      fix: ['ccx config artifacts.updates off'],
    };
  }
  const problem = !installed
    ? 'page routing is on, but its hooks are not in your Claude settings, so nothing is routed'
    : (() => {
        const broken = artifactHooksProblem(settings);
        return broken ? `the page routing hooks cannot run: ${broken}` : null;
      })();
  if (problem) return { name: 'page-routing', ok: false, detail: problem, fix: [reapply] };
  if (home !== null && !getAccount(home, context.ctx)) {
    return {
      name: 'page-routing',
      ok: false,
      detail: `new pages are to be published as "${home}", which is not an account, so they are refused`,
      fix: ['ccx config artifacts.home <account>'],
    };
  }
  const what = [
    ...(home !== null ? [`new pages are published as "${home}"`] : []),
    ...(updates === 'owner' ? ['a page is changed as the account that owns it'] : []),
  ];
  return { name: 'page-routing', ok: true, detail: what.join('; ') };
}

export async function runDoctor(
  context: CliContext,
  deps: DoctorDeps = {},
): Promise<{ checks: DoctorCheck[]; ok: boolean }> {
  const trackedFiles = (deps.gitTrackedFiles ?? defaultTrackedFiles)();
  const checks = [
    auditConfig(context),
    ...auditShells(context, deps),
    auditStatusline(context),
    auditSharedHistory(context),
    auditSessionAccount({
      accounts: listAccounts(context.ctx),
      leases: liveLeases(context.ctx),
    }),
    await auditAccounts(context),
    auditSharedLogins(context),
    await auditIdentities(context, deps),
    auditCaps(context),
    auditGitSafety(trackedFiles),
    auditRealClaude(context, deps),
    auditEditor(context),
    await auditBrowserPort(context, deps),
    ...[await auditKeepalive(context, deps), auditDesktopHooks(context), auditArtifactHooks(context)].filter(
      (c): c is DoctorCheck => c !== null,
    ),
  ];
  return { checks, ok: checks.every((c) => c.ok) };
}

/** Human-friendly names, so the report reads like sentences rather than keys. */
const LABELS: Record<string, string> = {
  config: 'config',
  'terminal-shim': 'terminal',
  statusline: 'status line',
  'shared-history': 'history',
  'session-account': 'session',
  accounts: 'accounts',
  'account-identity': 'identity',
  'separate-logins': 'separate logins',
  caps: 'limits',
  'git-safety': 'git safety',
  'real-claude': 'claude',
  editor: 'editor',
  'browser-debug-port': 'browser',
  keepalive: 'keepalive',
  'desktop-hooks': 'Claude Desktop',
  'page-routing': 'pages',
};

/**
 * Print the doctor report and return 0 when all checks pass, 1 otherwise.
 * With `fix`, first repair what ccx can repair by itself; the report then says
 * how things are after it.
 */
export async function doctorCommand(
  context: CliContext,
  deps: DoctorDeps = {},
  options: { fix?: boolean } = {},
): Promise<number> {
  if (options.fix) repairClaudeIfBroken(context, deps);
  const { checks, ok } = await runDoctor(context, deps);
  const color = process.stdout.isTTY === true && !context.json;

  if (context.json) {
    context.out(JSON.stringify({ schemaVersion: 1, ok, checks }, null, 2));
    return ok ? 0 : 1;
  }

  const labelFor = (check: DoctorCheck): string => check.label ?? LABELS[check.name] ?? check.name;
  const width = Math.max(...checks.map((c) => labelFor(c).length));

  context.out('');
  context.out(`${paint('claude-auto-switch', codes.bold, color)}  ${paint('checkup', codes.dim, color)}`);
  context.out('');

  for (const check of checks) {
    // Three states, because "fine but worth knowing" is not a failure: a green
    // dot for healthy, yellow for an optional thing that is off, red for broken.
    const mark = !check.ok
      ? paint('✗', codes.red, color)
      : check.note
        ? paint('●', codes.yellow, color)
        : paint('●', codes.green, color);
    const label = labelFor(check).padEnd(width);
    const detail = check.ok ? paint(check.detail, codes.dim, color) : check.detail;
    context.out(`  ${mark} ${paint(label, codes.bold, color && !check.ok)}  ${detail}`);
  }

  const fixes = [...new Set(checks.flatMap((c) => c.fix ?? []))];
  context.out('');
  if (ok && fixes.length === 0) {
    context.out(`  ${paint('everything is in order', codes.green, color)}`);
  } else if (ok) {
    context.out(`  ${paint('nothing is broken. optional next steps:', codes.dim, color)}`);
    for (const fix of fixes) context.out(`    ${paint(fix, codes.cyan, color)}`);
  } else {
    const broken = checks.filter((c) => !c.ok);
    context.out(
      `  ${paint(`${broken.length} problem${broken.length === 1 ? '' : 's'} found:`, codes.red, color)}`,
    );
    if (fixes.length > 0) {
      for (const fix of fixes) context.out(`    ${paint(fix, codes.cyan, color)}`);
    } else {
      // Nothing scripted can fix these, so at least name them plainly.
      for (const check of broken) context.out(`    ${labelFor(check)}: ${check.detail}`);
    }
  }
  context.out('');
  return ok ? 0 : 1;
}
