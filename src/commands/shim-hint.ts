import { existsSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MARKER = '.shim-hinted';
/** When every shell was last found to have the shim. */
const COVERED = '.shim-covered';
const DAY_MS = 24 * 3_600_000;

/** Offer the transparent shim only while some shell lacks it, and only once. */
export function shouldHintShim(
  coverage: 'none' | 'some' | 'all',
  alreadyHinted: boolean,
): coverage is 'none' | 'some' {
  return coverage !== 'all' && !alreadyHinted;
}

export function shimHintText(coverage: 'none' | 'some' = 'none'): string {
  return coverage === 'some'
    ? 'tip: `claude` does not go through ccx in your other shells yet; run `ccx on` once to add them. (shown once)'
    : 'tip: run `ccx on` to type `claude` directly and auto-switch without `ccx run`. (shown once)';
}

export function wasHinted(configHome: string): boolean {
  return existsSync(path.join(configHome, MARKER));
}

/** Remember that the tip was shown, so it never repeats. */
export function markHinted(configHome: string): void {
  try {
    writeFileSync(path.join(configHome, MARKER), '');
  } catch {
    /* best effort: worst case the tip shows once more */
  }
}

/** Whether every shell had the shim when last looked at, within the past day. */
export function recentlyCovered(configHome: string, now = Date.now()): boolean {
  try {
    return now - statSync(path.join(configHome, COVERED)).mtimeMs < DAY_MS;
  } catch {
    return false;
  }
}

/** Remember that every shell has the shim, as of now. */
export function markCovered(configHome: string): void {
  try {
    writeFileSync(path.join(configHome, COVERED), '');
  } catch {
    /* best effort: worst case coverage is looked at again after the next session */
  }
}
