import type { Refusal } from './transcript.js';

/**
 * Whether a refused turn in Claude's own record proves, on its own, that the
 * login now under the session is out of its usage limit. Asked only when
 * ccx's usage check cannot answer: the endpoint has a small budget shared by
 * every session on the machine, so it answers 429 exactly when many sessions
 * are busy, which is also when limits are met.
 *
 * Text on the screen never proves it: a resumed conversation replays old
 * limit messages, and a conversation can be about limits. The record is
 * different, since Claude writes the API's own answer there. But an entry
 * speaks only for the turn it refused, so it proves something only when that
 * is the turn in front of the session now, on the login it is on now, when
 * this process itself showed it (see own-output: another Claude can write to
 * the same record), and when the API's code says how wide the limit is.
 */

/**
 * How long after the login under a running Claude changed a refusal may
 * still be the old login's. Claude keeps a login it has read for up to 30 s
 * (see nudgeLoginReread), and a request sent on it at the end of that time is
 * answered, and its refusal written, a little later: 10 s more covers a slow
 * answer, since a usage limit is refused when the request arrives.
 */
const OLD_LOGIN_MS = 30_000 + 10_000;

/**
 * Refusals are judged within seconds of being written, or at the latest
 * when Claude exits; older than this, it is no longer the turn in front of
 * the session. Output is kept this long for the check (see own-output).
 */
export const REFUSAL_MAX_AGE_MS = 2 * 60_000;

/** How far into the future a refusal's time may be, for clocks a little apart. */
const CLOCK_SKEW_MS = 5_000;

/**
 * The API's code for a turn refused because the account is out of its
 * session, weekly or monthly spend limit. Claude 2.1.292 to 2.1.302 wrote it
 * on every such refusal measured on one machine (over 470 on 10-16); 2.1.284
 * and older write no code. A limit on one model is another refusal (the
 * record's type names `model_requires_usage_credits` for one), and only this
 * code says the whole account is out.
 */
const ACCOUNT_OUT = 'usage_limit_reached';

/** A refused turn from the record, with what tells whether it is the session's own turn now. */
export interface RecordedRefusal {
  refusal: Refusal;
  /** When this Claude was started, by the clock the record's times are in. */
  launchedAt: number;
  /** When a prompt was last typed at it; 0 when none has been seen. */
  promptAt: number;
  /**
   * Whether this process put the refusal on its own screen or in its own
   * output (see own-output). It may wait a moment: the record and the output
   * are written together, and either can be read first.
   */
  shown: () => Promise<boolean>;
}

/** What a refused turn proves on its own, and in words: what it was, or why it is not proof. */
export interface RefusalProof {
  proves: boolean;
  why: string;
}

/**
 * Judge `recorded` at `now` against the login under this Claude, last
 * replaced at `loginChangedAt` (0 when it never was).
 */
export async function refusalProof(
  recorded: RecordedRefusal,
  loginChangedAt: number,
  now: number = Date.now(),
): Promise<RefusalProof> {
  const { refusal, launchedAt, promptAt } = recorded;
  const not = (why: string): RefusalProof => ({ proves: false, why });
  if (refusal.apiError !== ACCOUNT_OUT) {
    return not(
      `the refusal (${refusal.apiError ?? refusal.error}) does not say the account is out of its usage limit`,
    );
  }
  const at = refusal.at;
  if (at === null) return not('the refusal carries no time, so it may not be this turn');
  if (at > now + CLOCK_SKEW_MS) return not('the refusal is stamped in the future');
  if (at < launchedAt) return not('the refusal was recorded before this Claude started');
  if (at < now - REFUSAL_MAX_AGE_MS) return not('the refusal is more than 2 minutes old');
  if (at < promptAt) return not('a prompt was typed after the refusal');
  // A login put in before Claude started is one it read fresh.
  if (loginChangedAt > launchedAt) {
    if (at < loginChangedAt) return not('the refusal was recorded before the login under Claude changed');
    if (at < loginChangedAt + OLD_LOGIN_MS) {
      return not('the refusal came within 40 s of the login changing under Claude, so it may be the old login');
    }
  }
  // Last, since it may wait.
  if (!(await recorded.shown())) return not('this Claude did not show the refusal, so another may have written it');
  return { proves: true, why: `Claude recorded the turn as refused (${ACCOUNT_OUT})` };
}
