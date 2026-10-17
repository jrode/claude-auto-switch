import { describe, it, expect } from 'vitest';
import { refusalProof, type RecordedRefusal, type RefusalProof } from './refused-turn.js';
import type { Refusal } from './transcript.js';

const LAUNCHED = 1_000_000;
/** When the refusal is judged: a moment after it was written. */
const NOW = LAUNCHED + 6_000;

/** A refusal as Claude 2.1.296 records an account out of its usage limit, 5 s into the launch. */
const refusal = (extra: Partial<Refusal> = {}): Refusal => ({
  error: 'rate_limit',
  apiError: 'usage_limit_reached',
  status: 429,
  text: "You've hit your session limit · resets 6pm (America/New_York)",
  at: LAUNCHED + 5_000,
  sidechain: false,
  ...extra,
});
const recorded = (extra: Partial<Refusal> = {}, promptAt = 0, shown = true): RecordedRefusal => ({
  refusal: refusal(extra),
  launchedAt: LAUNCHED,
  promptAt,
  shown: () => Promise.resolve(shown),
});
/** Judged at NOW, with no login change, unless said otherwise. */
const judge = (r: RecordedRefusal, loginChangedAt = 0, now = NOW): Promise<RefusalProof> =>
  refusalProof(r, loginChangedAt, now);

describe('what a refused turn in the record proves on its own', () => {
  it("proves the limit when it is this turn's, on this login, shown by this Claude, with the account's own code", async () => {
    expect(await judge(recorded())).toEqual({
      proves: true,
      why: 'Claude recorded the turn as refused (usage_limit_reached)',
    });
    // Following the prompt it refused.
    expect((await judge(recorded({}, LAUNCHED + 4_000))).proves).toBe(true);
  });

  it('proves nothing that this Claude did not show: another Claude can write to the same record', async () => {
    expect(await judge(recorded({}, 0, false))).toEqual({
      proves: false,
      why: 'this Claude did not show the refusal, so another may have written it',
    });
  });

  it('proves nothing without the code that says the whole account is out', async () => {
    // A limit on one model, credits, or a version that writes no code: the
    // usage check is what says how wide those are.
    for (const apiError of ['model_requires_usage_credits', null]) {
      const proof = await judge(recorded({ apiError }));
      expect(proof.proves, String(apiError)).toBe(false);
      expect(proof.why).toContain('does not say the account is out of its usage limit');
    }
    expect((await judge(recorded({ error: 'billing_error', apiError: null, status: 400 }))).why).toBe(
      'the refusal (billing_error) does not say the account is out of its usage limit',
    );
  });

  it('proves nothing about a turn from before this Claude started', async () => {
    expect(await judge(recorded({ at: LAUNCHED - 1 }))).toEqual({
      proves: false,
      why: 'the refusal was recorded before this Claude started',
    });
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
    expect(await judge(recorded({}, LAUNCHED + 5_500))).toEqual({
      proves: false,
      why: 'a prompt was typed after the refusal',
    });
  });

  it('proves nothing about the new login while Claude can still be on the old one, and a request on it answered', async () => {
    const movedAt = LAUNCHED + 60_000;
    const after = (ms: number) => judge(recorded({ at: movedAt + ms }), movedAt, movedAt + ms + 1_000);
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

  it('pays no heed to a login put in before this Claude started', async () => {
    // The session start's own: Claude read that one fresh.
    expect((await judge(recorded(), LAUNCHED - 10)).proves).toBe(true);
  });

  it('asks whether this Claude showed it only once all else holds', async () => {
    let asked = 0;
    const counting: RecordedRefusal = {
      ...recorded({ at: LAUNCHED - 1 }),
      shown: () => {
        asked += 1;
        return Promise.resolve(true);
      },
    };
    await judge(counting);
    expect(asked).toBe(0);
  });
});
