import { spawnSync } from 'node:child_process';
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
  /** When the live process `pid` started, as Claude writes it in `procStart`; null when it cannot be read. */
  startOf?: (pid: number) => string | null;
}

/**
 * When the live process `pid` started, read the way Claude 2.1.302 reads its
 * own for `procStart` (`LC_ALL=C TZ=UTC ps -o lstart= -p <pid>`, from its
 * binary), so the two compare as text. Null on Windows, where Claude writes
 * `procStartFt` instead, when the process is gone, or when `ps` cannot say.
 */
export function processStart(pid: number, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'win32') return null;
  try {
    const out = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1000,
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    });
    const text = out.status === 0 && typeof out.stdout === 'string' ? out.stdout.trim() : '';
    return text === '' ? null : text;
  } catch {
    return null;
  }
}

/**
 * Whether the process a record names is still the one that wrote it. Claude
 * removes its record only on a clean exit, so a killed or crashed Claude's
 * stays, and its pid can go to another process. Where the record carries
 * `procStart` and the live process's start can be read, they must match.
 * Otherwise (Windows, an older Claude, `ps` unable to say) a live Claude
 * process holding that pid is all there is to go on, and it counts: counting
 * a stale record only waits for the usage check, as ccx did before.
 */
function stillItsWriter(
  record: { pid: number; procStart?: unknown },
  isClaude: (pid: number) => boolean,
  startOf: (pid: number) => string | null,
): boolean {
  if (typeof record.procStart === 'string') {
    const live = startOf(record.pid);
    if (live !== null) return spaced(live) === spaced(record.procStart);
  }
  return isClaude(record.pid);
}

const spaced = (text: string): string => text.trim().split(/\s+/).join(' ');

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
  const startOf = deps.startOf ?? ((pid: number) => processStart(pid));
  // The session's own folder too: its `sessions` is a link to the shared one
  // when ccx set it up, and holds its own Claude's record either way.
  const ownRoots = own.sessionDir === null ? [] : [own.sessionDir];
  let roots = [...ownRoots, ...own.configDirs];
  try {
    roots = [defaultClaudeRoot(c), ...ownRoots, ...own.configDirs];
  } catch {
    /* no home folder to look in: the session's and the accounts' own */
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
      const record = parsed as { pid?: unknown; sessionId?: unknown; entrypoint?: unknown; procStart?: unknown };
      const pid = record.pid;
      if (typeof pid !== 'number' || name !== `${pid}.json` || pid === own.claudePid) continue;
      if (record.sessionId !== conversation) continue;
      if (!stillItsWriter({ pid, procStart: record.procStart }, isClaude, startOf)) continue;
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
