/**
 * Checking an account's login BEFORE starting a session on it.
 *
 * Without this, ccx will happily copy a login that expired hours ago into a new
 * session and launch, and the first thing you see is Claude saying you are
 * logged out. That happened for real: an account's stored login had been dead
 * for five and a half hours, ccx started a session on it and said nothing.
 *
 * Two things are wrong with that, and both are fixed here. A login that is
 * merely expired can usually be renewed, and renewing is SAFE at this exact
 * moment because we are about to start using the account and nothing else holds
 * it yet. A login that cannot be renewed is genuinely finished, and the only
 * useful thing ccx can do is say so, by name, with the command that fixes it,
 * instead of letting Claude present it as a mysterious sign-out.
 */

export type LoginReadiness =
  | { state: 'ready' }
  | { state: 'renewed' }
  | { state: 'needs-login'; detail: string }
  | { state: 'unknown'; detail: string };

export interface PreflightDeps {
  /** True when the account has a credential with real token material. */
  hasLogin: () => boolean;
  /** True when the stored login is expired, or close enough to be renewed now. */
  renewalDue: () => boolean;
  /**
   * Renew the stored login. Only called when one is present and due, or its
   * token was turned away (`rejected` fingerprints that token).
   * `alreadyKnown`: the renewal was another caller's, joined while under way.
   */
  renew: (rejected?: string) => Promise<{ status: string; detail?: string; alreadyKnown?: boolean }>;
  /**
   * For a login not yet due: whether the API turns its token away, as the
   * fingerprint of that token, or null when it does not or cannot be asked.
   * The stored expiry cannot see a revoked login (signed out at claude.ai, or
   * the account put on hold), and starting on one is Claude saying "Please run
   * /login" a moment later.
   */
  turnedAway?: () => Promise<string | null>;
}

/**
 * Make sure the account's login is usable, renewing it if that is all it needs.
 *
 * Never throws and never blocks a launch: an unknown result still starts the
 * session, because being unable to check (offline, say) is not evidence that the
 * login is bad, and refusing to start would be worse than letting Claude try.
 */
export async function ensureLoginUsable(deps: PreflightDeps): Promise<LoginReadiness> {
  if (!deps.hasLogin()) {
    return { state: 'needs-login', detail: 'no stored login' };
  }
  let rejected: string | null = null;
  if (!deps.renewalDue()) {
    // Not being able to ask is not evidence against the login: start as before.
    rejected = deps.turnedAway ? await deps.turnedAway().catch(() => null) : null;
    if (rejected === null) return { state: 'ready' };
  }

  let outcome: { status: string; detail?: string; alreadyKnown?: boolean };
  try {
    outcome = await deps.renew(rejected ?? undefined);
  } catch (err) {
    return { state: 'unknown', detail: (err as Error).message };
  }

  switch (outcome.status) {
    case 'refreshed':
      // Another caller's renewal is that caller's to report and carry across.
      return outcome.alreadyKnown ? { state: 'ready' } : { state: 'renewed' };
    case 'not-needed':
      return { state: 'ready' };
    case 'needs-login':
      return { state: 'needs-login', detail: outcome.detail ?? 'the stored login was rejected' };
    default:
      return { state: 'unknown', detail: outcome.detail ?? 'could not check the login' };
  }
}

/**
 * What to tell the operator, or null when there is nothing worth saying.
 *
 * Deliberately quiet on the ordinary paths: a renewal that worked is normal
 * housekeeping, and announcing it every time would train people to ignore the
 * line that actually matters.
 */
export function readinessMessage(account: string, readiness: LoginReadiness): string | null {
  switch (readiness.state) {
    case 'needs-login':
      return `[ccx] "${account}" needs signing in again (${readiness.detail}). Run: ccx login ${account}`;
    case 'unknown':
      return `[ccx] could not check "${account}"'s login (${readiness.detail}); starting anyway`;
    default:
      return null;
  }
}
