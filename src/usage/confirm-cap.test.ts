import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { confirmCap, confirmSessionCap, usageAnswer } from './confirm-cap.js';
import type { LimitProbeResult } from './limit-probe.js';

const probing = (result: LimitProbeResult, seen?: string[]) => (file: string) => {
  seen?.push(file);
  return Promise.resolve(result);
};

describe('confirmCap', () => {
  it('asks the ACCOUNT being capped, not the shared session directory', async () => {
    // The production failure: with two runs sharing one session directory, an
    // exhausted account answered for a healthy one and the healthy one took the
    // cap. Five accounts went down in 87 seconds that way.
    const asked: string[] = [];
    await confirmCap('/profiles/second', 'limit reached', {
      probe: probing({ verdict: 'allowed' }, asked),
      sessionCredentials: '/session/.credentials.json',
    });
    expect(asked[0]).toContain('second');
    expect(asked[0]).not.toContain('session');
  });

  it('records a Fable-only limit AS Fable, so the account still runs on Opus', async () => {
    // Dropping the scope is what turned "Fable is spent" into "this account is
    // unusable", and then into "every account has hit its limit".
    const decision = await confirmCap('/profiles/second', "you've reached your Fable 5 limit", {
      probe: probing({
        verdict: 'limited',
        limitedModel: 'Fable',
        fiveHour: 0.03,
        sevenDay: 0.74,
        models: [{ name: 'Fable', utilization: 1, resetsAt: 999 }],
      }),
    });
    expect(decision.limited).toBe(true);
    expect(decision.model).toBe('Fable');
    expect(decision.resetAt).toBe(999);
  });

  it('records a genuinely spent account as account-wide, with no model', async () => {
    const decision = await confirmCap('/profiles/main', 'usage limit reached', {
      probe: probing({ verdict: 'limited', fiveHour: 0.0, sevenDay: 1, sevenDayReset: 4242 }),
    });
    expect(decision.limited).toBe(true);
    expect(decision.model).toBeUndefined();
    expect(decision.resetAt).toBe(4242);
  });

  it('uses the FIVE-HOUR reset when that is the window that is spent', async () => {
    // Capping until the weekly reset when only the five-hour window is gone
    // would park a working account for days.
    const decision = await confirmCap('/profiles/contactss', 'limit', {
      probe: probing({
        verdict: 'limited',
        fiveHour: 1,
        sevenDay: 0.2,
        fiveHourReset: 111,
        sevenDayReset: 999999,
      }),
    });
    expect(decision.resetAt).toBe(111);
  });

  it('REFUSES to cap when the API does not confirm it', async () => {
    // Cap-looking text is a trigger, never a verdict: resumed conversations
    // replay old limit messages, and code on screen can talk about rate limits.
    for (const verdict of ['allowed', 'unknown'] as const) {
      const decision = await confirmCap('/profiles/second', 'rate limit', {
        probe: probing({ verdict }),
      });
      expect(decision.limited, verdict).toBe(false);
    }
  });

  it('refuses when the endpoint cannot be reached at all', async () => {
    // Not proven must never become a cap. A real limit will trigger this again;
    // a healthy account wrongly capped stays broken for hours.
    const decision = await confirmCap('/profiles/second', 'limit', {
      probe: probing({ verdict: 'unknown', detail: 'status 429', retryAfterMs: 5000 }),
    });
    expect(decision.limited).toBe(false);
    expect(decision.detail).toBe('status 429');
  });

  it('refuses when there is no credential to ask', async () => {
    const decision = await confirmCap(null, 'limit', { probe: probing({ verdict: 'limited' }) });
    expect(decision.limited).toBe(false);
  });
});

