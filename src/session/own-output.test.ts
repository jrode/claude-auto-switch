import { describe, it, expect } from 'vitest';
import { createOutputLog, refusalKey, squeezed } from './own-output.js';

const LIMIT = "You've hit your session limit · resets 6pm (America/New_York)";
const ESC = String.fromCharCode(27);

describe("telling whether a run's own output shows a refusal", () => {
  it('finds it in colour, in pieces, wrapped, or with the cursor moved over spaces', () => {
    const log = createOutputLog({ keepMs: 60_000, maxChars: 100_000 });
    log.add(`${ESC}]0;claude${ESC}\\${ESC}[2K${ESC}[1A  ⎿  ${ESC}[31mYou've hit your`, 1000);
    log.add(`${ESC}[1Csession lim`, 1001);
    log.add(`it${ESC}[39m ${ESC}[2m· resets 6pm\r\n     (America/New_York)${ESC}[22m`, 1002);
    expect(log.shows(LIMIT, 1000)).toBe(true);
  });

  it('only from output since the time asked about', () => {
    const log = createOutputLog({ keepMs: 60_000, maxChars: 100_000 });
    log.add(`${LIMIT}\n`, 1000);
    log.add('working on it\n', 5000);
    expect(log.shows(LIMIT, 1000)).toBe(true);
    // Old words on the screen, as a resumed conversation shows them, are not this refusal.
    expect(log.shows(LIMIT, 1001)).toBe(false);
  });

  it('tells one limit message from another by its reset time', () => {
    const log = createOutputLog({ keepMs: 60_000, maxChars: 100_000 });
    log.add("You've hit your session limit · resets 2pm (America/New_York)\n", 1000);
    expect(log.shows(LIMIT, 0)).toBe(false);
  });

  it('keeps output only as long, and only as much, as it was told', () => {
    const log = createOutputLog({ keepMs: 1_000, maxChars: 100_000 });
    log.add(LIMIT, 1000);
    log.add('later', 2001);
    expect(log.shows(LIMIT, 0)).toBe(false);
    const small = createOutputLog({ keepMs: 60_000, maxChars: 20 });
    small.add(LIMIT, 1000);
    small.add('x'.repeat(30), 1001);
    expect(small.shows(LIMIT, 0)).toBe(false);
  });

  it('needs enough of the text to tell it apart', () => {
    expect(refusalKey('   \n  short  ')).toBeNull();
    expect(refusalKey(`${LIMIT}\nmore`)).toBe("You'vehityoursessionlimit·resets6pm(America/New_");
    expect(createOutputLog({ keepMs: 1, maxChars: 1 }).shows('', 0)).toBe(false);
  });

  it('takes out terminal sequences and whitespace, and nothing else', () => {
    expect(squeezed(`a ${ESC}[1;31mb${ESC}[0m${ESC}7c${ESC}(B d\te`)).toBe('abcde');
  });
});
