import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addCommand } from '../../src/commands/add.js';
import { runCommand } from '../../src/commands/run.js';
import { setActive } from '../../src/state/active.js';
import { loadConfig } from '../../src/config/config.js';
import { CREDENTIALS_LOCK_DIR } from '../../src/claude/locks.js';
import type { CliContext } from '../../src/context.js';
import {
  FAKE_ENV,
  PTY_AVAILABLE,
  QUICK,
  TYPEABLE,
  dueLogin,
  fakeClaude,
  freshUsage,
  launches,
  readLog,
  renewingTokenEndpoint,
} from './typeable-claude.js';

/**
 * While another process holds a login's lock, a move after a limit waits for
 * it by looking at the lock alone. Trying the whole renewal again each time
 * reads every profile's login, through a `security` process on macOS, on the
 * thread that relays Claude's terminal.
 */
const renewalsOf = vi.hoisted(() => new Map<string, number>());
vi.mock('../../src/usage/oauth-refresh.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/usage/oauth-refresh.js')>();
  return {
    ...real,
    refreshCredentialIfExpired: (dir: string, options?: Parameters<typeof real.refreshCredentialIfExpired>[1]) => {
      renewalsOf.set(dir, (renewalsOf.get(dir) ?? 0) + 1);
      return real.refreshCredentialIfExpired(dir, options);
    },
  };
});

describe.skipIf(!PTY_AVAILABLE && !process.env.CI)('a move waiting for a login another process is renewing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const name of FAKE_ENV) delete process.env[name];
  });

  it('looks only at the lock until it is let go, then renews once', { timeout: 60_000 }, async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-busy-retry-'));
    const runsLog = path.join(home, 'runs.jsonl');
    const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
    const lock = path.join(home, 'profiles', 'B', CREDENTIALS_LOCK_DIR);
    const context: CliContext = {
      ctx,
      config: loadConfig(ctx),
      claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
      // A is out; the lock on B goes a second after that is known.
      verifyCap: () => {
        setTimeout(() => rmSync(lock, { recursive: true, force: true }), 1_000);
        return Promise.resolve('limited');
      },
      carryOn: QUICK,
      out: () => {},
      err: () => {},
      json: false,
      quiet: false,
    };
    context.config.resume.auto = false;
    for (const name of ['A', 'B']) {
      const dir = path.join(home, 'profiles', name);
      await addCommand(context, name, { dir, login: false });
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ account: name }), 'utf8');
    }
    dueLogin(path.join(home, 'profiles', 'B'), 'B');
    freshUsage(home, ['A', 'B']);
    mkdirSync(lock);
    const renewals = renewingTokenEndpoint();
    setActive('A', context.ctx);
    Object.assign(process.env, {
      ...TYPEABLE,
      FAKE_CLAUDE_RUNS_LOG: runsLog,
      FAKE_CLAUDE_IDLE_MS: '6000',
      FAKE_CLAUDE_RESUMED_IDLE_MS: '600',
      FAKE_CLAUDE_REFUSE_AFTER_MS: '1500',
    });

    expect(await runCommand(context, [])).toBe(0);
    expect(launches(readLog(runsLog))).toHaveLength(1);
    expect(renewals()).toBe(1);
    // Once to find it busy, once after the lock went: not once per look.
    expect(renewalsOf.get(path.join(home, 'profiles', 'B'))).toBe(2);
  });
});
