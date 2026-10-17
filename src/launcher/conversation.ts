import { randomUUID } from 'node:crypto';
import { readCommandLine, withOptions, withoutOptions } from './claude-args.js';

/**
 * Staying in the SAME conversation across an account swap.
 *
 * A swap ends the child and starts another, and the new one has to pick the
 * conversation back up. That was done with `--continue`, which Claude documents
 * as "continue the most recent conversation in the current directory". Most
 * recent IN THE DIRECTORY, not the one this terminal was in: with two sessions
 * open on the same project, a swap in one of them could resume the other one's
 * conversation, and the operator would find themselves in somebody else's
 * thread with no way back.
 *
 * So the run names its own conversation instead. Claude takes `--session-id` on
 * a fresh start and `--resume <id>` afterwards, and resuming keeps the same id
 * (creating a new one needs `--fork-session`, which a relaunch never passes).
 * Nothing then depends on which conversation happens to have been touched last.
 */

/** "Carry on the most recent conversation", with no id; `-c` too. */
const CONTINUE_FLAG = '--continue';
/** Takes a conversation id, or opens a picker when given none; `-r` too. */
const RESUME_FLAG = '--resume';
const SESSION_ID_FLAG = '--session-id';
/**
 * Resume into a COPY of the conversation instead of continuing it.
 *
 * It means something only on the launch that makes the copy. Carried into a
 * relaunch it copies again, so every swap left another duplicate of the thread
 * behind, and a swap that did not know the copy's id copied the ORIGINAL again,
 * dropping everything done since.
 */
const FORK_FLAG = '--fork-session';

/** Claude requires a real UUID here and rejects anything else. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeConversationId(value: string | undefined): boolean {
  return typeof value === 'string' && UUID.test(value);
}

/**
 * Every reader here takes the options as Claude does (see claude-args): in any
 * spelling, `--resume=<id>` (Claude Desktop launches that way), `-r<id>` and a
 * cluster such as `-pc` included, and never anything after `--`.
 */

/** Whether `args` already asks for some existing conversation. */
export function wantsExistingConversation(args: string[]): boolean {
  return readCommandLine(args).options.some(
    (o) => o.long === CONTINUE_FLAG || o.long === RESUME_FLAG,
  );
}

/** Whether `args` resume into a copy rather than the conversation itself. */
export function forksConversation(args: string[]): boolean {
  return readCommandLine(args).options.some((o) => o.long === FORK_FLAG);
}

/**
 * Whether a launch with `args` picks an existing conversation back up by
 * itself: `--continue`, or a resume that names one.
 *
 * A bare `--resume` opens the picker instead, and a prompt added after it would
 * be read as the picker's search term, so that does not count.
 */
export function startsByResuming(args: string[]): boolean {
  return readCommandLine(args).options.some(
    (o) => o.long === CONTINUE_FLAG || (o.long === RESUME_FLAG && (o.value ?? '') !== ''),
  );
}

/**
 * The value given to `wanted`: written inside it, the operand after it, '' when
 * the flag is there with no value, or undefined when it is not there at all.
 */
function valueOf(args: string[], wanted: string): string | undefined {
  const option = readCommandLine(args).options.find((o) => o.long === wanted);
  return option === undefined ? undefined : (option.value ?? '');
}

/**
 * The conversation id `args` names, if it names one.
 *
 * `--resume` with nothing after it opens a picker, so there is no id to find;
 * that reads as null rather than as the next argument, which would otherwise
 * swallow an unrelated flag and hand Claude a nonsense id.
 */
export function conversationIdIn(args: string[]): string | null {
  for (const option of readCommandLine(args).options) {
    if (option.long !== RESUME_FLAG && option.long !== SESSION_ID_FLAG) continue;
    if (looksLikeConversationId(option.value)) return option.value as string;
  }
  return null;
}

