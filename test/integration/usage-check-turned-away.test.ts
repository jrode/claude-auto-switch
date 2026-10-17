import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addCommand } from '../../src/commands/add.js';
import { runCommand } from '../../src/commands/run.js';
import { setActive } from '../../src/state/active.js';
import { loadConfig } from '../../src/config/config.js';
import type { CliContext } from '../../src/context.js';
import type { LimitProbeResult } from '../../src/usage/limit-probe.js';
import {
  FAKE_ENV,
  PTY_AVAILABLE,
  QUICK,
  TYPEABLE,
  fakeClaude,
  launches,
  prompts,
  readLog,
  waitFor,
} from './typeable-claude.js';

/**
 * A session that meets a usage limit while ccx's own usage check is turned
 * away (a 429: every session on the machine shares that endpoint's budget).
 * Claude's own record of the refused turn then decides, and words on the
 * screen never do. Real sessions in a pseudo-terminal against the fake claude,
 * with the usage endpoint answering by the account whose login it is asked
 * with.
 */

const TURNED_AWAY: LimitProbeResult = { verdict: 'unknown', detail: 'status 429' };
const ROOM: LimitProbeResult = { verdict: 'allowed', fiveHour: 0.1, sevenDay: 0.1 };

/** Set here and not in FAKE_ENV, so put back here too. */
const ALSO_SET = [
  'FAKE_CLAUDE_CAP_AFTER_MS',
  'FAKE_CLAUDE_CAP_EVERY_MS',
  'FAKE_CLAUDE_REFUSAL_AGE_MS',
  'FAKE_CLAUDE_REFUSE_AGAIN_AFTER_MS',
  'FAKE_CLAUDE_PROMPT_AFTER_MS',
  'FAKE_CLAUDE_REFUSAL_ENDS_RUN',
  'FAKE_CLAUDE_RESETS_AT',
  'FAKE_CLAUDE_LIMIT_TYPE',
  'FAKE_CLAUDE_DRAW_BY_CELLS',
];
/** The usage check answering, with a window this one measured. */
const OUT = (resetAt: number): LimitProbeResult => ({
  verdict: 'limited',
  fiveHour: 1,
  sevenDay: 0.4,
  fiveHourReset: resetAt,
});
const capVerdicts = (home: string): string[] =>
  eventsIn(home)
    .filter((e) => e.kind === 'cap-verify')
    .map((e) => e.msg);

interface LoggedEvent {
  msg: string;
  kind?: string;
  data?: Record<string, unknown>;
}
interface Cap {
  account: string;
  capUntil: number | null;
  model?: string;
}

const eventsIn = (home: string): LoggedEvent[] =>
  readFileSync(path.join(home, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as LoggedEvent);
const capsIn = (home: string): Cap[] => {
  const file = path.join(home, 'ledger.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { caps: Cap[] }).caps : [];
};

/**
 * The usage endpoint: each account's answers in turn, the last one standing
 * once they run out, and who it was asked about, in order.
 */
function usageEndpoint(answers: Record<string, LimitProbeResult[]>): {
  probe: NonNullable<CliContext['capProbe']>;
  asked: string[];
} {
  const asked: string[] = [];
  const left = Object.fromEntries(Object.entries(answers).map(([name, list]) => [name, [...list]]));
  return {
    asked,
    probe: (credentialsFile) => {
      const account =
        (JSON.parse(readFileSync(credentialsFile, 'utf8')) as { account?: string }).account ?? '?';
      asked.push(account);
      const queue = left[account] ?? [ROOM];
      const answer = (queue.length > 1 ? queue.shift() : queue[0]) ?? ROOM;
      return Promise.resolve(answer);
    },
  };
}

async function loginAccount(context: CliContext, home: string, name: string): Promise<void> {
  const dir = path.join(home, 'profiles', name);
  await addCommand(context, name, { dir, login: false });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ account: name }), 'utf8');
}

