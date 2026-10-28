import { readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { configHome, type PathCtx } from '../config/paths.js';
import { writeFileAtomic } from '../util/atomic-write.js';
import { processIsAlive } from '../session/lease.js';
import { editorFolderPath } from './folder-login.js';

/**
 * The Claudes `ccx-claude` runs on the editor's folder, noted while they run.
 *
 * An editor chat is told by the record its Claude keeps in `sessions`, which
 * names the extension that started it (`claude-vscode`). A Claude another
 * program starts through `ccx-claude`, such as Conductor's, names itself
 * otherwise, so ccx would retire the folder or take it over with that Claude
 * running in it. Each note is the Claude's pid, when it started and the folder
 * it runs on, removed when it ends. A note counts only for that folder: a
 * Conductor user always has a chat open, and that must not hold off what ccx
 * does to an account's folder or to a copy of a folder it took over. A note
 * whose process is gone counts for nothing and is cleared.
 */
const notesDir = (c: PathCtx): string => path.join(configHome(c), 'editor-chats');

/** A folder by its real path, so a link and the folder it leads to are one. */
function realPath(folder: string): string {
  try {
    return realpathSync.native(folder);
  } catch {
    return path.resolve(folder);
  }
}

/**
 * Note that the Claude `pid` runs on `folder`, which on an old install's link is
 * the folder the link leads to. Returns the call that removes the note when it ends.
 */
export function noteEditorChat(
  c: PathCtx,
  pid: number,
  folder: string,
  startedAt: number = Date.now(),
): () => void {
  const file = path.join(notesDir(c), `${pid}.json`);
  try {
    writeFileAtomic(file, `${JSON.stringify({ pid, startedAt, folder: realPath(folder) })}\n`);
  } catch {
    /* the Claude then goes uncounted, as it did before there were notes */
  }
  return () => rmSync(file, { force: true });
}

/**
 * Whether a Claude noted on `folder` is running, other than one started at or
 * after `startedBefore` (see editorChatsOpen).
 */
export function editorChatNoted(c: PathCtx, folder: string, startedBefore?: number): boolean {
  const wanted = realPath(folder);
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
      const note = JSON.parse(readFileSync(file, 'utf8')) as {
        pid?: unknown;
        startedAt?: unknown;
        folder?: unknown;
      };
      if (typeof note.pid !== 'number' || name !== `${note.pid}.json`) continue;
      if (!processIsAlive(note.pid)) {
        rmSync(file, { force: true });
        continue;
      }
      // A note made before notes named their folder is the editor's, as every one was.
      const on = typeof note.folder === 'string' ? note.folder : realPath(editorFolderPath(c));
      if (on !== wanted) continue;
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
