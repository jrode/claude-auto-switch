import type { RefreshOutcome } from './oauth-refresh.js';

/**
 * Runs renewals one at a time per login: a renewal asked for while one of the
 * same login is under way gets that renewal's outcome, marked `alreadyKnown`
 * so that it is reported once, instead of being run again. `login` names the
 * login (its refresh token's fingerprint), so two profiles holding one login
 * share one renewal.
 *
 * A renewal spends the login's refresh token, which works once. Two at a time
 * in one process both read that token before either has written the new one,
 * and the second is refused, which reads as a login that needs signing in
 * again. Claude's lock does not keep them apart within one process. A session
 * renews from several places: its usage refresher, a start, a move in place,
 * a visit for an Artifact call.
 */
export function renewOneAtATime(): (login: string, renew: () => Promise<RefreshOutcome>) => Promise<RefreshOutcome> {
  const running = new Map<string, Promise<RefreshOutcome>>();
  return (login, renew) => {
    const under = running.get(login);
    if (under) return under.then((outcome) => ({ ...outcome, alreadyKnown: true as const }));
    const started = renew().finally(() => running.delete(login));
    running.set(login, started);
    return started;
  };
}
