import { execFileSync } from 'node:child_process';
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
 * Asked of each edition in one start. No double quotes, so it reaches
 * PowerShell intact however Windows splits the command line, and no
 * -EncodedCommand, which security software treats as a warning sign.
 */
const FACTS_SCRIPT = [
  '$PROFILE.CurrentUserAllHosts',
  '$PROFILE.CurrentUserCurrentHost',
  '[string](Get-ExecutionPolicy)',
  '[string](Get-ExecutionPolicy -Scope MachinePolicy)',
  '[string](Get-ExecutionPolicy -Scope UserPolicy)',
].join('; ');

/** Read the answer to FACTS_SCRIPT; null when it is not one. */
export function parsePowerShellFacts(out: string): PowerShellFacts | null {
  const [allHosts, currentHost, policy, machine, user] = out.split(/\r?\n/).map((l) => l.trim());
  const isProfile = (p: string | undefined): p is string => !!p && p.toLowerCase().endsWith('.ps1');
  if (!isProfile(allHosts) || !isProfile(currentHost)) return null;
  return {
    allHosts,
    currentHost,
    policy: policy || 'Unknown',
    policyFromGroupPolicy: [machine, user].some((p) => !!p && p !== 'Undefined'),
  };
}

/**
 * Ask one edition where its profiles are and what its execution policy is.
 * Asked rather than computed: OneDrive often moves the Documents folder, and
 * only PowerShell knows where it ended up. Null when the edition is not
 * installed or did not answer in time.
 */
export function queryPowerShell(exe: PowerShellExe): PowerShellFacts | null {
  try {
    const out = execFileSync(exe, ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', FACTS_SCRIPT], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 8000,
      windowsHide: true,
    });
    return parsePowerShellFacts(out);
  } catch {
    return null;
  }
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
