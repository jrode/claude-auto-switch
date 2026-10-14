import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CliContext } from '../context.js';

/** How often the editor's pointer was written. */
const writes = vi.hoisted(() => ({ count: 0 }));
vi.mock('../daemon/junction.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../daemon/junction.js')>();
  return {
    ...real,
    setTarget: (...args: Parameters<typeof real.setTarget>) => {
      writes.count += 1;
      return real.setTarget(...args);
    },
  };
});

const { setTarget } = await import('../daemon/junction.js');
const { editorLinkPath, editorPointerAccount, syncEditorPointerIfEnabled } = await import('./junction.js');
const { addCommand } = await import('../commands/add.js');
const { setActive } = await import('../state/active.js');
const { listAccounts } = await import('../accounts/registry.js');
const { loadConfig } = await import('../config/config.js');

async function editorOn(names: string[]): Promise<{ home: string; context: CliContext }> {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-editor-sync-'));
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home, APPDATA: home } };
  const context: CliContext = { ctx, config: loadConfig(ctx), out: () => {}, err: () => {}, json: false, quiet: false };
  for (const name of names) {
    const dir = path.join(home, 'profiles', name);
    await addCommand(context, name, { dir, login: false });
    mkdirSync(dir, { recursive: true });
    // Good for hours, so nothing about renewing it comes into this.
    const login = { accessToken: `a-${name}`, refreshToken: `r-${name}`, expiresAt: Date.now() + 8 * 3_600_000 };
    writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: login }), 'utf8');
  }
  setTarget(editorLinkPath(ctx), path.join(home, 'profiles', names[0]!));
  return { home, context };
}

describe('pointing the editor at the active account', () => {
  beforeEach(() => {
    writes.count = 0;
  });

  it('leaves a pointer that already points there as it is', async () => {
    // Rewriting it removes and recreates the link, and two sessions moving at
    // once could then meet each other's half-made link.
    const { context } = await editorOn(['A', 'B']);
    setActive('A', context.ctx);
    writes.count = 0;
    syncEditorPointerIfEnabled(context);
    expect(writes.count).toBe(0);
    expect(editorPointerAccount(listAccounts(context.ctx), context.ctx)).toBe('A');
  });

  it('moves it when the active account changes', async () => {
    const { context } = await editorOn(['A', 'B']);
    setActive('B', context.ctx);
    writes.count = 0;
    syncEditorPointerIfEnabled(context);
    expect(writes.count).toBe(1);
    expect(editorPointerAccount(listAccounts(context.ctx), context.ctx)).toBe('B');
  });

  it('never throws, and leaves the pointer alone, when the file naming the active account cannot be read', async () => {
    // Called from a session's poll, where nothing would catch it.
    const { home, context } = await editorOn(['A', 'B']);
    writeFileSync(path.join(home, 'active.json'), '{not json', 'utf8');
    expect(() => syncEditorPointerIfEnabled(context)).not.toThrow();
    expect(editorPointerAccount(listAccounts(context.ctx), context.ctx)).toBe('A');
  });
});
