import { describe, it, expect } from 'vitest';
import { renewOneAtATime } from './renew-one-at-a-time.js';
import type { RefreshOutcome } from './oauth-refresh.js';

/** A renewal that finishes when told to, counting how often it was started per folder. */
function controlledRenewal(): {
  renew: (dir: string, options: unknown) => Promise<RefreshOutcome>;
  started: Map<string, number>;
  finish: (dir: string, outcome: RefreshOutcome) => void;
  fail: (dir: string, error: Error) => void;
} {
  const started = new Map<string, number>();
  const pending = new Map<string, { resolve: (o: RefreshOutcome) => void; reject: (e: Error) => void }>();
  return {
    started,
    renew: (dir) => {
      started.set(dir, (started.get(dir) ?? 0) + 1);
      return new Promise((resolve, reject) => pending.set(dir, { resolve, reject }));
    },
    finish: (dir, outcome) => pending.get(dir)?.resolve(outcome),
    fail: (dir, error) => pending.get(dir)?.reject(error),
  };
}

/** Each folder holds a login of its own, named after it. */
const ownLogin = (dir: string): string => `login of ${dir}`;

describe('renewing a login one at a time', () => {
  it('hands a second caller the renewal already under way, not a second one', async () => {
    const r = controlledRenewal();
    const renew = renewOneAtATime(r.renew, ownLogin);
    const first = renew('/p/B', {});
    const second = renew('/p/B', {});
    r.finish('/p/B', { status: 'refreshed' });
    expect(await first).toEqual({ status: 'refreshed' });
    // Marked, so the second caller does not report the same renewal again.
    expect(await second).toEqual({ status: 'refreshed', alreadyKnown: true });
    expect(r.started.get('/p/B')).toBe(1);
  });

  it('renews one login once when two profile folders hold it', async () => {
    const r = controlledRenewal();
    const renew = renewOneAtATime(r.renew, () => 'the same login');
    const first = renew('/p/B', {});
    const second = renew('/p/B-copy', {});
    r.finish('/p/B', { status: 'refreshed' });
    await Promise.all([first, second]);
    expect([...r.started]).toEqual([['/p/B', 1]]);
  });

  it('renews different logins side by side', () => {
    const r = controlledRenewal();
    const renew = renewOneAtATime(r.renew, ownLogin);
    void renew('/p/B', {});
    void renew('/p/C', {});
    expect([...r.started]).toEqual([
      ['/p/B', 1],
      ['/p/C', 1],
    ]);
  });

  it('keys a folder with no readable login by the folder', () => {
    const r = controlledRenewal();
    const renew = renewOneAtATime(r.renew, () => null);
    void renew('/p/B', {});
    void renew('/p/C', {});
    expect(r.started.size).toBe(2);
  });

  it('renews again once the last renewal is over, whether it worked or not', async () => {
    const r = controlledRenewal();
    const renew = renewOneAtATime(r.renew, ownLogin);
    const first = renew('/p/B', {});
    r.fail('/p/B', new Error('offline'));
    await expect(first).rejects.toThrow('offline');
    const again = renew('/p/B', {});
    r.finish('/p/B', { status: 'not-needed' });
    expect(await again).toEqual({ status: 'not-needed' });
    expect(r.started.get('/p/B')).toBe(2);
  });
});
