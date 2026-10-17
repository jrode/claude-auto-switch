import { describe, it, expect } from 'vitest';
import { createLimitMenuWatch } from './limit-menu.js';

/** What Claude 2.1.280 printed for its usage-limit menu on Windows (captured through a pseudo-terminal). */
const DRAWN =
  '\u001b[1m\u001b[15;3HWhat do you want to do?\u001b[m\r\n\u001b[K\r\n  \u001b[38;2;177;185;249m❯' +
  '\u001b[38;2;153;153;153m\u001b[1C1. \u001b[38;2;177;185;249mStop and wait for limit to reset\u001b[m\r\n' +
  '    \u001b[38;2;153;153;153m2. \u001b[mWait here, then continue automatically at Oct 22, 1pm\u001b[K\u001b[19;3H' +
  '  \u001b[38;2;153;153;153m3. \u001b[mSwitch to usage credits\u001b[K';

/** The same row drawn as a newer Claude draws: each changed cell moved to in turn, last to first. */
function byCells(row: number, col: number, text: string): string {
  let out = '';
  for (let i = text.length - 1; i >= 0; i--) out += `\u001b[${row};${col + i}H${text[i]}`;
  return out;
}

describe("seeing Claude's usage-limit menu", () => {
  it('sees it as Claude draws it, escapes and all', () => {
    expect(createLimitMenuWatch().observe(DRAWN)).toBe(true);
  });

  it('sees it when a read splits it anywhere', () => {
    for (let at = 1; at < DRAWN.length; at += 7) {
      const watch = createLimitMenuWatch();
      expect(watch.observe(DRAWN.slice(0, at)) || watch.observe(DRAWN.slice(at)), `split at ${at}`).toBe(true);
    }
  });

  it('sees it drawn cell by cell, out of order', () => {
    expect(createLimitMenuWatch().observe(byCells(16, 5, '1. Stop and wait for limit to reset'))).toBe(true);
  });

  it('sees it drawn over what was there, only the cells that changed', () => {
    const watch = createLimitMenuWatch();
    // The row held text that shares cells with the menu's line; only the
    // differing cells are drawn again.
    const before = '1. Stop and wait for the build';
    const after = '1. Stop and wait for limit to reset';
    expect(watch.observe(`\u001b[16;5H${before}`)).toBe(false);
    let changed = '';
    for (let i = after.length - 1; i >= 0; i--) {
      if (after[i] !== before[i]) changed += `\u001b[16;${5 + i}H${after[i]}`;
    }
    expect(watch.observe(changed)).toBe(true);
  });

  it('is not the limit message, or a conversation about the menu split across lines', () => {
    const watch = createLimitMenuWatch();
    expect(watch.observe("You've hit your weekly limit · resets Oct 22, 1pm\r\n")).toBe(false);
    expect(watch.observe('Claude may ask you to stop and wait\r\nfor the limit to reset.\r\n')).toBe(false);
  });

  it('says so only for a drawing it has just seen, not for the menu still sitting there', () => {
    const watch = createLimitMenuWatch();
    expect(watch.observe(DRAWN)).toBe(true);
    // Something else changes elsewhere on the screen.
    expect(watch.observe('\u001b[30;1Hworking')).toBe(false);
    // The menu is erased; drawing over its row with other text is not the menu.
    expect(watch.observe('\u001b[17;1H\u001b[2KAllow this command? (y/n)')).toBe(false);
  });
});
