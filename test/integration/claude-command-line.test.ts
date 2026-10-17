import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addCommand } from '../../src/commands/add.js';
import { runCommand } from '../../src/commands/run.js';
import { workerCommand, WORKER_CARRY_ON } from '../../src/commands/worker.js';
import { autoRotateHeadless } from '../../src/launcher/rotating-run.js';
import { setActive } from '../../src/state/active.js';
import { writeSwitchRequest } from '../../src/state/switch-request.js';
import { loadConfig } from '../../src/config/config.js';
import { DEFAULT_RESUME_PROMPT } from '../../src/config/config.schema.js';
import { processIsAlive } from '../../src/session/lease.js';
import type { CapDecision } from '../../src/usage/confirm-cap.js';
import type { CliContext } from '../../src/context.js';
import { PTY_AVAILABLE, fakeClaude, waitFor } from './typeable-claude.js';

/**
 * Every place ccx adds to Claude's command line, against the fake claude,
 * which reads its arguments the way the real CLI's parser does and logs what
 * it applied. Claude reads everything after `--` as the prompt, so a flag
 * added there is never applied. Each case runs once with a `--` and once
 * without, where the command line must be exactly what it always was.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A prompt that starts with a dash, which is what `--` is for. */
const PROMPT = '-x marks the spot';
const CONVERSATION = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';

interface Applied {
  print: boolean;
  continue: boolean;
  resume: string | true | null;
  sessionId: string | null;
  fork: boolean;
  model: string | null;
  prompt: string | null;
}
interface Launch {
  type: 'launch';
  args: string[];
  marker: string | null;
  applied: Applied;
  tty: boolean;
}

function launchesIn(runsLog: string): Launch[] {
  if (!existsSync(runsLog)) return [];
  return readFileSync(runsLog, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Launch)
    .filter((l) => l.type === 'launch');
}

const ids = (...values: string[]): (() => string) => {
  let i = 0;
  return () => values[i++] ?? 'exhausted';
};

/** Every variable a test here sets, put back as it was afterwards. */
const TOUCHED = [
  'FAKE_CLAUDE_RUNS_LOG',
  'FAKE_CLAUDE_IDLE_MS',
  'FAKE_CLAUDE_IDLE_STATUS',
  'FAKE_CLAUDE_SESSION_RECORD',
  'FAKE_CLAUDE_TRANSCRIPT',
  'FAKE_CLAUDE_REFUSE_AFTER_MS',
  'FAKE_CLAUDE_NOTHING_TO_RESUME',
  'FAKE_CLAUDE_SAY',
  'FAKE_CLAUDE_EXIT_CODE',
];
const original = Object.fromEntries(TOUCHED.map((name) => [name, process.env[name]]));
afterEach(() => {
  for (const name of TOUCHED) {
    if (original[name] === undefined) delete process.env[name];
    else process.env[name] = original[name];
  }
});

function makeContext(home: string, extra: Partial<CliContext> = {}): CliContext {
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
  return {
    ctx,
    config: loadConfig(ctx),
    claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
    verifyCap: () => Promise.resolve('allowed'),
    out: () => {},
    err: () => {},
    json: false,
    quiet: false,
    ...extra,
  };
}

/** Signed in for a session (a login in the folder) and for a print run's health check. */
async function loginAccount(context: CliContext, home: string, name: string): Promise<void> {
  const dir = path.join(home, 'profiles', name);
  await addCommand(context, name, { dir, login: false });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ account: name }), 'utf8');
  writeFileSync(
    path.join(dir, 'fake-scenario.json'),
    JSON.stringify({ authStatus: { loggedIn: true, authMethod: 'claude.ai', email: `${name}@example.com` } }),
    'utf8',
  );
}

async function twoAccounts(
  prefix: string,
  extra: Partial<CliContext> = {},
): Promise<{ home: string; context: CliContext; runsLog: string }> {
  const home = mkdtempSync(path.join(tmpdir(), prefix));
  const context = makeContext(home, extra);
  await loginAccount(context, home, 'A');
  await loginAccount(context, home, 'B');
  setActive('A', context.ctx);
  const runsLog = path.join(home, 'runs.jsonl');
  process.env.FAKE_CLAUDE_RUNS_LOG = runsLog;
  return { home, context, runsLog };
}

