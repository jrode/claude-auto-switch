import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

const homeOf = (): { env: NodeJS.ProcessEnv } => ({
  env: { CLAUDE_AUTO_SWITCH_HOME: mkdtempSync(path.join(tmpdir(), 'cas-editor-chats-')) },
});

describe('the Claudes ccx-claude runs on the editor folder', () => {
  it('count while their process runs, and stop counting when their note is removed', async () => {
    const c = homeOf();
    const claude = stayingProcess();
    try {
      expect(editorChatNoted(c)).toBe(false);
      const ended = noteEditorChat(c, claude.pid);
      expect(editorChatNoted(c)).toBe(true);

      ended();

      expect(editorChatNoted(c)).toBe(false);
    } finally {
      await claude.end();
    }
  });

  it('count for nothing once their process is gone, and their note is cleared', async () => {
    const c = homeOf();
    const claude = stayingProcess();
    noteEditorChat(c, claude.pid);
    await claude.end();

    expect(editorChatNoted(c)).toBe(false);

    expect(readdirSync(path.join(c.env!.CLAUDE_AUTO_SWITCH_HOME!, 'editor-chats'))).toEqual([]);
  });

  it('do not count when started at or after the time given, as an editor chat started after its setting went does not', async () => {
    const c = homeOf();
    const claude = stayingProcess();
    try {
      noteEditorChat(c, claude.pid, 5_000);

      expect(editorChatNoted(c, 5_000)).toBe(false);
      expect(editorChatNoted(c, 5_001)).toBe(true);
      expect(editorChatNoted(c)).toBe(true);
    } finally {
      await claude.end();
    }
  });

  it('are not confused by what else is in the folder', async () => {
    const c = homeOf();
    const claude = stayingProcess();
    try {
      const dir = path.join(c.env!.CLAUDE_AUTO_SWITCH_HOME!, 'editor-chats');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'notes.txt'), 'not a note');
      writeFileSync(path.join(dir, '123.json'), 'not json');
      writeFileSync(
        path.join(dir, `${claude.pid}.json`),
        JSON.stringify({ pid: claude.pid + 1, startedAt: 1 }),
      );

      expect(editorChatNoted(c)).toBe(false);
      expect(existsSync(path.join(dir, 'notes.txt'))).toBe(true);
    } finally {
      await claude.end();
    }
  });
});
