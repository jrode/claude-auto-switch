import { describe, it, expect } from 'vitest';
import { repaint, screenSequences } from './dashboard.js';

/**
 * The dashboard draws a full-screen live view. Everywhere but Windows it does so
 * on the alternate screen buffer, which restores the prior scrollback on exit.
 * On Windows it must NOT, because leaving the alternate screen (`?1049l`) is a
 * buffer swap that, landing as the process exits or hands off to a sign-in,
 * races ConPTY's teardown and crashes the terminal. These pin that split so it
 * cannot silently regress.
 */

const ENTER_ALT = '\x1b[?1049h';
const EXIT_ALT = '\x1b[?1049l';

describe('screenSequences', () => {
  it('uses the alternate screen off Windows, and leaves it on exit', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const seq = screenSequences(platform);
      expect(seq.usesAltScreen).toBe(true);
      expect(seq.enter).toContain(ENTER_ALT);
      expect(seq.epilogue).toContain(EXIT_ALT);
    }
  });

  it('never touches the alternate screen on Windows', () => {
    const seq = screenSequences('win32');
    expect(seq.usesAltScreen).toBe(false);
    // The crash is the enter/leave of the alternate buffer; neither sequence may
    // contain it on Windows.
    expect(seq.enter).not.toContain(ENTER_ALT);
    expect(seq.enter).not.toContain(EXIT_ALT);
    expect(seq.epilogue).not.toContain(EXIT_ALT);
    expect(seq.epilogue).not.toContain('\x1b[?1049');
  });

  it('still shows the cursor again on exit, on every platform', () => {
    const SHOW_CURSOR = '\x1b[?25h';
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(screenSequences(platform).epilogue).toContain(SHOW_CURSOR);
    }
  });

  it('starts the Windows dashboard on a cleared main screen', () => {
    // No alternate buffer to give a blank canvas, so the first frame clears the
    // screen and homes the cursor itself.
    const seq = screenSequences('win32');
    expect(seq.enter).toContain('\x1b[2J');
    expect(seq.enter).toContain('\x1b[H');
  });
});

describe('repaint', () => {
  /**
   * How many lines a repaint scrolls the screen by. It starts on the top row
   * and each line break moves down one; a break on the last row scrolls. On
   * Windows the dashboard is on the main screen, so every scrolled line lands
   * in the scrollback: the top of the dashboard piling up there on every tick.
   */
  const scrolled = (written: string, rows: number): number => {
    expect(written.startsWith('\x1b[H')).toBe(true);
    const breaks = written.split('\r\n').length - 1;
    return Math.max(0, 1 + breaks - rows);
  };
  const frame = (lines: number): string => Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n');

  it('never scrolls the screen, whatever the frame it is handed', () => {
    for (const rows of [1, 2, 3, 10, 24, 50]) {
      for (const lines of [1, rows - 1, rows, rows + 1, rows * 3]) {
        expect(scrolled(repaint(frame(lines), rows), rows), `${lines} lines on ${rows} rows`).toBe(0);
      }
    }
  });

  it('draws a frame that fits as it is, each line clearing its own tail, then clears below', () => {
    expect(repaint('a\nb', 10)).toBe('\x1b[Ha\x1b[K\r\nb\x1b[K\r\n\x1b[J');
  });

  it('keeps the top of a frame that does not fit', () => {
    const written = repaint(frame(30), 10);
    expect(written).toContain('line 1\x1b[K');
    expect(written).toContain('line 9\x1b[K');
    expect(written).not.toContain('line 10');
  });

  it('draws the whole frame when the screen size is not known', () => {
    expect(repaint(frame(30), undefined)).toContain('line 30');
    // What a terminal that cannot say its size reports, read as unknown here
    // as the renderer reads it, rather than as a screen with no rows.
    expect(repaint(frame(30), 0)).toContain('line 30');
  });

  it('draws nothing on a one-row window rather than scroll it', () => {
    expect(repaint(frame(5), 1)).toBe('\x1b[H\x1b[J');
  });
});