describe('whose login answers for an interactive session', () => {
  const probing = (result: LimitProbeResult) => {
    const asked: string[] = [];
    return {
      asked,
      probe: (file: string) => {
        asked.push(file);
        return Promise.resolve(result);
      },
    };
  };

  function loginDir(name: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), `cas-cap-${name}-`));
    writeFileSync(
      path.join(dir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: `tok-${name}`, refreshToken: `rt-${name}` } }),
    );
    return dir;
  }

  it('asks the SESSION credential: that login rendered the banner on screen', async () => {
    // The deadlock this ends: a session signed in as somebody else showed that
    // account's limit banner, the believed profile answered "not capped", and
    // the switch never came. With one directory per session, the session's own
    // login IS the identity on screen; the profile is only a guess.
    const session = loginDir('session');
    const profile = loginDir('profile');
    const { asked, probe } = probing({ verdict: 'limited', fiveHour: 1, fiveHourReset: 42 });
    const decision = await confirmSessionCap(
      { sessionDir: session, believedDir: profile },
      'limit reached',
      { probe },
    );
    expect(decision.limited).toBe(true);
    expect(decision.askedOf).toBe('session');
    expect(asked[0]).toContain(session);
  });

  it('falls back to the believed profile when the session has no usable login', async () => {
    // A signed-out session dir holds a credential file with EMPTY tokens; the
    // profile is the better guess then, and the decision says which was asked.
    const session = mkdtempSync(path.join(tmpdir(), 'cas-cap-empty-'));
    writeFileSync(
      path.join(session, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: '' } }),
    );
    const profile = loginDir('believed');
    const { asked, probe } = probing({ verdict: 'allowed' });
    const decision = await confirmSessionCap(
      { sessionDir: session, believedDir: profile },
      'limit reached',
      { probe },
    );
    expect(decision.askedOf).toBe('profile');
    expect(asked[0]).toContain(profile);
  });

  it('refuses outright when neither side has a credential to ask', async () => {
    const session = mkdtempSync(path.join(tmpdir(), 'cas-cap-none-'));
    const { asked, probe } = probing({ verdict: 'limited', fiveHour: 1 });
    const decision = await confirmSessionCap(
      { sessionDir: session, believedDir: null },
      'limit reached',
      { probe },
    );
    expect(decision.limited).toBe(false);
    expect(asked).toHaveLength(0);
  });
});

describe('a probe that fails outright', () => {
  const rejecting = () => Promise.reject(new Error('fetch aborted'));

  it('is an unconfirmed cap for confirmCap, never an exception', async () => {
    // Headless rotation awaits this with no catch of its own, so a network
    // failure escaping here took the whole run down. The rule stands: the
    // least proven case of all must not become a cap, or a crash.
    const decision = await confirmCap('/profiles/any', 'limit reached', { probe: rejecting });
    expect(decision.limited).toBe(false);
    expect(decision.detail).toBe('could not confirm usage limit');
  });

  it('is an unconfirmed cap for confirmSessionCap too, keeping askedOf', async () => {
    const session = mkdtempSync(path.join(tmpdir(), 'cas-cap-reject-'));
    writeFileSync(
      path.join(session, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'tok', refreshToken: 'rt' } }),
    );
    const decision = await confirmSessionCap(
      { sessionDir: session, believedDir: null },
      'limit reached',
      { probe: rejecting },
    );
    expect(decision.limited).toBe(false);
    expect(decision.askedOf).toBe('session');
  });
});

describe('a spent window for a model this session is NOT running', () => {
  const probing = (result: LimitProbeResult) => () => Promise.resolve(result);

  it('is not a limit on this session', async () => {
    // The ten-rotations-in-six-minutes churn. Once ccx moved to Opus, the
    // account's Fable stayed at 100% for the rest of the week, so every
    // replayed cap message re-confirmed it and killed the session in seconds.
    const decision = await confirmCap('/profiles/main', 'Fable limit reached', {
      modelInUse: 'opus',
      probe: probing({
        verdict: 'limited',
        limitedModel: 'Fable',
        fiveHour: 0.13,
        sevenDay: 0.55,
        models: [
          { name: 'Fable', utilization: 1 },
          { name: 'Opus', utilization: 0.2 },
        ],
      }),
    });
    expect(decision.limited).toBe(false);
    expect(decision.detail).toContain('running opus');
    // Marked as a refusal ccx could not verify. It is the one kind that can be
    // wrong about a limit that is really happening, so the caller counts them
    // and stops trusting the pattern rather than refusing forever.
    expect(decision.unverified).toBe(true);
  });

  it('marks a limit no window explains as unverified, not merely allowed', async () => {
    // The probe says limited and every window ccx can read still has room.
    // That is not proof of a cap, and this file never invents one, but it is
    // also not proof of room, and recording which it was is what lets the
    // session escape a limit the API cannot account for.
    const decision = await confirmCap('/profiles/main', 'limit reached', {
      modelInUse: 'opus',
      probe: probing({ verdict: 'limited', fiveHour: 0.2, sevenDay: 0.3, models: [] }),
    });
    expect(decision.limited).toBe(false);
    expect(decision.unverified).toBe(true);
  });

  it('does NOT mark an ordinary refusal as unverified', async () => {
    // A conversation that merely talks about rate limits. The API positively
    // reported room, so there is nothing unexplained and nothing to escalate.
    const decision = await confirmCap('/profiles/main', 'talking about rate limits', {
      modelInUse: 'opus',
      probe: probing({ verdict: 'allowed', fiveHour: 0.2, sevenDay: 0.3 }),
    });
    expect(decision.limited).toBe(false);
    expect(decision.unverified).toBeUndefined();
  });

  it('IS a limit when it names the model in use', async () => {
    const decision = await confirmCap('/profiles/main', 'Fable limit reached', {
      modelInUse: 'claude-fable-5',
      probe: probing({
        verdict: 'limited',
        limitedModel: 'Fable',
        fiveHour: 0.13,
        models: [{ name: 'Fable', utilization: 1, resetsAt: 4242 }],
      }),
    });
    expect(decision.limited).toBe(true);
    expect(decision.model).toBe('Fable');
    expect(decision.resetAt).toBe(4242);
  });

  it('still caps account-wide, whatever model is in use', async () => {
    // An account-wide window makes every model unusable, so the model in use
    // is beside the point.
    const decision = await confirmCap('/profiles/main', 'limit reached', {
      modelInUse: 'opus',
      probe: probing({ verdict: 'limited', fiveHour: 1, fiveHourReset: 999, sevenDay: 0.4 }),
    });
    expect(decision.limited).toBe(true);
    expect(decision.model).toBeUndefined();
  });

  it('keeps the old behaviour when nothing pins a model', async () => {
    // A session with nothing pinned is running the default, which is the
    // model a spent window most likely refers to.
    const decision = await confirmCap('/profiles/main', 'Fable limit reached', {
      probe: probing({
        verdict: 'limited',
        limitedModel: 'Fable',
        fiveHour: 0.1,
        models: [{ name: 'Fable', utilization: 1 }],
      }),
    });
    expect(decision.limited).toBe(true);
    expect(decision.model).toBe('Fable');
  });
});

