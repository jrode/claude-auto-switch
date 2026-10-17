import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { otherLiveWriter } from './other-writers.js';
import type { SessionLease } from './lease.js';

const ID = '11111111-2222-4333-8444-555555555555';
const OTHER_ID = '99999999-2222-4333-8444-555555555555';

function folders(): { home: string; ctx: { env: Record<string, string> }; mine: string; account: string } {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-writers-'));
  const mine = path.join(home, 'sessions-of-ccx', 'mine');
  const account = path.join(home, 'profiles', 'A');
  for (const dir of [mine, account, path.join(home, '.claude', 'sessions')]) mkdirSync(dir, { recursive: true });
  return { home, ctx: { env: { HOME: home, USERPROFILE: home } }, mine, account };
}

/** A ccx session's folder, saying which conversation it is in. */
function ccxSession(home: string, name: string, conversation: string): string {
  const dir = path.join(home, 'sessions-of-ccx', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'claude-report.json'), JSON.stringify({ id: conversation }));
  return dir;
}
const lease = (configDir: string, pid: number): SessionLease => ({ account: 'A', pid, configDir, at: Date.now() });

/** Claude's own record of a process of its, in a config folder's `sessions`. */
function claudeRecord(configDir: string, pid: number, sessionId: string, extra: Record<string, unknown> = {}): void {
  const dir = path.join(configDir, 'sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId, kind: 'interactive', ...extra }));
}

describe('another live Claude on the same conversation', () => {
  it('is another ccx session whose folder says it is in the conversation', () => {
    const { home, ctx, mine, account } = folders();
    const theirs = ccxSession(home, 'theirs', ID);
    const elsewhere = ccxSession(home, 'elsewhere', OTHER_ID);
    const own = { sessionDir: mine, claudePid: 10, configDirs: [account] };
    const none = { isClaude: () => false };
    expect(otherLiveWriter(ID, own, ctx, { ...none, leases: () => [lease(theirs, 7)] })).toBe(
      'another ccx session (pid 7)',
    );
    // Its own announcement, and a session on another conversation, are not.
    expect(otherLiveWriter(ID, own, ctx, { ...none, leases: () => [lease(mine, 8), lease(elsewhere, 9)] })).toBeNull();
    expect(otherLiveWriter(ID, own, ctx, { ...none, leases: () => [lease(theirs, process.pid)] })).toBeNull();
  });

  it("is a live Claude whose own record names it: in the shared folder, or an account's", () => {
    const { home, ctx, mine, account } = folders();
    const own = { sessionDir: mine, claudePid: 10, configDirs: [account] };
    const alive = new Set([21, 22]);
    const deps = { leases: () => [], isClaude: (pid: number) => alive.has(pid) };
    expect(otherLiveWriter(ID, own, ctx, deps)).toBeNull();
    // The session's own Claude, a dead one, and one on another conversation are not.
    claudeRecord(path.join(home, '.claude'), 10, ID);
    claudeRecord(path.join(home, '.claude'), 20, ID);
    claudeRecord(path.join(home, '.claude'), 21, OTHER_ID);
    writeFileSync(path.join(home, '.claude', 'sessions', '23.json'), '{"pid": 23, "sess');
    expect(otherLiveWriter(ID, own, ctx, deps)).toBeNull();
    claudeRecord(path.join(home, '.claude'), 22, ID, { entrypoint: 'claude-desktop' });
    expect(otherLiveWriter(ID, own, ctx, deps)).toBe('another Claude (pid 22, claude-desktop)');
    // An editor's Claude keeps its record in the account's own folder.
    const editor = folders();
    claudeRecord(editor.account, 21, ID);
    expect(
      otherLiveWriter(ID, { sessionDir: editor.mine, claudePid: null, configDirs: [editor.account] }, editor.ctx, deps),
    ).toBe('another Claude (pid 21)');
  });
});