describe('a print run rotating to another model (against fake-claude)', () => {
  const FIRST = '11111111-2222-4333-8444-555555555555';
  const SECOND = '22222222-3333-4444-8555-666666666666';

  /** Out of Fable on its one account, so the second launch is on Opus. */
  async function fallingBack(typed: string[]): Promise<Launch[]> {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-args-model-'));
    const dir = path.join(home, 'A');
    mkdirSync(dir, { recursive: true });
    const runsLog = path.join(home, 'runs.jsonl');
    Object.assign(process.env, {
      FAKE_CLAUDE_RUNS_LOG: runsLog,
      FAKE_CLAUDE_SAY: 'Usage limit reached. Try again later.',
      FAKE_CLAUDE_EXIT_CODE: '1',
    });
    // Fable is out on the first launch; the second only says the same words.
    const verdicts: CapDecision[] = [{ limited: true, model: 'fable' }, { limited: false }];
    await autoRotateHeadless(typed, {
      claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
      accounts: [{ name: 'A', priority: 0, enabled: true, dir }],
      loggedIn: new Set(['A']),
      now: () => Date.now(),
      defaultBackoffMinutes: 300,
      ledger: { caps: [] },
      recordChange: () => {},
      out: () => {},
      modelPreference: ['fable', 'opus'],
      modelStrategy: 'account-first',
      newId: ids(FIRST, SECOND),
      confirmCap: () => Promise.resolve(verdicts.shift() ?? { limited: false }),
    });
    return launchesIn(runsLog);
  }

  it(
    'puts the model and the conversation before a `--`, and at the end as before when there is none',
    { timeout: 60_000 },
    async () => {
      const [onFable, onOpus, ...more] = await fallingBack(['-p', '--model', 'fable', '--', PROMPT]);
      expect(more).toEqual([]);
      expect(onFable?.args).toEqual(['-p', '--model', 'fable', '--session-id', FIRST, '--', PROMPT]);
      expect(onOpus?.args).toEqual(['-p', '--model', 'opus', '--session-id', SECOND, '--', PROMPT]);
      expect(onOpus?.applied).toMatchObject({ print: true, model: 'opus', sessionId: SECOND, prompt: PROMPT });

      const plain = await fallingBack(['-p', '--model', 'fable', 'hi']);
      expect(plain.map((l) => l.args)).toEqual([
        ['-p', '--model', 'fable', 'hi', '--session-id', FIRST],
        ['-p', 'hi', '--model', 'opus', '--session-id', SECOND],
      ]);
      expect(plain[1]?.applied).toMatchObject({ model: 'opus', sessionId: SECOND, prompt: 'hi' });
    },
  );
});

