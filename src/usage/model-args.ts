/**
 * Putting the chosen model onto the command line for the next session.
 *
 * Choosing a model and then not applying it is worse than not choosing one: the
 * session keeps running the model that just ran out, while the operator has been
 * told it moved. So the decision has to reach the process that is started.
 *
 * `--model` is used rather than rewriting the session's settings file, because
 * the settings file is shared across accounts and a rotation should not quietly
 * repin someone's editor. The flag lasts exactly as long as the session it
 * starts, which is the right lifetime for a decision made about one rotation.
 *
 * Only Claude's options are read and changed, never anything after `--`, which
 * Claude reads as the prompt.
 */
import { readCommandLine, withOptions, withoutOptions } from '../launcher/claude-args.js';

/**
 * Read in both spellings, `--model=fable` and `--model fable`, which mean the
 * same thing to the parser, so removing one removes the other too, or the
 * spent model survives and wins.
 *
 * `--fallback-model` is deliberately NOT matched: it is a different setting,
 * it belongs to the operator, and it is not the flag being rotated.
 */
const MODEL_FLAG = '--model';
const MODEL: ReadonlySet<string> = new Set([MODEL_FLAG]);

/**
 * A model name is never empty and never starts with `-`, so `--model=-c` names
 * no model. The spaced form never takes a value that starts with `-`: that is
 * the NEXT option, and swallowing it would quietly drop something like a resume
 * flag and change what the session does.
 */
function isValue(token: string | undefined): token is string {
  return typeof token === 'string' && token.length > 0 && !token.startsWith('-');
}

/**
 * Return `args` with `--model` set to `model`, replacing any value already there.
 *
 * Replacing rather than appending matters: an explicit `--model fable` is
 * precisely the case where Fable might be exhausted, and appending would leave
 * the first (spent) value winning, or hand the process two conflicting flags.
 */
export function withModel(args: string[], model: string): string[] {
  return withOptions(withoutOptions(args, MODEL), [MODEL_FLAG, model]);
}

/** The value of the first `--model` in `args`, in either spelling, or null when absent. */
export function modelInArgs(args: string[]): string | null {
  const option = readCommandLine(args).options.find((o) => o.long === MODEL_FLAG);
  return option !== undefined && isValue(option.value) ? option.value : null;
}
