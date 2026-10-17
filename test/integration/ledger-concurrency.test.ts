import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addAccount } from '../../src/accounts/registry.js';
import { renameAccount } from '../../src/accounts/rename.js';
import { capCommand } from '../../src/commands/cap.js';
import { loadConfig } from '../../src/config/config.js';
import { readEvents } from '../../src/events/log.js';
import type { CliContext } from '../../src/context.js';

/**
 * Two ccx processes changing the limits ledger at once. Every change reads the
 * whole file and writes it back, so one that reads while another's change is in
 * progress, and writes after it, erases that change: a limit another session
 * recorded is gone, and the account goes back into rotation while it is out.
 *
 * The other process here takes the ledger's lock, reads the file, and only
 * writes it back a while later, as any change does in the moment between its
 * read and its write. The command under test must wait for it and build on what
 * it wrote. Children run through tsx (a devDependency), so no build is needed.
 */

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const TSX = path.join(REPO, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const moduleAt = (...parts: string[]): string => JSON.stringify(path.join(REPO, 'src', ...parts).split(path.sep).join('/'));
/** How long the other process holds the lock between its read and its write; well inside the 5 s a change waits. */
const HOLD_MS = 2_000;

interface Cap {
  account: string;
  capUntil: number | null;
  reason: string;
  at: number;
}

const capsIn = (home: string): Cap[] => {
  const file = path.join(home, 'ledger.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { caps: Cap[] }).caps : [];
};
const accountsIn = (home: string): string[] => capsIn(home).map((cap) => cap.account).sort();
const unlockedWrites = (home: string) => readEvents(home, 100).filter((e) => e.kind === 'ledger-unlocked');

/**
 * Another process recording a limit for `account`: it holds the lock from its
 * read to its write, `HOLD_MS` apart. `reading` settles once it has read.
 */
function anotherWriter(home: string, account: string): { reading: Promise<void>; exited: Promise<{ code: number | null; stderr: string }> } {
  const script = path.join(home, `writer-${account}.ts`);
  const marker = path.join(home, `writer-${account}.read`);
  writeFileSync(
    script,
    [
      `import { existsSync, readFileSync, writeFileSync } from 'node:fs';`,
      `import path from 'node:path';`,
      `import { acquireOwnedLock } from ${moduleAt('claude', 'locks.ts')};`,
      `import { writeJsonFile } from ${moduleAt('util', 'fs-json.ts')};`,
      `const [home, account, marker, holdMs] = process.argv.slice(2);`,
      `const file = path.join(home, 'ledger.json');`,
      `const lock = acquireOwnedLock(file + '.lock', { waitMs: 30000, staleMs: 5000 });`,
      `if (!lock.held) throw new Error('the other writer could not take the ledger lock');`,
      `const ledger = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { caps: [] };`,
      `writeFileSync(marker, '');`,
      `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));`,
      `ledger.caps.push({ account, capUntil: Date.now() + 3600000, reason: 'another session', at: Date.now() });`,
      `writeJsonFile(file, ledger);`,
      `lock.release();`,
    ].join('\n'),
    'utf8',
  );

  let stderr = '';
  let ended = false;
  const exited = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(TSX, [script, home, account, marker, String(HOLD_MS)], {
      stdio: ['ignore', 'ignore', 'pipe'],
      shell: process.platform === 'win32',
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('exit', (code) => {
      ended = true;
      resolve({ code, stderr });
    });
  });
  const reading = (async () => {
    await vi.waitUntil(() => existsSync(marker) || ended, { timeout: 30_000, interval: 20 });
    expect(existsSync(marker), `the other writer ended before it read: ${stderr}`).toBe(true);
  })();
  return { reading, exited };
}

function setup(names: string[]): { home: string; context: CliContext } {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-ledger-race-'));
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
  for (const name of names) {
    const dir = path.join(home, 'profiles', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '.credentials.json'), '{}', 'utf8');
    addAccount({ name, dir }, ctx);
  }
  const context: CliContext = { ctx, config: loadConfig(ctx), out: () => {}, err: () => {}, json: false, quiet: false };
  return { home, context };
}

describe('two processes changing the limits ledger at once', () => {
  it('ccx cap waits for a change already in progress, and both limits are kept', async () => {
    const { home, context } = setup(['A']);
    const other = anotherWriter(home, 'B');
    await other.reading;
    // Started after the other process read, before it writes.
    expect(capCommand(context, 'A')).toBe(0);
    const { code, stderr } = await other.exited;
    expect(code, stderr).toBe(0);

    expect(accountsIn(home)).toEqual(['A', 'B']);
    // Waited for the lock, rather than writing past it once the wait ran out.
    expect(unlockedWrites(home)).toEqual([]);
  }, 60_000);

  it('ccx cap --clear clears only its own account, and keeps the limit recorded meanwhile', async () => {
    const { home, context } = setup(['A']);
    expect(capCommand(context, 'A')).toBe(0);
    const other = anotherWriter(home, 'B');
    await other.reading;
    expect(capCommand(context, 'A', { clear: true })).toBe(0);
    const { code, stderr } = await other.exited;
    expect(code, stderr).toBe(0);

    expect(accountsIn(home)).toEqual(['B']);
    expect(unlockedWrites(home)).toEqual([]);
  }, 60_000);

  it('a rename moves the limits to the new name, and keeps the one recorded meanwhile', async () => {
    const { home, context } = setup(['old']);
    expect(capCommand(context, 'old')).toBe(0);
    const other = anotherWriter(home, 'B');
    await other.reading;
    renameAccount('old', 'new', {}, context.ctx);
    const { code, stderr } = await other.exited;
    expect(code, stderr).toBe(0);

    expect(accountsIn(home)).toEqual(['B', 'new']);
    expect(unlockedWrites(home)).toEqual([]);
  }, 60_000);
});
