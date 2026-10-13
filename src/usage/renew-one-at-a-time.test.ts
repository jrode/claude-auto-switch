import { describe, it, expect } from 'vitest';
import { renewOneAtATime } from './renew-one-at-a-time.js';
import type { RefreshOutcome } from './oauth-refresh.js';

/** A renewal that finishes when told to, counting how often it was started per folder. */
function controlledRenewal(): {
  renew: (dir: string) => Promise<RefreshOutcome>;
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

describe('renewing a login one at a time', () => {
  it('hands a second caller the renewal already under way, not a second one', async () => {
    const r = controlledRenewal();
    const renew = renewOneAtATime(r.renew);
    const first = renew('/p/B');
    const second = renew('/p/B');
    r.finish('/p/B', { status: 'refreshed' });
    expect(await first).toEqual({ status: 'refreshed' });
    expect(await second).toEqual({ status: 'refreshed' });
    expect(r.started.get('/p/B')).toBe(1);
  });

  it('renews different logins side by side', () => {
    const r = controlledRenewal();
    const renew = renewOneAtATime(r.renew);
    void renew('/p/B');
    void renew('/p/C');
    expect([...r.started]).toEqual([
      ['/p/B', 1],
      ['/p/C', 1],
    ]);
  });

  it('renews again once the last renewal is over, whether it worked or not', async () => {
    const r = controlledRenewal();
    const renew = renewOneAtATime(r.renew);
    const first = renew('/p/B');
    r.fail('/p/B', new Error('offline'));
    await expect(first).rejects.toThrow('offline');
    const again = renew('/p/B');
    r.finish('/p/B', { status: 'not-needed' });
    expect(await again).toEqual({ status: 'not-needed' });
    expect(r.started.get('/p/B')).toBe(2);
  });
});
