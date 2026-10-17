import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { PathCtx } from '../config/paths.js';
import { liveLeases, type SessionLease } from './lease.js';
import { readConversation } from './claude-report.js';
import { defaultClaudeRoot } from './shared-root.js';
import { isClaudeProcess } from '../desktop/desktop-sessions.js';

/**
 * Whether another live Claude is working on a conversation, as far as ccx
 * can know. Every Claude on a conversation appends to its one record, so a
 * refusal in it may be another one's.
 *
 * Two sources, both already kept, and both read only when a limit is being
 * decided:
 *
 * - ccx's own: each session it runs announces itself (session/lease), with
 *   its session folder, and records the conversation it is in there
 *   (session/claude-report). Another ccx session on the conversation shows
 *   up here even before its Claude has said so.
 * - Claude's own: every Claude keeps `<config folder>/sessions/<pid>.json`
 *   while it runs, naming its conversation. ccx's session folders link that
 *   folder to `~/.claude/sessions`, where Claude Desktop and a Claude started
 *   by hand keep theirs too; an editor launch keeps its in the account's own
 *   folder.
 *
 * A Claude that keeps its records somewhere else entirely is not seen.
 */

export interface Writers {
  /** This session's own folder, whose announcement is its own. */
  sessionDir: string | null;
  /** The pid of the Claude this session runs, whose record is its own. */
  claudePid: number | null;
  /** Config folders other Claudes may keep their records in: the accounts' own. */
  configDirs: string[];
}

export interface WritersDeps {
  leases?: () => SessionLease[];
  /** Whether a pid is a live Claude process. */
  isClaude?: (pid: number) => boolean;
}

/** Another live Claude on `conversation`, in words, or null when ccx knows of none. */
export function otherLiveWriter(
  conversation: string,
  own: Writers,
  c: PathCtx = {},
  deps: WritersDeps = {},
): string | null {
  const leases = deps.leases ?? (() => liveLeases(c));
  const ownFolder = own.sessionDir === null ? null : canonical(own.sessionDir);
  for (const lease of leases()) {
    if (lease.pid === process.pid || canonical(lease.configDir) === ownFolder) continue;
    if (readConversation(lease.configDir) === conversation) return `another ccx session (pid ${lease.pid})`;
  }
  const isClaude = deps.isClaude ?? ((pid: number) => isClaudeProcess(pid));
  let roots = own.configDirs;
  try {
    roots = [defaultClaudeRoot(c), ...own.configDirs];
  } catch {
    /* no home folder to look in: the accounts' own */
  }
  const folders = new Set(roots.map((dir) => canonical(path.join(dir, 'sessions'))));
  for (const folder of folders) {
    let names: string[];
    try {
      names = readdirSync(folder);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^\d+\.json$/.test(name)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path.join(folder, name), 'utf8'));
      } catch {
        continue; // caught mid-write
      }
      if (typeof parsed !== 'object' || parsed === null) continue;
      const record = parsed as { pid?: unknown; sessionId?: unknown; entrypoint?: unknown };
      const pid = record.pid;
      if (typeof pid !== 'number' || name !== `${pid}.json` || pid === own.claudePid) continue;
      if (record.sessionId !== conversation || !isClaude(pid)) continue;
      const where = typeof record.entrypoint === 'string' ? `, ${record.entrypoint}` : '';
      return `another Claude (pid ${pid}${where})`;
    }
  }
  return null;
}

/** The folder a path names, links followed, so a linked folder is not read twice. */
function canonical(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}
