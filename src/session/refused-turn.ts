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
 * is the turn in front of the session now, on the login it is on now, and
 * only when the API's code says how wide the limit is.
 */

/**
 * The longest a running Claude keeps a login it has read (see
 * nudgeLoginReread): a request that went out just before a move can be
 * refused after it, on the login the move replaced.
 */
const LOGIN_KEPT_MS = 30_000;

/**
 * The API's code for a turn refused because the account is out of its
 * session, weekly or monthly spend limit. Claude 2.1.292 to 2.1.302 wrote it
 * on all 471 such refusals measured on one machine. Older versions write no
 * code, and none was written for a limit on one model ("You've reached your
 * Fable limit", seen on 2.1.257): without it, a refusal does not say whether
 * the whole account is out.
 */
const ACCOUNT_OUT = 'usage_limit_reached';

/** A refused turn from the record, with what tells whether it is the session's turn now. */
export interface RecordedRefusal {
  refusal: Refusal;
  /** When this Claude was started, by the clock the record's times are in. */
  launchedAt: number;
  /** When a prompt was last typed at it; 0 when none has been seen. */
  promptAt: number;
}

/** What a refused turn proves on its own, and in words: what it was, or why it is not proof. */
export interface RefusalProof {
  proves: boolean;
  why: string;
}

/**
 * Judge `recorded` against the login under this Claude, last replaced at
 * `loginChangedAt` (0 when it never was).
 */
export function refusalProof(recorded: RecordedRefusal, loginChangedAt: number): RefusalProof {
  const { refusal, launchedAt, promptAt } = recorded;
  const not = (why: string): RefusalProof => ({ proves: false, why });
  if (refusal.apiError !== ACCOUNT_OUT) {
    return not(
      `the refusal (${refusal.apiError ?? refusal.error}) does not say the account is out of its usage limit`,
    );
  }
  if (refusal.at === null) return not('the refusal carries no time, so it may not be this turn');
  if (refusal.at < launchedAt) return not('the refusal was recorded before this Claude started');
  if (refusal.at < promptAt) return not('a prompt was typed after the refusal');
  // A login put in before Claude started is one it read fresh.
  if (loginChangedAt > launchedAt) {
    if (refusal.at < loginChangedAt) return not('the refusal was recorded before the login under Claude changed');
    if (refusal.at < loginChangedAt + LOGIN_KEPT_MS) {
      return not(
        'the refusal came within 30 s of the login changing under Claude, so it may be the old login',
      );
    }
  }
  return { proves: true, why: `Claude recorded the turn as refused (${ACCOUNT_OUT})` };
}
