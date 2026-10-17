import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { autoRotateHeadless } from '../../src/launcher/rotating-run.js';
import { applyLedgerChange, loadLedger, markCapped, updateLedger } from '../../src/ledger/ledger.js';
import type { RunOptions } from '../../src/util/exec.js';

/**
 * The changes a headless run makes to the ledger, each applied to the file as
 * it stands when the run makes it, the way `ccx run -p` applies them.
 */

const HOUR = 3_600_000;

function acct(name: string, priority: number) {
  return { name, priority, enabled: true, dir: `/dir/${name}` };
}

const base = {
  claude: { bin: 'node' },
  accounts: [acct('A', 0), acct('B', 1)],
  loggedIn: new Set(['A', 'B']),
  defaultBackoffMinutes: 300,
  out: () => {},
  confirmCap: () => Promise.resolve({ limited: true }),
};

describe('the changes a headless run makes to the ledger', () => {
  it('keeps a limit another session records on the account while the run on it is going, though the run ends fine', async () => {
    // The run ran fine, which shows the limits recorded before it started are
    // over. One recorded while it ran is another session seeing the account
    // refuse, which a run that started earlier cannot overrule.
    const home = mkdtempSync(path.join(tmpdir(), 'cas-rotate-changes-'));
    const c = { env: { CLAUDE_AUTO_SWITCH_HOME: home } };
    let clock = 1_000;
    const run = async (_bin: string, _args: string[], opts?: RunOptions) => {
      clock += 10;
      if (opts?.env?.CLAUDE_CONFIG_DIR === '/dir/A') return { stdout: '', stderr: 'Usage limit reached.', exitCode: 1 };
      updateLedger(c, (ledger) =>
        markCapped(ledger, { account: 'B', now: clock, resetAt: clock + HOUR, reason: 'another session' }),
      );
      return { stdout: 'done', stderr: '', exitCode: 0 };
    };

    const result = await autoRotateHeadless(['-p', 'hi'], {
      ...base,
      now: () => clock,
      ledger: loadLedger(c),
      run,
      recordChange: (change) => updateLedger(c, (ledger) => applyLedgerChange(ledger, change)),
    });

    expect(result.account).toBe('B');
    // B's attempt started at 1010, and the other session recorded B at 1020.
    expect(result.changes).toEqual([
      { kind: 'capped', cap: expect.objectContaining({ account: 'A', now: 1_010 }) },
      { kind: 'ran', account: 'B', model: null, startedAt: 1_010 },
    ]);
    const caps = loadLedger(c).caps;
    expect(caps.map((cap) => cap.account).sort()).toEqual(['A', 'B']);
    expect(caps.find((cap) => cap.account === 'B')?.reason).toBe('another session');
  });

  it('carries the request on to the next account when the ledger cannot be written', async () => {
    // A lost record of a limit costs one wasted attempt later; a lost request
    // is the work itself.
    const said: string[] = [];
    let calls = 0;
    const run = async (_bin: string, _args: string[], opts?: RunOptions) =>
      opts?.env?.CLAUDE_CONFIG_DIR === '/dir/A'
        ? { stdout: '', stderr: 'Usage limit reached.', exitCode: 1 }
        : { stdout: 'done', stderr: '', exitCode: 0 };

    const result = await autoRotateHeadless(['-p', 'hi'], {
      ...base,
      now: () => 1_000,
      ledger: { caps: [] },
      run,
      out: (m) => said.push(m),
      recordChange: () => {
        calls += 1;
        if (calls === 1) throw new Error('disk full');
      },
    });

    expect(result).toMatchObject({ exitCode: 0, account: 'B' });
    expect(calls).toBe(2);
    expect(said).toContain('could not record that A is out on the ledger (disk full); carrying on');
  });
});
