import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireOwnedLock } from '../claude/locks.js';
import { readEvents } from '../events/log.js';
import {
  applyLedgerChange,
  clearAccountUpTo,
  ledgerFilePath,
  loadLedger,
  markCapped,
  updateLedger,
} from './ledger.js';
import type { Ledger } from './ledger.schema.js';

const HOUR = 3_600_000;

function home(): { home: string; c: { env: NodeJS.ProcessEnv } } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cas-ledger-update-'));
  return { home: dir, c: { env: { CLAUDE_AUTO_SWITCH_HOME: dir } } };
}

const capFor = (account: string, now = Date.now()) => (ledger: Ledger) =>
  markCapped(ledger, { account, now, resetAt: now + HOUR, reason: 'test' });

const accounts = (ledger: Ledger): string[] => ledger.caps.map((cap) => cap.account).sort();
const unlockedWrites = (dir: string) => readEvents(dir, 100).filter((e) => e.kind === 'ledger-unlocked');

describe('updateLedger', () => {
  it('applies the change to the ledger as it is on disk, and lets go of the lock', () => {
    const { home: dir, c } = home();
    updateLedger(c, capFor('A'));
    const written = updateLedger(c, capFor('B'));
    expect(accounts(written)).toEqual(['A', 'B']);
    expect(accounts(loadLedger(c))).toEqual(['A', 'B']);
    expect(existsSync(`${ledgerFilePath(c)}.lock`)).toBe(false);
    expect(unlockedWrites(dir)).toEqual([]);
  });

  it('writes nothing when the change hands back the ledger it was given', () => {
    const { c } = home();
    expect(updateLedger(c, (ledger) => ledger)).toEqual({ caps: [] });
    expect(existsSync(ledgerFilePath(c))).toBe(false);
  });

  it('lets go of the lock when the change throws, and leaves the ledger as it was', () => {
    const { home: dir, c } = home();
    updateLedger(c, capFor('A'));
    expect(() =>
      updateLedger(c, () => {
        throw new Error('the change failed');
      }),
    ).toThrow('the change failed');
    expect(existsSync(`${ledgerFilePath(c)}.lock`)).toBe(false);
    expect(accounts(loadLedger(c))).toEqual(['A']);
    // The next change gets the lock rather than waiting it out.
    updateLedger(c, capFor('B'), { waitMs: 60_000 });
    expect(accounts(loadLedger(c))).toEqual(['A', 'B']);
    expect(unlockedWrites(dir)).toEqual([]);
  });

  it('still makes the change when the lock is not free in time, and says so in the event log', () => {
    const { home: dir, c } = home();
    const lockFile = `${ledgerFilePath(c)}.lock`;
    // Held as a running holder holds it, one that will not let go in time.
    const holder = acquireOwnedLock(lockFile, { waitMs: 0, staleMs: 5_000 });
    expect(holder.held).toBe(true);
    try {
      const written = updateLedger(c, capFor('A'), { waitMs: 200 });
      expect(accounts(written)).toEqual(['A']);
      expect(accounts(loadLedger(c))).toEqual(['A']);
      expect(unlockedWrites(dir)).toHaveLength(1);
      // And the holder's lock is still the holder's.
      expect(existsSync(lockFile)).toBe(true);
    } finally {
      holder.release();
    }
  });

  it('takes over at once a lock left by a process that has exited', () => {
    const { home: dir, c } = home();
    const exited = spawnSync(process.execPath, ['-e', '']);
    expect(exited.status).toBe(0);
    writeFileSync(`${ledgerFilePath(c)}.lock`, String(exited.pid), 'utf8');

    const started = Date.now();
    updateLedger(c, capFor('A'), { waitMs: 30_000 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(accounts(loadLedger(c))).toEqual(['A']);
    expect(unlockedWrites(dir)).toEqual([]);
    expect(existsSync(`${ledgerFilePath(c)}.lock`)).toBe(false);
  });
});

describe('a change a run made, applied to the ledger as it stands', () => {
  const run = 10_000;

  it('records a cap exactly as markCapped does', () => {
    const cap = { account: 'A', now: run, resetAt: run + HOUR, reason: 'usage cap', model: 'Fable' };
    expect(applyLedgerChange({ caps: [] }, { kind: 'capped', cap })).toEqual(markCapped({ caps: [] }, cap));
  });

  it('clears the limits recorded up to when the run started, and keeps one recorded while it ran', () => {
    // The run worked, so the older limits are over. A newer one is another
    // session's answer about this account, which the run cannot overrule.
    const ledger: Ledger = {
      caps: [
        { account: 'A', capUntil: run + HOUR, reason: 'before the run', at: run - 1 },
        { account: 'A', capUntil: run + HOUR, reason: 'as the run started', at: run, model: 'Fable' },
        { account: 'A', capUntil: run + HOUR, reason: 'while it ran', at: run + 1, model: 'Opus' },
        { account: 'B', capUntil: run + HOUR, reason: 'another account', at: run - 1 },
      ],
    };
    const cleared = applyLedgerChange(ledger, { kind: 'cleared', account: 'A', upTo: run });
    expect(cleared.caps.map((cap) => `${cap.account}: ${cap.reason}`)).toEqual([
      'A: while it ran',
      'B: another account',
    ]);
  });

  it('hands back the same ledger when there is nothing to clear, so nothing is written', () => {
    const ledger: Ledger = { caps: [{ account: 'B', capUntil: null, reason: 'x', at: 1 }] };
    expect(clearAccountUpTo(ledger, 'A', run)).toBe(ledger);
    expect(clearAccountUpTo(ledger, 'B', 0)).toBe(ledger);
  });
});