describe('how WIDE a confirmed limit really is', () => {
  const probing = (result: LimitProbeResult) => () => Promise.resolve(result);

  it('caps the MODEL, not the account, when no account window is spent', async () => {
    // The production failure, twice in one day. The account-wide branch never
    // checked that an account-wide window was actually spent: any "limited"
    // verdict without a named model became an account-wide cap. An account with
    // 2% of its five-hour window used and 57% of its week was taken out of
    // rotation for five hours because its Fable was gone.
    const decision = await confirmCap('/profiles/maxed', 'limit reached', {
      probe: probing({
        verdict: 'limited',
        fiveHour: 0.02,
        sevenDay: 0.57,
        models: [{ name: 'Fable', utilization: 1, resetsAt: 777 }],
      }),
    });
    expect(decision.limited).toBe(true);
    expect(decision.model).toBe('Fable');
    expect(decision.resetAt).toBe(777);
  });

  it('uses the spent window’s own reset, not a fixed guess', async () => {
    // phx was capped for five hours by the default backoff when its five-hour
    // window reopened in sixteen minutes, so the only account with Fable left
    // stayed locked out long after it had recovered.
    const decision = await confirmCap('/profiles/phx', 'limit reached', {
      probe: probing({
        verdict: 'limited',
        fiveHour: 1,
        fiveHourReset: 555,
        sevenDay: 0.44,
        sevenDayReset: 99999,
      }),
    });
    expect(decision.limited).toBe(true);
    expect(decision.model).toBeUndefined();
    expect(decision.resetAt).toBe(555);
  });

  it('caps the ACCOUNT when a named model arrives with a spent account window', async () => {
    // The rendered text names a model, so the probe answers with it, but the
    // five-hour window is spent too: every model is unusable. Scoping to the
    // model would leave the account in rotation with nothing to run on.
    const decision = await confirmCap('/profiles/maxed', 'Fable limit reached', {
      probe: probing({
        verdict: 'limited',
        limitedModel: 'Fable',
        fiveHour: 1,
        fiveHourReset: 4242,
        sevenDay: 0.6,
        models: [{ name: 'Fable', utilization: 1, resetsAt: 9999 }],
      }),
    });
    expect(decision.limited).toBe(true);
    expect(decision.model).toBeUndefined();
    expect(decision.resetAt).toBe(4242);
  });

  it('refuses to cap when nothing measurable is spent', async () => {
    // "Limited" with every window showing room is not something to act on, and
    // guessing account-wide is the most expensive guess available.
    const decision = await confirmCap('/profiles/main', 'limit reached', {
      probe: probing({ verdict: 'limited', fiveHour: 0.1, sevenDay: 0.2, models: [{ name: 'Fable', utilization: 0.35 }] }),
    });
    expect(decision.limited).toBe(false);
  });
});

