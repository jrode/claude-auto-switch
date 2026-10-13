import type { RefreshOutcome } from './oauth-refresh.js';

/**
 * `renew`, but a login being renewed is not renewed a second time alongside:
 * a caller that asks meanwhile gets the renewal already under way.
 *
 * A renewal spends the login's refresh token, which works once. Two at a time
 * in one process both read that token before either has written the new one,
 * and the second is refused, which reads as a login that needs signing in
 * again. Claude's lock does not keep them apart within one process: it is
 * waited on synchronously, so the first renewal's request cannot finish while
 * the second waits, and the second goes ahead when its two seconds run out. A
 * session renews from several places: its usage refresher, a start, a move in
 * place, a visit for an Artifact call.
 */
export function renewOneAtATime(
  renew: (accountDir: string) => Promise<RefreshOutcome>,
): (accountDir: string) => Promise<RefreshOutcome> {
  const running = new Map<string, Promise<RefreshOutcome>>();
  return (accountDir) => {
    const under = running.get(accountDir);
    if (under) return under;
    const started = renew(accountDir).finally(() => running.delete(accountDir));
    running.set(accountDir, started);
    return started;
  };
}