/**
 * The conversation a print-mode run says it ran in: the `session_id` of its
 * JSON output (`--output-format json`), or of the first event that carries one
 * (`stream-json`). Null for plain text, which carries none.
 */
export function reportedSessionId(stdout: string): string | null {
  const idIn = (text: string): string | null => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
    const id = typeof value === 'object' && value !== null ? (value as { session_id?: unknown }).session_id : null;
    return typeof id === 'string' && looksLikeConversationId(id) ? id : null;
  };
  const whole = idIn(stdout.trim());
  if (whole !== null) return whole;
  for (const line of stdout.split('\n')) {
    const id = line.trim() === '' ? null : idIn(line.trim());
    if (id !== null) return id;
  }
  return null;
}

/**
 * Flags that say which conversation a run is in, or put it where ccx keeps no
 * record: a resume, a continue, an id, a fork, and the flags that resume or
 * attach to a conversation elsewhere (a pull request's, a teleported one, a
 * cloud session). Claude refuses `--session-id` beside a resume or a continue
 * without `--fork-session` (2.1.299 and 2.1.302: "--session-id can only be
 * used with --continue or --resume if --fork-session is also specified").
 */
const NAMING_FLAGS = new Set([
  RESUME_FLAG,
  CONTINUE_FLAG,
  SESSION_ID_FLAG,
  FORK_FLAG,
  '--from-pr',
  '--teleport',
  '--cloud',
  '--remote',
]);

/** Whether `args` say which conversation the run is in, in any spelling Claude's parser takes. */
export function namesConversation(args: string[]): boolean {
  return readCommandLine(args).options.some((o) => NAMING_FLAGS.has(o.long));
}

/** `args` with `--session-id <id>` added among the options, before any `--`. */
export function withConversationId(args: string[], id: string): string[] {
  return withOptions(args, [SESSION_ID_FLAG, id]);
}

/**
 * Every conversation flag, which a relaunch replaces with its own, and the fork
 * flag, which only ever applies to the launch that made the copy.
 */
const CONVERSATION_FLAGS: ReadonlySet<string> = new Set([
  CONTINUE_FLAG,
  RESUME_FLAG,
  SESSION_ID_FLAG,
  FORK_FLAG,
]);

/**
 * Strip every conversation flag, with whatever value it carries. `--resume`
 * accepts a session name or a search term as well as an id, and leaving one of
 * those behind turns it into a stray positional argument to Claude. A BARE
 * `--resume` (a picker) carries nothing, so the argument after it stays.
 */
export function withoutConversationFlags(args: string[]): string[] {
  return withoutOptions(args, CONVERSATION_FLAGS);
}

export interface ConversationPlan {
  /** The command line for this run's FIRST launch. */
  args: string[];
  /**
   * The conversation this run owns, when it can be known before starting.
   *
   * Null when the operator asked for a conversation only Claude can identify
   * (`--continue`, or `--resume` with the picker). The id is learned from the
   * running session in that case: Claude's own record of which conversation
   * the process is in (see session/live-conversation).
   */
  id: string | null;
}

/**
 * Decide which conversation this run is in, before anything starts.
 *
 * A fresh start is given an id of our own so later swaps have something exact
 * to resume. Anything the operator asked for is left exactly as typed: they may
 * be resuming a specific conversation, and rewriting that would be ccx deciding
 * which thread they are in.
 *
 * A fork is the one exception, and only by addition. The id after `--resume`
 * then names where the copy came FROM, not the thread this run is in, so it is
 * not this run's conversation. Claude accepts `--session-id` alongside
 * `--fork-session` to name the copy, so the copy is named here unless the
 * operator already named it.
 */
export function planConversation(args: string[], newId: () => string = randomUUID): ConversationPlan {
  if (forksConversation(args) && wantsExistingConversation(args)) {
    const own = valueOf(args, SESSION_ID_FLAG);
    if (own !== undefined) return { args, id: looksLikeConversationId(own) ? own : null };
    const id = newId();
    return { args: withConversationId(args, id), id };
  }
  const named = conversationIdIn(args);
  if (named) return { args, id: named };
  if (wantsExistingConversation(args)) return { args, id: null };
  const id = newId();
  return { args: withConversationId(args, id), id };
}