/** Accounts A and B, the session starting on A, and the usage endpoint answering as given. */
async function twoAccounts(
  prefix: string,
  answers: Record<string, LimitProbeResult[]>,
): Promise<{ home: string; runsLog: string; context: CliContext; asked: string[] }> {
  const home = mkdtempSync(path.join(tmpdir(), prefix));
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
  const usage = usageEndpoint(answers);
  const context: CliContext = {
    ctx,
    config: loadConfig(ctx),
    claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
    capProbe: usage.probe,
    carryOn: QUICK,
    out: () => {},
    err: () => {},
    json: false,
    quiet: false,
  };
  await loginAccount(context, home, 'A');
  await loginAccount(context, home, 'B');
  setActive('A', context.ctx);
  return { home, runsLog: path.join(home, 'runs.jsonl'), context, asked: usage.asked };
}

/** A Claude that can be typed into, refused on A after `refuseAfterMs`, done once it has carried on. */
const refusedOnA = (runsLog: string, refuseAfterMs = 1500): Record<string, string> => ({
  ...TYPEABLE,
  FAKE_CLAUDE_RUNS_LOG: runsLog,
  FAKE_CLAUDE_IDLE_MS: '15000',
  FAKE_CLAUDE_REFUSE_AFTER_MS: String(refuseAfterMs),
  FAKE_CLAUDE_EXIT_AFTER_PROMPTS: '1',
});

