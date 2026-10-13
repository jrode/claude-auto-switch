import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addCommand } from '../../src/commands/add.js';
import { runCommand } from '../../src/commands/run.js';
import { setActive } from '../../src/state/active.js';
import { loadConfig } from '../../src/config/config.js';
import type { CliContext } from '../../src/context.js';
import { FAKE_ENV, PTY_AVAILABLE, QUICK, TYPEABLE, fakeClaude, launches, readLog } from './typeable-claude.js';

/**
 * Working out where a limit moves a session in place reads the ledger and
 * the account files, and any of those reads can fail. The limit was confirmed
 * all the same, so it must still be acted on: the session is relaunched, as
 * when there is nowhere to move it in place. Here the guess made when every
 * account looks out of room fails; a relaunch's own guess still works.
 */
vi.mock('../../src/session/last-resort.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/session/last-resort.js')>();
  return {
    ...real,
    lastResortStart: (input: Parameters<typeof real.lastResortStart>[0]) => {
      if (input.inPlace) throw new Error('could not read where to move');
      return real.lastResortStart(input);
    },
  };
});

describe.skipIf(!PTY_AVAILABLE && !process.env.CI)('a move in place that cannot be worked out', () => {
  afterEach(() => {
    for (const name of FAKE_ENV) delete process.env[name];
  });

  it('still acts on the confirmed limit, by a relaunch', { timeout: 60_000 }, async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-relief-fails-'));
    const runsLog = path.join(home, 'runs.jsonl');
    const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
    const context: CliContext = {
      ctx,
      config: loadConfig(ctx),
      claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
      verifyCap: () => Promise.resolve('limited'),
      carryOn: QUICK,
      out: () => {},
      err: () => {},
      json: false,
      quiet: false,
    };
    for (const name of ['A', 'B']) {
      const dir = path.join(home, 'profiles', name);
      await addCommand(context, name, { dir, login: false });
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ account: name }), 'utf8');
    }
    // B is recorded as out, so every account looks out of room.
    writeFileSync(
      path.join(home, 'ledger.json'),
      JSON.stringify({ caps: [{ account: 'B', capUntil: Date.now() + 3_600_000, reason: 'usage cap', at: Date.now() }] }),
      'utf8',
    );
    setActive('A', context.ctx);
    Object.assign(process.env, {
      ...TYPEABLE,
      FAKE_CLAUDE_RUNS_LOG: runsLog,
      FAKE_CLAUDE_IDLE_MS: '20000',
      FAKE_CLAUDE_RESUMED_IDLE_MS: '600',
      FAKE_CLAUDE_REFUSE_AFTER_MS: '1500',
    });

    expect(await runCommand(context, [])).toBe(0);
    expect(launches(readLog(runsLog))).toHaveLength(2);
    const caps = (JSON.parse(readFileSync(path.join(home, 'ledger.json'), 'utf8')) as { caps: Array<{ account: string }> })
      .caps.map((c) => c.account);
    expect(caps).toContain('A');
    expect(readFileSync(path.join(home, 'events.jsonl'), 'utf8')).toContain('could not read where to move');
  });
});
