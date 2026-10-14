import type { RefreshOutcome } from './oauth-refresh.js';

/**
 * `renew`, but a login being renewed is not renewed a second time alongside:
 * a caller that asks meanwhile gets the renewal already under way, marked
 * `alreadyKnown` so that it is reported once.
 *
 * Keyed by `loginOf(accountDir)`, which names the login a folder holds (its
 * refresh token's fingerprint), so two profiles holding one login share one
 * renewal; a folder with no readable login is keyed by itself.
 *
 * A renewal spends the login's refresh token, which works once. Two at a time
 * in one process both read that token before either has written the new one,
 * and the second is refused, which reads as a login that needs signing in
 * again. Claude's lock does not keep them apart within one process: it is
 * waited on synchronously, so the first renewal's request cannot finish while
 * the second waits. A session renews from several places: its usage
 * refresher, a start, a move in place, a visit for an Artifact call.
 */
export function renewOneAtATime<O>(
  renew: (accountDir: string, options: O) => Promise<RefreshOutcome>,
  loginOf: (accountDir: string) => string | null,
): (accountDir: string, options: O) => Promise<RefreshOutcome> {
  const running = new Map<string, Promise<RefreshOutcome>>();
  return (accountDir, options) => {
    const key = loginOf(accountDir) ?? `folder:${accountDir}`;
    const under = running.get(key);
    if (under) return under.then((outcome) => ({ ...outcome, alreadyKnown: true as const }));
    const started = renew(accountDir, options).finally(() => running.delete(key));
    running.set(key, started);
    return started;
  };
}