describe.skipIf(!PTY_AVAILABLE && !process.env.CI)(
  'a limit met while the usage check is turned away (against fake-claude)',
  () => {
    afterEach(() => {
      for (const name of [...FAKE_ENV, ...ALSO_SET]) delete process.env[name];
    });

    it(
      'moves in place when Claude recorded the turn as refused',
      { timeout: 60_000 },
      async () => {
        const { home, runsLog, context, asked } = await twoAccounts('cas-429-refused-', {
          A: [TURNED_AWAY],
        });
        const resetsAt = Math.floor(Date.now() / 1000) + 2 * 60 * 60;
        Object.assign(process.env, refusedOnA(runsLog), { FAKE_CLAUDE_RESETS_AT: String(resetsAt) });

        expect(await runCommand(context, [])).toBe(0);
        const log = readLog(runsLog);
        // One Claude from start to finish, told to carry on on B.
        expect(launches(log).map((l) => l.marker)).toEqual(['A']);
        expect(prompts(log)).toEqual([expect.objectContaining({ marker: 'B', refused: false })]);
        expect(asked).toContain('A');
        // The whole account, until the reset the refusal names.
        expect(capsIn(home)).toEqual([expect.objectContaining({ account: 'A', capUntil: resetsAt * 1000 })]);
        expect(capsIn(home)[0]?.model).toBeUndefined();
        const events = eventsIn(home);
        expect(events.filter((e) => e.kind === 'cap-relief')).toHaveLength(1);
        const verdicts = events.filter((e) => e.kind === 'cap-verify').map((e) => e.msg);
        expect(verdicts).toEqual([
          expect.stringMatching(
            /^the usage check could not answer \(status 429\), but Claude recorded the turn as refused \(usage_limit_reached, five_hour\)/,
          ),
        ]);
      },
    );

    it(
      'never moves on limit words on the screen alone',
      { timeout: 60_000 },
      async () => {
        const { home, runsLog, context, asked } = await twoAccounts('cas-429-words-', {
          A: [TURNED_AWAY],
        });
        Object.assign(process.env, {
          FAKE_CLAUDE_RUNS_LOG: runsLog,
          FAKE_CLAUDE_IDLE_MS: '6000',
          // Claude says what it is doing, but keeps no record of the
          // conversation to read, so the screen stands in for it.
          FAKE_CLAUDE_SESSION_RECORD: '1',
          FAKE_CLAUDE_CAP_AFTER_MS: '1500',
          FAKE_CLAUDE_CAP_EVERY_MS: '1000',
        });

        expect(await runCommand(context, [])).toBe(0);
        // Asked, turned away, and not moved.
        expect(asked).toContain('A');
        expect(launches(readLog(runsLog)).map((l) => l.marker)).toEqual(['A']);
        expect(capsIn(home)).toEqual([]);
        const events = eventsIn(home);
        expect(events.filter((e) => e.kind === 'cap-relief')).toEqual([]);
        expect(events.filter((e) => e.kind === 'cap-verify').map((e) => e.msg)).toContain(
          'limit text on screen, but not switching yet: the usage check could not answer ' +
            '(status 429), and Claude has not recorded the turn as refused',
        );
      },
    );

    it(
      'never moves on a refusal recorded before this Claude started',
      { timeout: 60_000 },
      async () => {
        // An entry copied into a new record from an older one keeps its own
        // time, and reads as news to a follower that reads the record whole.
        const { home, runsLog, context, asked } = await twoAccounts('cas-429-old-', {
          A: [TURNED_AWAY],
        });
        Object.assign(process.env, {
          FAKE_CLAUDE_RUNS_LOG: runsLog,
          FAKE_CLAUDE_IDLE_MS: '6000',
          FAKE_CLAUDE_SESSION_RECORD: '1',
          FAKE_CLAUDE_TRANSCRIPT: '1',
          FAKE_CLAUDE_REFUSE_AFTER_MS: '1500',
          FAKE_CLAUDE_REFUSAL_AGE_MS: String(60 * 60_000),
        });

        expect(await runCommand(context, [])).toBe(0);
        expect(asked).toContain('A');
        expect(launches(readLog(runsLog)).map((l) => l.marker)).toEqual(['A']);
        expect(capsIn(home)).toEqual([]);
        const events = eventsIn(home);
        expect(events.filter((e) => e.kind === 'cap-relief')).toEqual([]);
        expect(events.filter((e) => e.kind === 'cap-verify').map((e) => e.msg)).toContain(
          'Claude recorded a refused turn, but not switching yet: the usage check could not answer ' +
            '(status 429), and the refusal was recorded before this Claude started',
        );
      },
    );

    it(
      'asks again after the back-off the usage check asked for, and takes its answer',
      { timeout: 60_000 },
      async () => {
        const resetAt = Date.now() + 90 * 60_000;
        const { home, runsLog, context, asked } = await twoAccounts('cas-429-retry-', {
          A: [
            { ...TURNED_AWAY, retryAfterMs: 300 },
            { verdict: 'limited', fiveHour: 1, sevenDay: 0.4, fiveHourReset: resetAt },
          ],
        });
        Object.assign(process.env, refusedOnA(runsLog));

        expect(await runCommand(context, [])).toBe(0);
        const log = readLog(runsLog);
        expect(launches(log).map((l) => l.marker)).toEqual(['A']);
        expect(prompts(log)).toEqual([expect.objectContaining({ marker: 'B', refused: false })]);
        // Asked twice about A: turned away, then answered.
        expect(asked.filter((name) => name === 'A')).toEqual(['A', 'A']);
        // Until the window the answer named, not a guess: the usage check
        // confirmed this one, not the refusal.
        expect(capsIn(home)).toEqual([expect.objectContaining({ account: 'A', capUntil: resetAt })]);
        expect(eventsIn(home).filter((e) => e.kind === 'cap-verify')).toEqual([]);
      },
    );

    it(
      "ends the limit at the reset the refusal names, over another session's record",
      { timeout: 60_000 },
      async () => {
        // On 10-16 another session's check confirmed A out until next week
        // moments before, then the endpoint turned this session's check away.
        // The refusal's own reset is this turn's, and wins.
        const { home, runsLog, context } = await twoAccounts('cas-429-reset-', { A: [TURNED_AWAY] });
        const resetsAt = Math.floor(Date.now() / 1000) + 2 * 60 * 60;
        Object.assign(process.env, refusedOnA(runsLog, 2500), { FAKE_CLAUDE_RESETS_AT: String(resetsAt) });
        const known = { account: 'A', capUntil: Date.now() + 7 * 24 * 60 * 60_000, reason: 'usage_limit_reached', at: Date.now() };

        const running = runCommand(context, []);
        await waitFor(
          'the launch on A',
          () => launches(readLog(runsLog)),
          (l) => l.length === 1,
        );
        writeFileSync(path.join(home, 'ledger.json'), JSON.stringify({ caps: [known] }), 'utf8');
        expect(await running).toBe(0);

        expect(prompts(readLog(runsLog))).toEqual([
          expect.objectContaining({ marker: 'B', refused: false }),
        ]);
        expect(capsIn(home)).toEqual([expect.objectContaining({ account: 'A', capUntil: resetsAt * 1000 })]);
      },
    );

    it(
      "keeps the end another session's check recorded when the refusal names no reset",
      { timeout: 60_000 },
      async () => {
        const { home, runsLog, context } = await twoAccounts('cas-429-known-', { A: [TURNED_AWAY] });
        Object.assign(process.env, refusedOnA(runsLog, 2500), { FAKE_CLAUDE_RESETS_AT: 'none' });
        const knownUntil = Date.now() + 7 * 24 * 60 * 60_000;
        const known = { account: 'A', capUntil: knownUntil, reason: 'usage_limit_reached', at: Date.now() };

        const running = runCommand(context, []);
        await waitFor(
          'the launch on A',
          () => launches(readLog(runsLog)),
          (l) => l.length === 1,
        );
        writeFileSync(path.join(home, 'ledger.json'), JSON.stringify({ caps: [known] }), 'utf8');
        expect(await running).toBe(0);

        expect(prompts(readLog(runsLog))).toEqual([
          expect.objectContaining({ marker: 'B', refused: false }),
        ]);
        expect(capsIn(home)).toEqual([expect.objectContaining({ account: 'A', capUntil: knownUntil })]);
      },
    );

    it(
      'never moves while another live ccx session is on the same conversation',
      { timeout: 60_000 },
      async () => {
        // Two Claudes on one conversation write one record, so a refusal in
        // it may be the other one's. Here that other one is a ccx session,
        // announced as ccx announces each, in a folder that says which
        // conversation it is in.
        const { home, runsLog, context, asked } = await twoAccounts('cas-429-other-', {
          A: [TURNED_AWAY],
        });
        Object.assign(process.env, refusedOnA(runsLog, 2500));

        const running = runCommand(context, []);
        const [launch] = await waitFor(
          'the launch on A',
          () => launches(readLog(runsLog)),
          (l) => l.length === 1,
        );
        const args = launch?.args ?? [];
        const conversation = args[args.indexOf('--session-id') + 1] ?? '';
        const theirs = mkdtempSync(path.join(tmpdir(), 'cas-429-theirs-'));
        writeFileSync(path.join(theirs, 'claude-report.json'), JSON.stringify({ id: conversation }), 'utf8');
        // A process that is alive for the whole test, as a running session's is.
        const pid = process.ppid;
        mkdirSync(path.join(home, 'sessions-live'), { recursive: true });
        writeFileSync(
          path.join(home, 'sessions-live', `A__${pid}.json`),
          JSON.stringify({ account: 'A', pid, configDir: theirs, at: Date.now() }),
          'utf8',
        );
        expect(await running).toBe(0);

        expect(asked).toContain('A');
        expect(launches(readLog(runsLog)).map((l) => l.marker)).toEqual(['A']);
        expect(prompts(readLog(runsLog))).toEqual([]);
        expect(capsIn(home)).toEqual([]);
        expect(capVerdicts(home)).toContain(
          'Claude recorded a refused turn, but not switching yet: the usage check could not answer ' +
            `(status 429), and another ccx session (pid ${pid}) is on this conversation too, so the refusal may be its`,
        );
      },
    );

    it(
      'moves however Claude drew the refusal on its screen',
      { timeout: 60_000 },
      async () => {
        // Claude 2.1.302 draws only the cells that changed, so the text of a
        // refusal need not reach the screen in order, or at all.
        const { home, runsLog, context } = await twoAccounts('cas-429-cells-', { A: [TURNED_AWAY] });
        Object.assign(process.env, refusedOnA(runsLog), { FAKE_CLAUDE_DRAW_BY_CELLS: '1' });

        expect(await runCommand(context, [])).toBe(0);
        expect(prompts(readLog(runsLog))).toEqual([
          expect.objectContaining({ marker: 'B', refused: false }),
        ]);
        expect(capsIn(home).map((c) => c.account)).toEqual(['A']);
      },
    );

    it(
      "takes a limit on one model as that model's, so the account goes on with the others",
      { timeout: 60_000 },
      async () => {
        const { home, runsLog, context } = await twoAccounts('cas-429-opus-', { A: [TURNED_AWAY] });
        const resetsAt = Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60;
        Object.assign(process.env, refusedOnA(runsLog), {
          FAKE_CLAUDE_LIMIT_TYPE: 'seven_day_opus',
          FAKE_CLAUDE_RESETS_AT: String(resetsAt),
          FAKE_CLAUDE_RESUMED_IDLE_MS: '600',
        });

        expect(await runCommand(context, [])).toBe(0);
        // Recorded against Opus alone, until its own reset; nothing account-wide.
        expect(capsIn(home)).toEqual([
          expect.objectContaining({ account: 'A', model: 'Opus', capUntil: resetsAt * 1000 }),
        ]);
      },
    );

    it(
      'never moves on a refusal that can be the old login, just after a move',
      { timeout: 60_000 },
      async () => {
        // A is out and confirmed, and the session moves to B in place. The
        // carry-on prompt still goes out on A, which Claude keeps for a while,
        // and is refused; B's check is turned away. That refusal says nothing
        // about B.
        const { home, runsLog, context, asked } = await twoAccounts('cas-429-moved-', {
          A: [OUT(Date.now() + 60 * 60_000)],
          B: [TURNED_AWAY],
        });
        // Checked as it comes, rather than held until Claude exits.
        context.refuteBackoffMs = 300;
        Object.assign(process.env, refusedOnA(runsLog), { FAKE_CLAUDE_OLD_LOGIN_REQUESTS: '1' });

        expect(await runCommand(context, [])).toBe(0);
        const log = readLog(runsLog);
        expect(launches(log).map((l) => l.marker)).toEqual(['A']);
        // Refused on the login it had, then carried on on B.
        expect(prompts(log).map((p) => [p.marker, p.refused])).toEqual([
          ['A', true],
          ['B', false],
        ]);
        expect(asked).toContain('B');
        expect(capsIn(home).map((c) => c.account)).toEqual(['A']);
        expect(eventsIn(home).filter((e) => e.kind === 'cap-relief')).toHaveLength(1);
        expect(capVerdicts(home).join('\n')).toContain(
          'the refusal came within 40 s of the login changing under Claude, so it may be the old login',
        );
      },
    );

    it(
      'never moves on a refusal that a prompt was typed after, when it is judged',
      { timeout: 60_000 },
      async () => {
        // The first refusal is checked and the account reports room, so the
        // second is held and judged as Claude exits. A prompt was typed in
        // between: that refusal is no longer the turn in front of the session.
        const { home, runsLog, context, asked } = await twoAccounts('cas-429-prompted-', {
          A: [ROOM, TURNED_AWAY],
        });
        Object.assign(process.env, {
          FAKE_CLAUDE_RUNS_LOG: runsLog,
          FAKE_CLAUDE_IDLE_MS: '6000',
          FAKE_CLAUDE_RESUMED_IDLE_MS: '600',
          FAKE_CLAUDE_SESSION_RECORD: '1',
          FAKE_CLAUDE_TRANSCRIPT: '1',
          FAKE_CLAUDE_REFUSE_ON: 'A',
          FAKE_CLAUDE_REFUSE_AFTER_MS: '1500',
          FAKE_CLAUDE_REFUSE_AGAIN_AFTER_MS: '3000',
          FAKE_CLAUDE_PROMPT_AFTER_MS: '4000',
        });

        expect(await runCommand(context, [])).toBe(0);
        expect(asked).toEqual(['A', 'A']);
        expect(launches(readLog(runsLog)).map((l) => l.marker)).toEqual(['A']);
        expect(capsIn(home)).toEqual([]);
        expect(capVerdicts(home).join('\n')).toContain('and a prompt was typed after the refusal');
      },
    );

    it(
      'moves on a refusal held while the account reported room, judged as Claude exits',
      { timeout: 60_000 },
      async () => {
        const { home, runsLog, context, asked } = await twoAccounts('cas-429-held-', {
          A: [ROOM, TURNED_AWAY],
        });
        Object.assign(process.env, {
          FAKE_CLAUDE_RUNS_LOG: runsLog,
          FAKE_CLAUDE_IDLE_MS: '5000',
          FAKE_CLAUDE_RESUMED_IDLE_MS: '600',
          FAKE_CLAUDE_SESSION_RECORD: '1',
          FAKE_CLAUDE_TRANSCRIPT: '1',
          FAKE_CLAUDE_REFUSE_ON: 'A',
          FAKE_CLAUDE_REFUSE_AFTER_MS: '1500',
          FAKE_CLAUDE_REFUSE_AGAIN_AFTER_MS: '3000',
        });

        expect(await runCommand(context, [])).toBe(0);
        expect(asked).toEqual(['A', 'A']);
        // Claude had exited, so it is relaunched, on B.
        expect(launches(readLog(runsLog)).map((l) => l.marker)).toEqual(['A', 'B']);
        expect(capsIn(home).map((c) => c.account)).toEqual(['A']);
      },
    );
  },
);

