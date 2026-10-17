import { describe, it, expect } from 'vitest';
import { refusalProof, type RecordedRefusal, type RefusalProof } from './refused-turn.js';
import type { Refusal } from './transcript.js';

const LAUNCHED = 1_000_000;
/** When the refusal is judged: a moment after it was written. */
const NOW = LAUNCHED + 6_000;
const RESETS = NOW + 2 * 60 * 60_000;

/** A refusal as Claude 2.1.302 records a spent five-hour limit, 5 s into the launch. */
const refusal = (extra: Partial<Refusal> = {}): Refusal => ({
  error: 'rate_limit',
  apiError: 'usage_limit_reached',
  status: 429,
  text: "You've hit your session limit · resets 6pm (America/New_York)",
  at: LAUNCHED + 5_000,
  sidechain: false,
  limitType: 'five_hour',
  resetsAt: RESETS,
  ...extra,
});
const recorded = (extra: Partial<Refusal> = {}, more: Partial<RecordedRefusal> = {}): RecordedRefusal => ({
  refusal: refusal(extra),
  launchedAt: LAUNCHED,
  promptAt: 0,
  conversation: '11111111-2222-4333-8444-555555555555',
  claudePid: 4242,
  ...more,
});
/** Judged at NOW, with no login change, unless said otherwise. */
const judge = (r: RecordedRefusal, loginChangedAt = 0, now = NOW): Promise<RefusalProof> =>
  refusalProof(r, loginChangedAt, now);

describe('what a refused turn in the record proves on its own', () => {
  it("proves the account's limit when it is this turn's, until the reset it names", async () => {
    expect(await judge(recorded())).toEqual({
      proves: true,
      why: 'Claude recorded the turn as refused (usage_limit_reached, five_hour)',
      resetAt: RESETS,
    });
    expect((await judge(recorded({ limitType: 'seven_day' }))).proves).toBe(true);
    // Following the prompt it refused.
    expect((await judge(recorded({}, { promptAt: LAUNCHED + 4_000 }))).proves).toBe(true);
  });

  it("proves one model's limit as that model's, so the account goes on with the others", async () => {
    expect(await judge(recorded({ limitType: 'seven_day_opus' }))).toMatchObject({ proves: true, model: 'Opus' });
    expect(await judge(recorded({ limitType: 'seven_day_sonnet' }))).toMatchObject({ proves: true, model: 'Sonnet' });
    // What Claude 2.1.302 calls the "Fable limit".
    expect(await judge(recorded({ limitType: 'seven_day_overage_included' }))).toMatchObject({
      proves: true,
      model: 'Fable',
    });
  });

  it('proves nothing for a limit it cannot name, or none', async () => {
    // Names an object has by inheritance are not limit names either.
    for (const limitType of ['overage', 'seven_day_someday', 'constructor', 'toString', '__proto__', undefined]) {
      const proof = await judge(recorded({ limitType }));
      expect(proof.proves, String(limitType)).toBe(false);
      expect(proof.why).toContain('does not say which limit it is');
    }
  });

  it('proves nothing without the code for a spent usage limit', async () => {
    for (const apiError of ['model_requires_usage_credits', null]) {
      const proof = await judge(recorded({ apiError }));
      expect(proof.proves, String(apiError)).toBe(false);
      expect(proof.why).toContain('does not say a usage limit is spent');
    }
  });

  it('proves nothing once the limit it names has reset', async () => {
    expect((await judge(recorded({ resetsAt: NOW }))).why).toBe('the limit it names has reset since');
    expect((await judge(recorded({ resetsAt: NOW + 1 }))).proves).toBe(true);
  });

  it('proves nothing while ccx knows of another live Claude on the same conversation', async () => {
    const other = recorded({}, { otherWriter: () => 'another ccx session (pid 7)' });
    expect(await judge(other)).toEqual({
      proves: false,
      why: 'another ccx session (pid 7) is on this conversation too, so the refusal may be its',
    });
    expect((await judge(recorded({}, { otherWriter: () => null }))).proves).toBe(true);
  });

  it('proves nothing that a run with its own output did not print', async () => {
    const unprinted = recorded({}, { shown: () => Promise.resolve(false) });
    expect((await judge(unprinted)).why).toBe('this run did not print the refusal, so another may have written it');
    expect((await judge(recorded({}, { shown: () => Promise.resolve(true) }))).proves).toBe(true);
  });

  it('proves nothing about a turn from before this Claude started', async () => {
    expect((await judge(recorded({ at: LAUNCHED - 1 }))).why).toBe(
      'the refusal was recorded before this Claude started',
    );
  });

  it('proves nothing when it carries no time to tell, or a time that cannot be right', async () => {
    expect((await judge(recorded({ at: null }))).proves).toBe(false);
    // A little ahead is two clocks a little apart; more is not this turn.
    expect((await judge(recorded({ at: NOW + 5_000 }))).proves).toBe(true);
    expect((await judge(recorded({ at: NOW + 5_001 }))).why).toBe('the refusal is stamped in the future');
  });

  it('proves nothing once it is more than 2 minutes old, as a refusal held until Claude exits can be', async () => {
    const at = LAUNCHED + 5_000;
    expect((await judge(recorded({ at }), 0, at + 120_000)).proves).toBe(true);
    expect((await judge(recorded({ at }), 0, at + 120_001)).why).toBe('the refusal is more than 2 minutes old');
  });

  it('proves nothing once a prompt has been typed after it', async () => {
    expect((await judge(recorded({}, { promptAt: LAUNCHED + 5_500 }))).why).toBe(
      'a prompt was typed after the refusal',
    );
  });

  describe('after the login under Claude changed', () => {
    const movedAt = LAUNCHED + 60_000;
    /** A refusal `ms` after the move, on a turn whose prompt came `promptMs` after it. */
    const after = (ms: number, promptMs?: number) =>
      judge(
        recorded(
          { at: movedAt + ms },
          promptMs === undefined ? {} : { promptAt: movedAt + promptMs },
        ),
        movedAt,
        movedAt + ms + 1_000,
      );

    it('proves nothing for as long as a request can have gone out on the old login and been answered', async () => {
      expect(await after(-1)).toEqual({
        proves: false,
        why: 'the refusal was recorded before the login under Claude changed',
      });
      // 30 s that Claude keeps a login, and 10 s more for a request sent at the end of it.
      expect((await after(30_000)).proves).toBe(false);
      expect((await after(39_999)).why).toBe(
        'the refusal came within 40 s of the login changing under Claude, so it may be the old login',
      );
      expect((await after(40_000)).proves).toBe(true);
    });

    it('proves the turn its prompt began once Claude can no longer have kept the old login', async () => {
      // The carry-on prompt is typed some 35 s after a move.
      expect((await after(36_000, 35_000)).proves).toBe(true);
      expect((await after(36_000, 30_000)).proves).toBe(true);
      // A turn begun earlier may have gone out on the old login.
      expect((await after(36_000, 10_000)).proves).toBe(false);
      expect((await after(36_000, 29_999)).proves).toBe(false);
    });
  });

  it('pays no heed to a login put in before this Claude started', async () => {
    // The session start's own: Claude read that one fresh.
    expect((await judge(recorded(), LAUNCHED - 10)).proves).toBe(true);
  });

  it('asks about other writers and printed output only once all else holds', async () => {
    let asked = 0;
    const counting = recorded(
      { at: LAUNCHED - 1 },
      {
        otherWriter: () => {
          asked += 1;
          return null;
        },
        shown: () => {
          asked += 1;
          return Promise.resolve(true);
        },
      },
    );
    await judge(counting);
    expect(asked).toBe(0);
  });
});
