import { spawnSync } from 'node:child_process';
import type { PathCtx } from '../config/paths.js';

/** What one PowerShell edition says about itself. */
export interface PowerShellFacts {
  /** `$PROFILE.CurrentUserAllHosts`: read by every host, console, editors and ISE alike. */
  allHosts: string;
  /** `$PROFILE.CurrentUserCurrentHost` for the console host: where older versions of ccx put the shim. */
  currentHost: string;
  /** The execution policy in effect, as `Get-ExecutionPolicy` names it. */
  policy: string;
  /** True when Group Policy sets the policy, so only an administrator can change it. */
  policyFromGroupPolicy: boolean;
}

export type PowerShellExe = 'pwsh' | 'powershell';

/**
 * A PowerShell expression printing the string `expr` as Base64 of its UTF-8
 * bytes. PowerShell writes to a pipe in the console's code page, which turns a
 * path with a name like José into a different path; Base64 is ASCII in any.
 */
export function utf8Base64(expr: string): string {
  return `[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string](${expr})))`;
}

/**
 * Asked of each edition in one start, each value on a line of its own named
 * after it, so a warning or a statement that fails cannot put one value in
 * another's place. No double quotes, so it reaches PowerShell intact however
 * Windows splits the command line, and no -EncodedCommand, which security
 * software treats as a warning sign.
 */
const FACTS_SCRIPT = [
  `'allHosts=' + ${utf8Base64('$PROFILE.CurrentUserAllHosts')}`,
  `'currentHost=' + ${utf8Base64('$PROFILE.CurrentUserCurrentHost')}`,
  // Named with its module, which is loaded directly rather than searched for.
  "'policy=' + [string](Microsoft.PowerShell.Security\\Get-ExecutionPolicy)",
  "'machinePolicy=' + [string](Microsoft.PowerShell.Security\\Get-ExecutionPolicy -Scope MachinePolicy)",
  "'userPolicy=' + [string](Microsoft.PowerShell.Security\\Get-ExecutionPolicy -Scope UserPolicy)",
].join('; ');

/** How each edition is started to answer FACTS_SCRIPT: no profile of its own runs. */
export const FACTS_ARGS = ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', FACTS_SCRIPT];

/** Read the answer to FACTS_SCRIPT; null when it does not name two profiles. */
export function parsePowerShellFacts(out: string): PowerShellFacts | null {
  const values = new Map<string, string>();
  for (const line of out.split(/\r?\n/)) {
    const named = /^(\w+)=(.*)$/.exec(line.trim());
    if (named) values.set(named[1] as string, named[2] as string);
  }
  const path = (key: string) => Buffer.from(values.get(key) ?? '', 'base64').toString('utf8');
  const [allHosts, currentHost] = [path('allHosts'), path('currentHost')];
  const isProfile = (p: string) => p.toLowerCase().endsWith('.ps1');
  if (!isProfile(allHosts) || !isProfile(currentHost)) return null;
  return {
    allHosts,
    currentHost,
    policy: values.get('policy') || 'Unknown',
    policyFromGroupPolicy: ['machinePolicy', 'userPolicy'].some((k) => {
      const set = values.get(k);
      return !!set && set !== 'Undefined';
    }),
  };
}

/**
 * What a PowerShell inherits from the session ccx runs in, and must not:
 * - PSModulePath: started from PowerShell 7, Windows PowerShell tries to load
 *   PowerShell 7's modules from it and fails, even for its own
 *   Get-ExecutionPolicy. Without it, each edition builds its own.
 * - PSExecutionPolicyPreference: the policy a session set for itself, as
 *   `-ExecutionPolicy Bypass` does. The reading must be a new window's.
 */
const SESSION_ONLY = new Set(['PSMODULEPATH', 'PSEXECUTIONPOLICYPREFERENCE']);

/** The environment to start a PowerShell with: this one, less what is the session's own. */
export function envForPowerShell(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !SESSION_ONLY.has(name.toUpperCase())));
}

/**
 * Ask one edition where its profiles are and what its execution policy is.
 * Asked rather than computed: OneDrive often moves the Documents folder, and
 * only PowerShell knows where it ended up. Null when the edition is not
 * installed or did not answer in time.
 */
export function queryPowerShell(exe: PowerShellExe): PowerShellFacts | null {
  // Judged by what it printed rather than by its exit code: the paths are
  // what ccx uses, and they either parse or they do not.
  const r = spawnSync(exe, FACTS_ARGS, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    // Usually under a second; a slow start that is cut short loses the policy.
    timeout: 15_000,
    windowsHide: true,
    env: envForPowerShell(process.env),
  });
  return typeof r.stdout === 'string' ? parsePowerShellFacts(r.stdout) : null;
}

/**
 * Should we ask the real PowerShell where its profile is?
 *
 * Only when nothing has been injected. Asking PowerShell means asking the real
 * machine, which cannot know about a context the caller made up: a run pointed
 * at a temporary home would be handed the developer's own profile and then
 * edit it. Injecting a platform OR an environment means "this is the machine",
 * so we stay inside what we were given.
 *
 * Exported as its own predicate so this rule is tested on every host, not only
 * on Windows.
 */
export function shouldAskPowerShell(c: PathCtx, host: NodeJS.Platform): boolean {
  return host === 'win32' && c.platform === undefined && c.env === undefined;
}