describe('usage credits, which carry an account past its plan limit', () => {
  const probing = (result: LimitProbeResult) => () => Promise.resolve(result);

  it('does not call a spent plan window an account-wide cap when credits carry it', async () => {
    // The production failure: every account read as week-spent, so ccx refused
    // to start Claude at all, for an operator who had bought usage credits and
    // did have usage. Credits are exactly the case where a spent PLAN window
    // says nothing about whether work will be served.
    const decision = await confirmCap('/profiles/main', 'usage limit reached', {
      probe: probing({
        verdict: 'limited',
        fiveHour: 0,
        sevenDay: 1,
        sevenDayReset: 4242,
        creditsCarryPastLimit: true,
      }),
    });
    expect(decision.model).toBeUndefined();
    expect(decision.resetAt).not.toBe(4242);
    expect(decision.limited).toBe(false);
  });

  it('still records the account-wide cap when credits are NOT carrying it', async () => {
    const decision = await confirmCap('/profiles/main', 'usage limit reached', {
      probe: probing({ verdict: 'limited', fiveHour: 0, sevenDay: 1, sevenDayReset: 4242 }),
    });
    expect(decision.limited).toBe(true);
    expect(decision.model).toBeUndefined();
    expect(decision.resetAt).toBe(4242);
  });

  it('still scopes to a spent MODEL when credits carry the plan window', async () => {
    // Credits cover the plan limit; they do not conjure a model whose own
    // weekly window is finished. The account keeps working on other models.
    const decision = await confirmCap('/profiles/main', 'limit reached', {
      probe: probing({
        verdict: 'limited',
        fiveHour: 0,
        sevenDay: 1,
        creditsCarryPastLimit: true,
        models: [{ name: 'Fable', utilization: 1, resetsAt: 777 }],
      }),
    });
    expect(decision.limited).toBe(true);
    expect(decision.model).toBe('Fable');
    expect(decision.resetAt).toBe(777);
  });
});

