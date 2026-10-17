/**
 * What a Claude this ccx started has itself shown: its terminal screen, or
 * the output of a headless run.
 *
 * Claude's record of a conversation is one file that any Claude working on
 * that conversation appends to: ccx's own Desktop handoff in `same` mode, or
 * two runs resuming one id. A refusal in it may be another process's. Claude
 * never reloads that file when another process writes to it, so another
 * Claude's refusal never reaches this one's screen or output, and a refusal
 * this process showed is its own.
 */

/** The text of a refusal as it can be found again in output, or null when too little of it to tell. */
export function refusalKey(text: string): string | null {
  const firstLine = text.split('\n').find((line) => line.trim() !== '') ?? '';
  const key = squeezed(firstLine).slice(0, KEY_CHARS);
  return key.length >= MIN_KEY_CHARS ? key : null;
}

/**
 * Enough of the first line to carry the reset time, which tells one limit
 * message from an older one still in the conversation.
 */
const KEY_CHARS = 48;
const MIN_KEY_CHARS = 12;

// Terminal control sequences: CSI (colours, cursor moves, modes), OSC (window
// titles, links) ended by BEL or ESC backslash, and the other escapes (cursor
// saves, character sets).
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;
const ESCAPE = /\u001b[ -/]*[0-~]/g;
const CONTROLS = /[\u0000-\u001f\u007f]/g;

/**
 * Text with every terminal control sequence and all whitespace taken out. A
 * screen draws one line of text in pieces, wraps it, and moves the cursor
 * over a space instead of writing one; whitespace removed from both sides
 * finds the text whatever of that happened.
 */
export function squeezed(text: string): string {
  return text.replace(OSC, '').replace(CSI, '').replace(ESCAPE, '').replace(CONTROLS, '').replace(/\s+/g, '');
}

/**
 * How long a check waits for a refusal it read in the record to reach the
 * output: Claude writes both together, and the record can be read first.
 * Within the 12 s a session waits for a check after Claude exits, with the
 * usage check's own asks.
 */
export const SHOWN_WAIT_MS = 2_000;

/** Whether `output` shows `text` (see refusalKey). */
export function outputShows(output: string, text: string): boolean {
  const key = refusalKey(text);
  return key !== null && squeezed(output).includes(key);
}

export interface OutputLog {
  /** Output as it arrived, at `at` (milliseconds). */
  add(chunk: string, at: number): void;
  /** Whether output that arrived at or after `since` shows `text`. */
  shows(text: string, since: number): boolean;
}

/** Output kept for `keepMs`, and never more than `maxChars` of it. */
export function createOutputLog(options: { keepMs: number; maxChars: number }): OutputLog {
  const chunks: Array<{ text: string; at: number }> = [];
  let size = 0;
  return {
    add(chunk, at) {
      if (chunk === '') return;
      chunks.push({ text: chunk, at });
      size += chunk.length;
      const oldest = at - options.keepMs;
      while (chunks.length > 1 && ((chunks[0]?.at ?? at) < oldest || size > options.maxChars)) {
        size -= chunks.shift()?.text.length ?? 0;
      }
    },
    shows(text, since) {
      // Joined before it is squeezed, so a sequence or a word cut between two
      // chunks still reads whole.
      return outputShows(
        chunks
          .filter((c) => c.at >= since)
          .map((c) => c.text)
          .join(''),
        text,
      );
    },
  };
}
