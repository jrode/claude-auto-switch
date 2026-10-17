/**
 * Seeing Claude's own usage-limit menu in what it prints.
 *
 * On a usage limit Claude 2.1.280 runs /rate-limit-options by itself and
 * shows (measured):
 *
 *   What do you want to do?
 *   ❯ 1. Stop and wait for limit to reset
 *     2. Wait here, then continue automatically at <reset>
 *     3. Switch to usage credits
 *
 * It says "waiting" for as long as the menu is open, and the menu never
 * closes by itself. Its first choice is said nowhere else, so that is what is
 * looked for, and Claude's record of the conversation says nothing of the
 * menu, so the screen is the only place to look.
 *
 * Not in the text as it streams by: a newer Claude draws only the cells that
 * changed, each moved to in turn and in any order, so a line is never written
 * whole. What it prints is played onto a small model of the screen instead
 * (cursor moves, erases, text), and the rows it just drew on are read back.
 * Colours and spacing are left out, and spaces with them, since a terminal
 * can move the cursor over a space instead of writing one.
 */

const ESC = '\u001b';
const MENU_WORDS = 'Stopandwaitforlimittoreset';
/** A complete control sequence at the reading position: parameters, intermediates, final byte. */
const CSI = /\u001b\[([0-9;?]*)[ -/]*([@-~])/y;
/** The start of one a read may have cut short. */
const CSI_SO_FAR = /^\u001b\[[0-9;?]*[ -/]*$/;

export interface LimitMenuWatch {
  /** Read one chunk of what Claude printed; true when it just drew the menu. */
  observe(data: string): boolean;
}

/** `rows`: the screen's height, past which a new line scrolls it. */
export function createLimitMenuWatch(rows = 60): LimitMenuWatch {
  const grid: string[][] = [];
  let row = 0;
  let col = 0;
  /** A sequence a read cut in two, put back in front of the next read. */
  let held = '';

  const line = (r: number): string[] => (grid[r] ??= []);
  /** Whether text was drawn on the cursor's row since it was last read back. */
  let drawn = false;
  /** Whether the menu was seen during the current read. */
  let seen = false;
  /** Read the cursor's row back, if it was drawn on, before the cursor leaves it or it is erased. */
  const readBack = (): void => {
    if (drawn && (grid[row] ?? []).join('').replace(/\s+/g, '').includes(MENU_WORDS)) seen = true;
    drawn = false;
  };
  const clamp = (): void => {
    row = Math.max(0, Math.min(rows - 1, row));
    col = Math.max(0, col);
  };
  const newline = (): void => {
    readBack();
    row += 1;
    if (row >= rows) {
      grid.shift();
      row = rows - 1;
    }
  };

  const control = (params: string, final: string): void => {
    const nums = params.replace(/\?/g, '').split(';').map((p) => Number(p) || 0);
    const n = Math.max(1, nums[0] ?? 0);
    // Colours, modes and the rest move nothing and erase nothing.
    if (!'HfG`dABeCaDEFKJ'.includes(final)) return;
    readBack();
    switch (final) {
      case 'H':
      case 'f':
        row = (nums[0] || 1) - 1;
        col = (nums[1] || 1) - 1;
        break;
      case 'G':
      case '`':
        col = (nums[0] || 1) - 1;
        break;
      case 'd':
        row = (nums[0] || 1) - 1;
        break;
      case 'A':
        row -= n;
        break;
      case 'B':
      case 'e':
        row += n;
        break;
      case 'C':
      case 'a':
        col += n;
        break;
      case 'D':
        col -= n;
        break;
      case 'E':
        row += n;
        col = 0;
        break;
      case 'F':
        row -= n;
        col = 0;
        break;
      case 'K': {
        const cells = line(row);
        if ((nums[0] ?? 0) === 2) cells.length = 0;
        else if ((nums[0] ?? 0) === 1) cells.fill(' ', 0, col + 1);
        else cells.length = Math.min(cells.length, col);
        break;
      }
      case 'J': {
        const mode = nums[0] ?? 0;
        if (mode === 2 || mode === 3) grid.length = 0;
        else if (mode === 0) {
          line(row).length = Math.min(line(row).length, col);
          grid.length = Math.min(grid.length, row + 1);
        }
        break;
      }
    }
    clamp();
  };

  return {
    observe(data) {
      const text = held + data;
      held = '';
      seen = false;
      let i = 0;
      while (i < text.length) {
        const ch = text[i] as string;
        if (ch === ESC) {
          if (i + 1 >= text.length) {
            held = text.slice(i);
            break;
          }
          if (text[i + 1] === '[') {
            CSI.lastIndex = i;
            const m = CSI.exec(text);
            if (m) {
              control(m[1] ?? '', m[2] ?? '');
              i = CSI.lastIndex;
              continue;
            }
            if (CSI_SO_FAR.test(text.slice(i))) {
              held = text.slice(i);
              break;
            }
            i += 2;
            continue;
          }
          if (text[i + 1] === ']') {
            // A title or a link, ended by BEL or ESC backslash.
            const bel = text.indexOf('\u0007', i + 2);
            const st = text.indexOf(`${ESC}\\`, i + 2);
            const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
            if (end === -1) {
              held = text.slice(i);
              break;
            }
            i = end + (end === st ? 2 : 1);
            continue;
          }
          i += 2;
          continue;
        }
        if (ch === '\r') col = 0;
        else if (ch === '\n') newline();
        else if (ch === '\b') col = Math.max(0, col - 1);
        else if (ch >= ' ' && ch !== '\u007f') {
          line(row)[col] = ch;
          drawn = true;
          col += 1;
        }
        i += 1;
      }
      readBack();
      return seen;
    },
  };
}
