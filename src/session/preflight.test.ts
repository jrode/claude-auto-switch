import { describe, it, expect } from 'vitest';
import { ensureLoginUsable, readinessMessage } from './preflight.js';

function deps(over: Partial<Parameters<typeof ensureLoginUsable>[0]> = {}) {
  return {
    hasLogin: () => true,
    renewalDue: () => false,
    renew: () => Promise.resolve({ status: 'refreshed' }),
    ...over,
  };
}

describe('ensureLoginUsable', () => {
  it('does not count a renewal another caller made as one of its own', async () => {
    // Joined while that renewal was under way: it was written down by the
    // caller that made it, and must not be logged again here.
    const r = await ensureLoginUsable(
      deps({
        renewalDue: () => true,
        renew: () => Promise.resolve({ status: 'refreshed', alreadyKnown: true }),
      }),
    );
    expect(r.state).toBe('ready');
  });

  it('does nothing when the login is fine', async () => {
    let renewed = false;
    const r = await ensureLoginUsable(
      deps({
        renew: () => {
          renewed = true;
          return Promise.resolve({ status: 'refreshed' });
        },
      }),
    );
    expect(r.state).toBe('ready');
    expect(renewed).toBe(false); // nothing to do, so nothing touched
  });

  it('renews an expired login rather than starting a session on it', async () => {
    // The bug this exists for: a login that expired hours ago was copied into a
    // new session and launched, and the first thing on screen was "logged out".
    const r = await ensureLoginUsable(deps({ renewalDue: () => true }));
    expect(r.state).toBe('renewed');
  });

  it('says which account needs signing in when the login is finished', async () => {
    const r = await ensureLoginUsable(
      deps({
        renewalDue: () => true,
        renew: () => Promise.resolve({ status: 'needs-login', detail: 'invalid_grant' }),
      }),
    );
    expect(r.state).toBe('needs-login');
    const message = readinessMessage('main', r);
    expect(message).toContain('main');
    expect(message).toContain('invalid_grant');
    expect(message).toContain('ccx login main'); // the exact command that fixes it
  });

  it('reports a profile with no login at all as needing sign-in', async () => {
    const r = await ensureLoginUsable(deps({ hasLogin: () => false }));
    expect(r.state).toBe('needs-login');
    expect(readinessMessage('work', r)).toContain('ccx login work');
  });

  it('starts anyway when the login cannot be checked', async () => {
    // Being unable to check is not evidence the login is bad. Refusing to start
    // over a network blip would be worse than letting Claude try.
    const r = await ensureLoginUsable(
      deps({
        renewalDue: () => true,
        renew: () => Promise.resolve({ status: 'unavailable', detail: 'offline' }),
      }),
    );
    expect(r.state).toBe('unknown');
    expect(readinessMessage('main', r)).toContain('starting anyway');
  });

  it('survives a renewal that throws', async () => {
    const r = await ensureLoginUsable(
      deps({
        renewalDue: () => true,
        renew: () => Promise.reject(new Error('socket hang up')),
      }),
    );
    expect(r.state).toBe('unknown');
  });

  it('stays quiet when everything is normal', async () => {
    // Announcing routine housekeeping trains people to ignore the line that
    // actually matters.
    expect(readinessMessage('main', { state: 'ready' })).toBeNull();
    expect(readinessMessage('main', { state: 'renewed' })).toBeNull();
  });
});

describe('a login whose token was revoked before its stored expiry', () => {
  it('is renewed before the session starts, for the token turned away', async () => {
    const asked: Array<string | undefined> = [];
    const r = await ensureLoginUsable(
      deps({
        turnedAway: () => Promise.resolve('fp'),
        renew: (rejected) => {
          asked.push(rejected);
          return Promise.resolve({ status: 'refreshed' });
        },
      }),
    );
    expect(r.state).toBe('renewed');
    expect(asked).toEqual(['fp']);
  });

  it('needs signing in when the token endpoint refuses it, so the session starts elsewhere', async () => {
    const r = await ensureLoginUsable(
      deps({
        turnedAway: () => Promise.resolve('fp'),
        renew: () => Promise.resolve({ status: 'needs-login', detail: 'invalid_grant' }),
      }),
    );
    expect(r).toEqual({ state: 'needs-login', detail: 'invalid_grant' });
  });

  it('starts as before when the token was not turned away, or that cannot be told', async () => {
    let renewed = 0;
    const renew = () => {
      renewed += 1;
      return Promise.resolve({ status: 'refreshed' });
    };
    expect((await ensureLoginUsable(deps({ turnedAway: () => Promise.resolve(null), renew }))).state).toBe('ready');
    expect((await ensureLoginUsable(deps({ turnedAway: () => Promise.reject(new Error('offline')), renew }))).state).toBe(
      'ready',
    );
    expect(renewed).toBe(0);
  });

  it('is not asked about when the login is due anyway: the renewal answers it', async () => {
    let asked = 0;
    const r = await ensureLoginUsable(
      deps({
        renewalDue: () => true,
        turnedAway: () => {
          asked += 1;
          return Promise.resolve('fp');
        },
      }),
    );
    expect(r.state).toBe('renewed');
    expect(asked).toBe(0);
  });
});