/**
 * The command line for picking the conversation back up after a swap.
 *
 * With an id, this run resumes exactly its own thread. Without one, it falls
 * back to "the most recent in this directory", which is the best available
 * answer when nothing has told us which conversation this is.
 */
export function relaunchArgs(args: string[], id: string | null): string[] {
  return withOptions(withoutConversationFlags(args), id ? [RESUME_FLAG, id] : [CONTINUE_FLAG]);
}

export type ResumePromptPlacement =
  | { applied: true; args: string[] }
  | { applied: false; args: string[]; reason: string };

/**
 * Whether `args` carry a prompt: an operand that is not some option's value,
 * anything after `--` included, even text that starts with a dash.
 */
export function hasOwnPrompt(args: string[]): boolean {
  return readCommandLine(args).operands.length > 0;
}

/**
 * Whether an operand added at the end of `args` would be read as one more value
 * of the last option there, because that option takes every operand after it:
 * `--add-dir ../shared` or `--allowedTools "Bash(npm test:*)"`.
 */
export function endsInManyValues(args: string[]): boolean {
  return readCommandLine(args).endsInList;
}

/**
 * Hand a relaunch the prompt its session armed for coming back.
 *
 * Claude takes one prompt: `claude [options] [prompt]`, and a resumed
 * conversation given one submits it at once. That is what lets an unattended
 * session carry on by itself after a swap instead of sitting idle.
 *
 * A run that was LAUNCHED with a prompt of its own already has its one prompt,
 * and it rides every relaunch with the other arguments. A second would at best
 * be ignored and at worst stop Claude starting, so the armed prompt stands aside
 * and says why. An operand counts as that prompt unless it is the value of an
 * option known to take one (see hasOwnPrompt), so `--model opus` and the id
 * after `--resume` are never mistaken for a prompt, and the task after
 * `--dangerously-skip-permissions` always is.
 */
export function withResumePrompt(relaunch: string[], prompt: string): ResumePromptPlacement {
  if (hasOwnPrompt(relaunch)) {
    return {
      applied: false,
      args: relaunch,
      reason: 'this run was launched with a prompt of its own, and Claude takes only one',
    };
  }
  if (endsInManyValues(relaunch)) {
    return {
      applied: false,
      args: relaunch,
      reason: 'the last option takes every value after it, so a prompt there would be read as one of them',
    };
  }
  return { applied: true, args: [...relaunch, promptOperand(prompt)] };
}

/**
 * A prompt as Claude's operand, read as nothing else.
 *
 * Claude reads an operand that starts with "-" as an option and refuses to
 * start, and one that is a single word naming a subcommand ("mcp", "update")
 * as that subcommand, even after "--" (measured against 2.1.284). A leading
 * space defeats both, and the model never notices it. Anything else is passed
 * exactly as written, so a prompt like "/compact" still runs as a command.
 */
export function promptOperand(prompt: string): string {
  return /^-/.test(prompt) || /^[A-Za-z][\w-]*$/.test(prompt) ? ` ${prompt}` : prompt;
}

/**
 * Start a genuinely NEW conversation, and name it.
 *
 * Used when a resume finds nothing to resume. Naming the new one matters as
 * much as starting it: the id the run was carrying is now known to lead
 * nowhere, so without a replacement every later swap would try that same dead
 * id, fail, and start fresh again, losing the conversation each time.
 */
export function freshStartArgs(
  args: string[],
  newId: () => string = randomUUID,
): { args: string[]; id: string } {
  // Always an id, never null: a fresh start is the one case where we are the
  // ones creating the conversation, so there is nothing to be unsure about.
  const id = newId();
  return { args: withConversationId(withoutConversationFlags(args), id), id };
}
