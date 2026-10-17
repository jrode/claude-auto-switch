import { describe, it, expect } from 'vitest';
import { refusalProof, type RecordedRefusal } from './refused-turn.js';
import type { Refusal } from './transcript.js';

const LAUNCHED = 1_000_000;

/** A refusal as Claude 2.1.296 records an account out of its usage limit, 5 s into the launch. */
const refusal = (extra: Partial<Refusal> = {}): Refusal => ({
  error: 'rate_limit',
  apiError: 'usage_limit_reached',
  status: 429,
  text: "You've hit your session limit",
  at: LAUNCHED + 5_000,
  sidechain: false,
  ...extra,
});
const recorded = (extra: Partial<Refusal> = {}, promptAt = 0): RecordedRefusal => ({
  refusal: refusal(extra),
  launchedAt: LAUNCHED,
  promptAt,
});

describe('what a refused turn in the record proves on its own', () => {
  it("proves the limit when it is this turn's, on this login, with the account's own code", () => {
    expect(refusalProof(recorded(), 0)).toEqual({
      proves: true,
      why: 'Claude recorded the turn as refused (usage_limit_reached)',
    });
    // A subagent's is the same login's.
    expect(refusalProof(recorded({ sidechain: true }), 0).proves).toBe(true);
    // Following the prompt it refused.
    expect(refusalProof(recorded({}, LAUNCHED + 4_000), 0).proves).toBe(true);
  });

  it('proves nothing without the code that says the whole account is out', () => {
    // A limit on one model, credits, or a version that writes no code: the
    // usage check is what says how wide those are.
    for (const apiError of ['model_requires_usage_credits', null]) {
      const proof = refusalProof(recorded({ apiError }), 0);
      expect(proof.proves, String(apiError)).toBe(false);
      expect(proof.why).toContain('does not say the account is out of its usage limit');
    }
    expect(refusalProof(recorded({ error: 'billing_error', apiError: null, status: 400 }), 0).why).toBe(
      'the refusal (billing_error) does not say the account is out of its usage limit',
    );
  });

  it('proves nothing about a turn from before this Claude started', () => {
    expect(refusalProof(recorded({ at: LAUNCHED - 1 }), 0)).toEqual({
      proves: false,
      why: 'the refusal was recorded before this Claude started',
    });
  });

  it('proves nothing when it carries no time to tell', () => {
    expect(refusalProof(recorded({ at: null }), 0).proves).toBe(false);
  });

  it('proves nothing once a prompt has been typed after it', () => {
    expect(refusalProof(recorded({}, LAUNCHED + 6_000), 0)).toEqual({
      proves: false,
      why: 'a prompt was typed after the refusal',
    });
  });

  it('proves nothing about the new login for as long as Claude can still be on the old one', () => {
    const movedAt = LAUNCHED + 60_000;
    const at = (ms: number): RecordedRefusal => recorded({ at: movedAt + ms });
    expect(refusalProof(at(-1), movedAt)).toEqual({
      proves: false,
      why: 'the refusal was recorded before the login under Claude changed',
    });
    expect(refusalProof(at(29_999), movedAt).why).toBe(
      'the refusal came within 30 s of the login changing under Claude, so it may be the old login',
    );
    expect(refusalProof(at(30_000), movedAt).proves).toBe(true);
  });

  it('pays no heed to a login put in before this Claude started', () => {
    // The session start's own: Claude read that one fresh.
    expect(refusalProof(recorded(), LAUNCHED - 10).proves).toBe(true);
  });
});