describe.skipIf(!PTY_AVAILABLE && !process.env.CI)('sessions and workers (against fake-claude)', () => {
  it(
    'takes the print path for -p in a cluster, as Claude reads it, and not for -dp or --print=x',
    { timeout: 60_000 },
    async () => {
      process.env.FAKE_CLAUDE_IDLE_MS = '300';
      for (const typed of [['-pc', 'hi'], ['-cp', 'hi'], ['--print', '-c', 'hi']]) {
        const { context, runsLog } = await twoAccounts('cas-args-print-');
        expect(await runCommand(context, typed)).toBe(0);
        // Through pipes, as ccx runs print mode, and exactly as typed: it
        // continues a conversation, so ccx names none of its own, which Claude
        // would refuse beside the -c.
        const launches = launchesIn(runsLog);
        expect(launches).toHaveLength(1);
        expect(launches[0]).toMatchObject({ args: typed, tty: false });
        expect(launches[0]?.applied).toMatchObject({ print: true, continue: true, sessionId: null });
      }

      // `-dp` is --debug with the filter "p", and `--print` takes no value, so
      // `--print=x` is no print mode either: a session in a terminal, which ccx
      // names, as it always has.
      for (const typed of [['-dp', 'hi'], ['--print=x', 'hi']]) {
        const { context, runsLog } = await twoAccounts('cas-args-session-not-print-');
        expect(await runCommand(context, typed)).toBe(0);
        const [session, ...more] = launchesIn(runsLog);
        expect(more).toEqual([]);
        const id = session?.applied.sessionId;
        expect(id).toEqual(expect.stringMatching(UUID));
        expect(session).toMatchObject({ args: [...typed, '--session-id', id], tty: true });
        expect(session?.applied.print).toBe(false);
      }
    },
  );

  /**
   * A session on A, moved to B before its first message, so the resume finds
   * nothing and a new conversation is started: every launch that adds a
   * conversation flag.
   */
  async function movedBeforeItsFirstMessage(typed: string[]): Promise<Launch[]> {
    const { context, runsLog } = await twoAccounts('cas-args-session-');
    Object.assign(process.env, {
      FAKE_CLAUDE_IDLE_MS: '3000',
      FAKE_CLAUDE_SESSION_RECORD: '1',
      FAKE_CLAUDE_NOTHING_TO_RESUME: '1',
    });
    const run = runCommand(context, typed);
    await waitFor(
      'the first launch',
      () => launchesIn(runsLog),
      (l) => l.length > 0,
    );
    writeSwitchRequest('B', Date.now(), 'restart', context.ctx);
    expect(await run).toBe(0);
    return launchesIn(runsLog);
  }

  it(
    'names, resumes and starts a session again with each flag before a `--`, and at the end as before when there is none',
    { timeout: 60_000 },
    async () => {
      const [first, resumed, fresh, ...more] = await movedBeforeItsFirstMessage(['--effort', 'max', '--', PROMPT]);
      expect(more).toEqual([]);
      const started = first?.applied.sessionId;
      const restarted = fresh?.applied.sessionId;
      expect(started).toEqual(expect.stringMatching(UUID));
      expect(restarted).toEqual(expect.stringMatching(UUID));
      expect(restarted).not.toBe(started);
      expect(first?.args).toEqual(['--effort', 'max', '--session-id', started, '--', PROMPT]);
      // It has a prompt of its own, so the resume prompt stands aside.
      expect(resumed?.args).toEqual(['--effort', 'max', '--resume', started, '--', PROMPT]);
      expect(resumed?.applied.resume).toBe(started);
      expect(fresh?.args).toEqual(['--effort', 'max', '--session-id', restarted, '--', PROMPT]);
      for (const launch of [first, resumed, fresh]) expect(launch?.applied.prompt).toBe(PROMPT);

      const plain = await movedBeforeItsFirstMessage(['--effort', 'max']);
      expect(plain).toHaveLength(3);
      const [was, now] = [plain[0]?.applied.sessionId, plain[2]?.applied.sessionId];
      expect(plain.map((l) => l.args)).toEqual([
        ['--effort', 'max', '--session-id', was],
        ['--effort', 'max', '--resume', was, DEFAULT_RESUME_PROMPT],
        ['--effort', 'max', '--session-id', now],
      ]);
      expect(plain[1]?.applied.resume).toBe(was);
    },
  );

  /** One account, out of Fable, so the session starts on the fallback model. */
  async function startedOnTheFallback(typed: string[]): Promise<Launch[]> {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-args-model-session-'));
    const runsLog = path.join(home, 'runs.jsonl');
    Object.assign(process.env, { FAKE_CLAUDE_RUNS_LOG: runsLog, FAKE_CLAUDE_IDLE_MS: '600' });
    const context = makeContext(home);
    await loginAccount(context, home, 'only');
    setActive('only', context.ctx);
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({ model: 'claude-fable-5[1m]' }),
      'utf8',
    );
    writeFileSync(
      path.join(home, 'usage-snapshot.json'),
      JSON.stringify({
        accounts: {
          only: {
            fiveHour: 0.1,
            sevenDay: 0.2,
            fiveHourReset: null,
            sevenDayReset: null,
            models: [{ name: 'Fable', utilization: 1, resetsAt: null }],
            at: Date.now(),
          },
        },
      }),
      'utf8',
    );
    expect(await runCommand(context, typed)).toBe(0);
    return launchesIn(runsLog);
  }

  it(
    'starts a session on the fallback model with --model before a `--`, and at the end as before when there is none',
    { timeout: 60_000 },
    async () => {
      const [launch, ...more] = await startedOnTheFallback(['--', PROMPT]);
      expect(more).toEqual([]);
      const id = launch?.applied.sessionId;
      expect(id).toEqual(expect.stringMatching(UUID));
      expect(launch?.args).toEqual(['--session-id', id, '--model', 'opus', '--', PROMPT]);
      expect(launch?.applied).toMatchObject({ model: 'opus', prompt: PROMPT });

      const [plain] = await startedOnTheFallback([]);
      expect(plain?.args).toEqual(['--session-id', plain?.applied.sessionId, '--model', 'opus']);
      expect(plain?.applied.model).toBe('opus');
    },
  );

  /** A worker on A, out on the first check, so it moves to B and resumes there. */
  async function workerMoved(passthrough: string[]): Promise<{ launches: Launch[]; sessionId: unknown }> {
    let probes = 0;
    const { context, runsLog } = await twoAccounts('cas-args-worker-', {
      verifyCap: () => Promise.resolve<'limited' | 'allowed'>(++probes === 1 ? 'limited' : 'allowed'),
      // The fake claude runs as `node`: counted as a Claude, as in the worker tests.
      isClaudeProcess: processIsAlive,
    });
    Object.assign(process.env, {
      FAKE_CLAUDE_IDLE_MS: '4000',
      FAKE_CLAUDE_SESSION_RECORD: '1',
      FAKE_CLAUDE_TRANSCRIPT: '1',
      FAKE_CLAUDE_REFUSE_AFTER_MS: '1200',
    });
    let out = '';
    const io = {
      signals: new EventEmitter(),
      stdout: (text: string) => {
        out += text;
      },
      stderr: () => {},
    };
    expect(await workerCommand(context, ['refactor', 'billing'], {}, passthrough, io)).toBe(0);
    const answer = JSON.parse(out) as { ccx: { sessionId: unknown } };
    return { launches: launchesIn(runsLog), sessionId: answer.ccx.sessionId };
  }

  it(
    "names and resumes a worker's conversation before a `--` among Claude's flags, and at the end as before when there is none",
    { timeout: 60_000 },
    async () => {
      const head = ['-p', '--output-format', 'json', '--max-turns', '5'];
      const withDash = await workerMoved(['--max-turns', '5', '--', PROMPT]);
      const [first, moved, ...more] = withDash.launches;
      expect(more).toEqual([]);
      expect([first?.marker, moved?.marker]).toEqual(['A', 'B']);
      const id = first?.applied.sessionId;
      expect(id).toEqual(expect.stringMatching(UUID));
      expect(withDash.sessionId).toBe(id);
      // The brief goes by standard input, since the words after `--` are the prompt.
      expect(first?.args).toEqual([...head, '--session-id', id, '--', PROMPT]);
      expect(moved?.args).toEqual([...head, '--resume', id, '--', PROMPT]);
      expect(moved?.applied.resume).toBe(id);

      const plain = await workerMoved(['--max-turns', '5']);
      expect(plain.launches).toHaveLength(2);
      const was = plain.launches[0]?.applied.sessionId;
      expect(plain.sessionId).toBe(was);
      expect(plain.launches.map((l) => l.args)).toEqual([
        [...head, '--session-id', was, 'refactor billing'],
        [...head, '--resume', was, WORKER_CARRY_ON],
      ]);
    },
  );

  /**
   * A newer ccx that records how it was started, then starts the fake claude
   * with what follows its own `--`, as `ccx run -- <claude args>` does.
   */
  function newerCcx(): { cli: string; started: () => string[] | null } {
    const dir = mkdtempSync(path.join(tmpdir(), 'cas-args-newer-'));
    const record = path.join(dir, 'started.json');
    const cli = path.join(dir, 'cli.js');
    writeFileSync(
      cli,
      [
        `const argv = process.argv.slice(2);`,
        `require('fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify(argv));`,
        `const env = { ...process.env, CLAUDE_CONFIG_DIR: ${JSON.stringify(dir)}, FAKE_CLAUDE_IDLE_MS: '0' };`,
        `delete env.FAKE_CLAUDE_SESSION_RECORD;`,
        `delete env.FAKE_CLAUDE_IDLE_STATUS;`,
        `require('child_process').spawnSync(process.execPath, [${JSON.stringify(fakeClaude)}, ...argv.slice(argv.indexOf('--') + 1)], { env, stdio: 'ignore' });`,
      ].join('\n'),
    );
    return {
      cli,
      started: () => (existsSync(record) ? (JSON.parse(readFileSync(record, 'utf8')) as string[]) : null),
    };
  }

  /** A session left idle, so it moves itself to a newer ccx: the arguments it hands over, and what Claude made of them. */
  async function handedOver(typed: string[]): Promise<{ started: string[] | null; launches: Launch[] }> {
    const newer = newerCcx();
    const { context, runsLog } = await twoAccounts('cas-args-handover-', {
      newerInstall: () => ({ version: '9.9.9', cli: newer.cli }),
      // Left alone for 0.3 s counts, rather than the 20 s ccx waits.
      idleBeforeRestartMs: 300,
    });
    Object.assign(process.env, {
      FAKE_CLAUDE_IDLE_MS: '15000',
      FAKE_CLAUDE_SESSION_RECORD: '1',
      FAKE_CLAUDE_IDLE_STATUS: '1',
    });
    expect(await runCommand(context, typed)).toBe(0);
    return { started: newer.started(), launches: launchesIn(runsLog) };
  }

  it(
    'hands a newer ccx the conversation flag before a `--`, and at the end as before when there is none',
    { timeout: 60_000 },
    async () => {
      const withDash = await handedOver(['--effort', 'max', '--resume', CONVERSATION, '--', PROMPT]);
      const handed = ['--effort', 'max', '--resume', CONVERSATION, '--', PROMPT];
      expect(withDash.started).toEqual(['run', '--account', 'A', '--', ...handed]);
      // Ours, then the one the newer ccx started.
      expect(withDash.launches.map((l) => l.args)).toEqual([handed, handed]);
      expect(withDash.launches[1]?.applied).toMatchObject({ resume: CONVERSATION, prompt: PROMPT });

      const plain = await handedOver(['--resume', CONVERSATION, '--effort', 'max']);
      expect(plain.started).toEqual(['run', '--account', 'A', '--', '--effort', 'max', '--resume', CONVERSATION]);
    },
  );
});