describe('a usage check that gives no answer', () => {
  /** A session folder signed in, so its own login is the one asked. */
  function signedIn(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'cas-cap-unanswered-'));
    writeFileSync(
      path.join(dir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'tok', refreshToken: 'rt' } }),
    );
    return dir;
  }
  const TURNED_AWAY: LimitProbeResult = { verdict: 'unknown', detail: 'status 429' };
  const proves = () =>
    Promise.resolve({ proves: true, why: 'Claude recorded the turn as refused (usage_limit_reached)' });
  const doesNot = () =>
    Promise.resolve({ proves: false, why: 'the refusal was recorded before this Claude started' });
  /** The usage endpoint's answers in turn, the last one standing; and how often it was asked. */
  const answering = (...answers: LimitProbeResult[]) => {
    let asked = 0;
    return {
      asked: () => asked,
      probe: () => {
        asked += 1;
        return Promise.resolve(answers[Math.min(asked, answers.length) - 1] ?? TURNED_AWAY);
      },
    };
  };
  /** Back-offs waited out at once, and written down. */
  const waits: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    waits.push(ms);
    return Promise.resolve();
  };
  const ask = (deps: Parameters<typeof confirmSessionCap>[2]) =>
    confirmSessionCap({ sessionDir: signedIn(), believedDir: null }, 'limit reached', { sleep, ...deps });

  it("confirms the limit, account-wide and with no window, on Claude's own record of the refused turn", async () => {
    for (const probe of [() => Promise.resolve(TURNED_AWAY), () => Promise.reject(new Error('fetch aborted'))]) {
      const decision = await ask({ probe, refusal: proves });
      expect(decision).toMatchObject({ limited: true, byRefusal: true, unanswered: true, askedOf: 'session' });
      expect(decision.model).toBeUndefined();
      expect(decision.resetAt).toBeUndefined();
    }
  });

  it('never confirms it on a refusal that does not prove it, or on none', async () => {
    for (const refusal of [doesNot, undefined]) {
      const decision = await ask({ probe: answering(TURNED_AWAY).probe, ...(refusal ? { refusal } : {}) });
      expect(decision).toMatchObject({ limited: false, unanswered: true, detail: 'status 429' });
      expect(decision.byRefusal).toBeUndefined();
    }
    expect((await ask({ probe: answering(TURNED_AWAY).probe, refusal: doesNot })).refusalWhy).toBe(
      'the refusal was recorded before this Claude started',
    );
  });

  it('judges the record only once the usage check has given no answer', async () => {
    const order: string[] = [];
    const judged = () => {
      order.push('judged');
      return proves();
    };
    const probe = () => {
      order.push('asked');
      return Promise.resolve(TURNED_AWAY);
    };
    expect((await ask({ probe, refusal: judged })).limited).toBe(true);
    expect(order).toEqual(['asked', 'judged']);
    // An answered check never asks it.
    order.length = 0;
    await ask({ probe: () => Promise.resolve({ verdict: 'allowed' }), refusal: judged });
    expect(order).toEqual([]);
  });

  it('lets the record decide when there is no login to ask the usage check with', async () => {
    // A check that cannot be asked gives no answer, the same as one turned away.
    const empty = mkdtempSync(path.join(tmpdir(), 'cas-cap-nologin-'));
    const decision = await confirmSessionCap({ sessionDir: empty, believedDir: null }, 'limit reached', {
      probe: () => Promise.reject(new Error('never asked')),
      refusal: proves,
    });
    expect(decision).toMatchObject({ limited: true, byRefusal: true, detail: 'no credential to ask' });
    expect((await confirmCap(null, 'limit', { refusal: doesNot })).limited).toBe(false);
  });

  it('leaves an answered check to the usage endpoint, whatever the record says', async () => {
    // It says the account has room: Claude's refusal may have gone out on the
    // login a move replaced, and the endpoint read the one there now.
    const room = await ask({ probe: answering({ verdict: 'allowed', fiveHour: 0.2 }).probe, refusal: proves });
    expect(room.limited).toBe(false);
    expect(room.unanswered).toBeUndefined();
    // It measured the limit, window and all.
    const out = await ask({
      probe: answering({ verdict: 'limited', fiveHour: 1, fiveHourReset: 4242 }).probe,
      refusal: proves,
    });
    expect(out).toMatchObject({ limited: true, resetAt: 4242 });
    expect(out.byRefusal).toBeUndefined();
  });

  it('asks again after the back-off the endpoint asks for, and takes that answer', async () => {
    waits.length = 0;
    const usage = answering(
      { ...TURNED_AWAY, retryAfterMs: 1500 },
      { verdict: 'limited', fiveHour: 1, fiveHourReset: 777 },
    );
    const decision = await ask({ probe: usage.probe, refusal: proves });
    expect(waits).toEqual([1500]);
    expect(usage.asked()).toBe(2);
    expect(decision).toMatchObject({ limited: true, resetAt: 777, asks: 2 });
    expect(decision.byRefusal).toBeUndefined();
  });

  it('asks again once, and then lets the record decide', async () => {
    waits.length = 0;
    const turnedAwayAgain = answering({ ...TURNED_AWAY, retryAfterMs: 1000 });
    const decision = await ask({ probe: turnedAwayAgain.probe, refusal: proves });
    expect(turnedAwayAgain.asked()).toBe(2);
    expect(waits).toEqual([1000]);
    expect(decision).toMatchObject({ limited: true, byRefusal: true, asks: 2 });
    expect(usageAnswer(decision)).toBe('status 429, asked 2 times');
  });

  it('does not wait out a back-off longer than a check can, nor ask again without one', async () => {
    waits.length = 0;
    const long = answering({ ...TURNED_AWAY, retryAfterMs: 60_000 });
    const decision = await ask({ probe: long.probe });
    expect(long.asked()).toBe(1);
    expect(decision).toMatchObject({ limited: false, backOffMs: 60_000 });
    expect(usageAnswer(decision)).toBe('status 429; it asked to wait 60 s, longer than a check waits');
    const none = answering(TURNED_AWAY);
    await ask({ probe: none.probe });
    expect(none.asked()).toBe(1);
    expect(waits).toEqual([]);
  });

  it('keeps the whole check short: the back-off counts from the start, the second ask has 3 s', async () => {
    vi.useFakeTimers();
    try {
      // Turned away after 3.5 s, with 1 s more asked for: past the 4 s a check waits.
      const slow = () =>
        new Promise<LimitProbeResult>((resolve) =>
          setTimeout(() => resolve({ ...TURNED_AWAY, retryAfterMs: 1000 }), 3500),
        );
      const late = ask({ probe: slow, sleep: () => Promise.resolve() });
      await vi.advanceTimersByTimeAsync(3500);
      expect(await late).toMatchObject({ limited: false, backOffMs: 1000 });

      // A second ask that never answers is given up on.
      let asked = 0;
      const silent = () => {
        asked += 1;
        return asked === 1 ? Promise.resolve({ ...TURNED_AWAY, retryAfterMs: 500 }) : new Promise<LimitProbeResult>(() => {});
      };
      const hung = ask({ probe: silent, sleep: () => Promise.resolve(), refusal: proves });
      await vi.advanceTimersByTimeAsync(3000);
      expect(await hung).toMatchObject({ limited: true, byRefusal: true, asks: 2, detail: 'no answer in 3 s' });
    } finally {
      vi.useRealTimers();
    }
  });
});
