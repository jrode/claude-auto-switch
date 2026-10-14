import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MARKER = '.shim-hinted';

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
