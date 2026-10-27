import { readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { configHome, type PathCtx } from '../config/paths.js';
import { writeFileAtomic } from '../util/atomic-write.js';
import { processIsAlive } from '../session/lease.js';

/**
 * The Claudes `ccx-claude` runs on the editor's folder, noted while they run.
 *
 * An editor chat is told by the record its Claude keeps in `sessions`, which
 * names the extension that started it (`claude-vscode`). A Claude another
 * program starts through `ccx-claude`, such as Conductor's, names itself
 * otherwise, so ccx would retire the folder or take it over with that Claude
 * running in it. Each note is the Claude's pid and when it started, removed
 * when it ends. A note whose process is gone counts for nothing and is cleared.
 */
const notesDir = (c: PathCtx): string => path.join(configHome(c), 'editor-chats');

/** Note that the Claude `pid` runs on the editor's folder. Returns the call that removes the note when it ends. */
export function noteEditorChat(
  c: PathCtx,
  pid: number,
  startedAt: number = Date.now(),
): () => void {
  const file = path.join(notesDir(c), `${pid}.json`);
  try {
    writeFileAtomic(file, `${JSON.stringify({ pid, startedAt })}\n`);
  } catch {
    /* the Claude then goes uncounted, as it did before there were notes */
  }
  return () => rmSync(file, { force: true });
}

/**
 * Whether a Claude noted on the editor's folder is running, other than one
 * started at or after `startedBefore` (see editorChatsOpen).
 */
export function editorChatNoted(c: PathCtx, startedBefore?: number): boolean {
  let names: string[];
  try {
    names = readdirSync(notesDir(c));
  } catch {
    return false;
  }
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    const file = path.join(notesDir(c), name);
    try {
      const note = JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown; startedAt?: unknown };
      if (typeof note.pid !== 'number' || name !== `${note.pid}.json`) continue;
      if (!processIsAlive(note.pid)) {
        rmSync(file, { force: true });
        continue;
      }
      if (
        startedBefore !== undefined &&
        typeof note.startedAt === 'number' &&
        note.startedAt >= startedBefore
      )
        continue;
      return true;
    } catch {
      /* unreadable or gone: not one */
    }
  }
  return false;
}
