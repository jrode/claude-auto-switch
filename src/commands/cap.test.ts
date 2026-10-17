import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { capCommand } from './cap.js';
import { addAccount } from '../accounts/registry.js';
import { loadConfig } from '../config/config.js';
import { loadLedger } from '../ledger/ledger.js';
import type { CliContext } from '../context.js';

const MIN = 60_000;

function setup(names: string[]): { home: string; context: CliContext; said: string[] } {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-cap-'));
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home } };
  const said: string[] = [];
  for (const name of names) addAccount({ name, dir: path.join(home, 'profiles', name) }, ctx);
  const context: CliContext = { ctx, config: loadConfig(ctx), out: (m) => said.push(m), json: false, quiet: false };
  return { home, context, said };
}

describe('ccx cap', () => {
  it('caps an account until the time given, as a manual cap', () => {
    const { context, said } = setup(['A']);
    expect(capCommand(context, 'A', { until: '2030-01-01T00:00:00Z' })).toBe(0);
    expect(loadLedger(context.ctx).caps).toEqual([
      expect.objectContaining({ account: 'A', capUntil: Date.parse('2030-01-01T00:00:00Z'), reason: 'manual cap' }),
    ]);
    expect(said).toEqual(['marked "A" capped until 2030-01-01T00:00:00.000Z']);
  });

  it('caps for the minutes given, or for the configured backoff, and leaves other accounts alone', () => {
    const { context } = setup(['A', 'B']);
    const before = Date.now();
    expect(capCommand(context, 'A', { minutes: '30' })).toBe(0);
    expect(capCommand(context, 'B')).toBe(0);
    const after = Date.now();
    const until = (name: string): number => loadLedger(context.ctx).caps.find((c) => c.account === name)?.capUntil ?? 0;
    expect(until('A')).toBeGreaterThanOrEqual(before + 30 * MIN);
    expect(until('A')).toBeLessThanOrEqual(after + 30 * MIN);
    const backoff = context.config.rotation.defaultBackoffMinutes * MIN;
    expect(until('B')).toBeGreaterThanOrEqual(before + backoff);
    expect(until('B')).toBeLessThanOrEqual(after + backoff);
  });

  it("replaces the account's earlier cap rather than adding another", () => {
    const { context } = setup(['A']);
    capCommand(context, 'A', { until: '2030-01-01T00:00:00Z' });
    capCommand(context, 'A', { until: '2031-01-01T00:00:00Z' });
    expect(loadLedger(context.ctx).caps.map((c) => c.capUntil)).toEqual([Date.parse('2031-01-01T00:00:00Z')]);
  });

  it('clears the named account only', () => {
    const { context, said } = setup(['A', 'B']);
    capCommand(context, 'A');
    capCommand(context, 'B');
    expect(capCommand(context, 'A', { clear: true })).toBe(0);
    expect(loadLedger(context.ctx).caps.map((c) => c.account)).toEqual(['B']);
    expect(said.at(-1)).toBe('cleared cap for "A"');
  });

  it('refuses an account it does not know, and a time it cannot read, and writes nothing', () => {
    const { home, context, said } = setup(['A']);
    expect(capCommand(context, 'Z')).toBe(1);
    expect(capCommand(context, 'A', { until: 'not a time' })).toBe(1);
    expect(said).toEqual(['account "Z" not found', 'could not parse --until "not a time"']);
    expect(existsSync(path.join(home, 'ledger.json'))).toBe(false);
  });
});
