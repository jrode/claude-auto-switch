import { describe, it, expect } from 'vitest';
import { renewOneAtATime } from './renew-one-at-a-time.js';
import type { RefreshOutcome } from './oauth-refresh.js';

/** Renewals that finish when told to, counting how often each was started. */
function controlledRenewals(): {
  renewal: (name: string) => () => Promise<RefreshOutcome>;
  started: Map<string, number>;
  finish: (name: string, outcome: RefreshOutcome) => void;
  fail: (name: string, error: Error) => void;
} {
  const started = new Map<string, number>();
  const pending = new Map<string, { resolve: (o: RefreshOutcome) => void; reject: (e: Error) => void }>();
  return {
    started,
    renewal: (name) => () => {
      started.set(name, (started.get(name) ?? 0) + 1);
      return new Promise((resolve, reject) => pending.set(name, { resolve, reject }));
    },
    finish: (name, outcome) => pending.get(name)?.resolve(outcome),
    fail: (name, error) => pending.get(name)?.reject(error),
  };
}

describe('renewing a login one at a time', () => {
  it('hands a second caller the renewal already under way, not a second one', async () => {
    const r = controlledRenewals();
    const renew = renewOneAtATime();
    const first = renew('login B', r.renewal('first'));
    const second = renew('login B', r.renewal('second'));
    r.finish('first', { status: 'refreshed' });
    expect(await first).toEqual({ status: 'refreshed' });
    // Marked, so the second caller does not report the same renewal again.
    expect(await second).toEqual({ status: 'refreshed', alreadyKnown: true });
    expect([...r.started]).toEqual([['first', 1]]);
  });

  it('renews different logins side by side', () => {
    const r = controlledRenewals();
    const renew = renewOneAtATime();
    void renew('login B', r.renewal('B'));
    void renew('login C', r.renewal('C'));
    expect([...r.started]).toEqual([
      ['B', 1],
      ['C', 1],
    ]);
  });

  it('renews again once the last renewal is over, whether it worked or not', async () => {
    const r = controlledRenewals();
    const renew = renewOneAtATime();
    const first = renew('login B', r.renewal('first'));
    r.fail('first', new Error('offline'));
    await expect(first).rejects.toThrow('offline');
    const again = renew('login B', r.renewal('again'));
    r.finish('again', { status: 'not-needed' });
    expect(await again).toEqual({ status: 'not-needed' });
    expect([...r.started]).toEqual([
      ['first', 1],
      ['again', 1],
    ]);
  });
});