/** Accounts signed in as the fake claude reports it, for a print-mode run's health check. */
function signInForPrint(home: string, scenario: Record<string, Record<string, unknown>> = {}): void {
  for (const name of ['A', 'B']) {
    writeFileSync(
      path.join(home, 'profiles', name, 'fake-scenario.json'),
      JSON.stringify({
        authStatus: { loggedIn: true, authMethod: 'claude.ai', email: `${name}@example.com` },
        ...scenario[name],
      }),
      'utf8',
    );
  }
}

describe('a print-mode run whose limit meets a turned-away usage check (against fake-claude)', () => {
  afterEach(() => {
    for (const name of [...FAKE_ENV, ...ALSO_SET]) delete process.env[name];
  });

  it(
    "rotates on the run's own record of its refused turn, found by the conversation it reports",
    { timeout: 60_000 },
    async () => {
      const { home, runsLog, context, asked } = await twoAccounts('cas-429-print-', { A: [TURNED_AWAY] });
      signInForPrint(home);
      Object.assign(process.env, {
        FAKE_CLAUDE_RUNS_LOG: runsLog,
        FAKE_CLAUDE_IDLE_MS: '1500',
        FAKE_CLAUDE_SESSION_RECORD: '1',
        FAKE_CLAUDE_TRANSCRIPT: '1',
        FAKE_CLAUDE_REFUSE_ON: 'A',
        FAKE_CLAUDE_REFUSE_AFTER_MS: '300',
        FAKE_CLAUDE_REFUSAL_ENDS_RUN: '1',
      });

      expect(await runCommand(context, ['-p', '--output-format', 'json', 'hi'])).toBe(0);
      expect(asked).toContain('A');
      expect(launches(readLog(runsLog)).map((l) => l.marker)).toEqual(['A', 'B']);
      expect(capsIn(home)).toEqual([expect.objectContaining({ account: 'A', reason: 'usage_limit_reached' })]);
    },
  );

  it('never rotates on limit text alone', { timeout: 60_000 }, async () => {
    const { home, runsLog, context, asked } = await twoAccounts('cas-429-print-words-', { A: [TURNED_AWAY] });
    // A prints a limit message and fails, with no record of a refused turn.
    signInForPrint(home, { A: { capped: true, capMessage: 'Usage limit reached. Try again later.' } });
    Object.assign(process.env, { FAKE_CLAUDE_RUNS_LOG: runsLog, FAKE_CLAUDE_IDLE_MS: '500' });

    expect(await runCommand(context, ['-p', '--output-format', 'json', 'hi'])).toBe(1);
    expect(asked).toEqual(['A']);
    // B never ran.
    expect(launches(readLog(runsLog))).toEqual([]);
    expect(capsIn(home)).toEqual([]);
  });
});
