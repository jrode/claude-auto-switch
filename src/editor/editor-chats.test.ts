import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTarget } from '../daemon/junction.js';
import { editorChatNoted, noteEditorChat } from './editor-chats.js';

/** A process that runs until it is killed, standing in for a Claude. */
function stayingProcess(): { pid: number; end: () => Promise<void> } {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return {
    pid: child.pid!,
    end: () => {
      child.kill();
      return exited;
    },
  };
}

/** ccx's home with the editor's folder, an account's folder and the copy of a folder ccx took over. */
function scene(): {
  c: { env: NodeJS.ProcessEnv };
  root: string;
  folder: string;
  account: string;
  aside: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), 'cas-editor-chats-'));
  const home = path.join(root, 'ccx');
  const folder = path.join(home, 'editor-active');
  const account = path.join(home, 'profiles', 'A');
  const aside = `${folder}.taken-over`;
  for (const dir of [folder, account, aside]) mkdirSync(dir, { recursive: true });
  return { c: { env: { CLAUDE_AUTO_SWITCH_HOME: home } }, root, folder, account, aside };
}

describe('the Claudes ccx-claude runs on the editor folder', () => {
  it('count while their process runs, and stop counting when their note is removed', async () => {
    const { c, folder } = scene();
    const claude = stayingProcess();
    try {
      expect(editorChatNoted(c, folder)).toBe(false);
      const ended = noteEditorChat(c, claude.pid, folder);
      expect(editorChatNoted(c, folder)).toBe(true);

      ended();

      expect(editorChatNoted(c, folder)).toBe(false);
    } finally {
      await claude.end();
    }
  });

  it('count for nothing once their process is gone, and their note is cleared', async () => {
    const { c, folder } = scene();
    const claude = stayingProcess();
    noteEditorChat(c, claude.pid, folder);
    await claude.end();

    expect(editorChatNoted(c, folder)).toBe(false);

    expect(readdirSync(path.join(c.env.CLAUDE_AUTO_SWITCH_HOME!, 'editor-chats'))).toEqual([]);
  });

  it('do not count when started at or after the time given, as an editor chat started after its setting went does not', async () => {
    const { c, folder } = scene();
    const claude = stayingProcess();
    try {
      noteEditorChat(c, claude.pid, folder, 5_000);

      expect(editorChatNoted(c, folder, 5_000)).toBe(false);
      expect(editorChatNoted(c, folder, 5_001)).toBe(true);
      expect(editorChatNoted(c, folder)).toBe(true);
    } finally {
      await claude.end();
    }
  });

  it('count only for the folder they run on, and for the one an old install links to', async () => {
    const { c, root, folder, account, aside } = scene();
    // An install from before the editor had a folder of its own: its path is a link to an account's folder.
    const link = path.join(root, 'link');
    setTarget(link, account);
    const onFolder = stayingProcess();
    const throughLink = stayingProcess();
    try {
      noteEditorChat(c, onFolder.pid, folder);

      expect(editorChatNoted(c, folder)).toBe(true);
      // Not for an account's folder, nor for the copy of a folder ccx took over.
      expect(editorChatNoted(c, account)).toBe(false);
      expect(editorChatNoted(c, aside)).toBe(false);

      noteEditorChat(c, throughLink.pid, link);

      expect(editorChatNoted(c, account)).toBe(true);
      expect(editorChatNoted(c, link)).toBe(true);
      expect(editorChatNoted(c, aside)).toBe(false);
    } finally {
      await onFolder.end();
      await throughLink.end();
    }
  });

  it("count a note made without a folder for the editor's folder, as every note was", async () => {
    const { c, folder, account } = scene();
    const claude = stayingProcess();
    try {
      const dir = path.join(c.env.CLAUDE_AUTO_SWITCH_HOME!, 'editor-chats');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, `${claude.pid}.json`),
        JSON.stringify({ pid: claude.pid, startedAt: 1 }),
      );

      expect(editorChatNoted(c, folder)).toBe(true);
      expect(editorChatNoted(c, account)).toBe(false);
    } finally {
      await claude.end();
    }
  });

  it('are not confused by what else is in the folder', async () => {
    const { c, folder } = scene();
    const claude = stayingProcess();
    try {
      const dir = path.join(c.env.CLAUDE_AUTO_SWITCH_HOME!, 'editor-chats');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'notes.txt'), 'not a note');
      writeFileSync(path.join(dir, '123.json'), 'not json');
      writeFileSync(
        path.join(dir, `${claude.pid}.json`),
        JSON.stringify({ pid: claude.pid + 1, startedAt: 1 }),
      );

      expect(editorChatNoted(c, folder)).toBe(false);
      expect(existsSync(path.join(dir, 'notes.txt'))).toBe(true);
    } finally {
      await claude.end();
    }
  });
});
