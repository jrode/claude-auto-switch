import { describe, it, expect, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addCommand } from '../../src/commands/add.js';
import { useCommand } from '../../src/commands/use.js';
import { editorLaunch } from '../../src/commands/editor-launch.js';
import { loadConfig } from '../../src/config/config.js';
import { getActive, setActive } from '../../src/state/active.js';
import { setUpEditor } from '../../src/editor/folder.js';
import { acquireOwnedLock } from '../../src/claude/locks.js';
import { loadLedger } from '../../src/ledger/ledger.js';
import { eventsFilePath } from '../../src/events/log.js';
import type { CliContext } from '../../src/context.js';
import type { LimitVerdict } from '../../src/usage/limit-probe.js';

const fakeClaude = fileURLToPath(new URL('../fake-claude/fake-claude.mjs', import.meta.url));

function makeContext(home: string, verdict: LimitVerdict = 'limited'): CliContext {
  // A home of its own, so the editor's folder and your ~/.claude are the test's too.
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
  return {
    ctx,
    config: loadConfig(ctx),
    claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
    // Text only TRIGGERS a cap; the account decides. Injected here so these
    // tests exercise a VERIFIED limit rather than reaching the network.
    verifyCap: () => Promise.resolve(verdict),
    out: () => {},
    err: () => {},
    json: false,
    quiet: false,
  };
}

function seed(dir: string, opts: { capped?: boolean } = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '.credentials.json'), '{}', 'utf8'); // makes hasLogin true
  writeFileSync(
    path.join(dir, 'fake-scenario.json'),
    JSON.stringify({
      authStatus: { loggedIn: true, subscriptionType: 'max', email: 'x@y.com' },
      capped: opts.capped ?? false,
      capMessage: "You've reached your Fable 5 limit. Run /usage-credits to continue.",
      capExitCode: 1,
    }),
    'utf8',
  );
}

/**
 * Claude runs on the editor's folder, which has no scenario of its own: it
 * follows the account's, as if the login in the folder were that account's.
 */
function runLike(dir: string): void {
  process.env.FAKE_CLAUDE_SCENARIO = path.join(dir, 'fake-scenario.json');
}

afterEach(() => {
  delete process.env.FAKE_CLAUDE_SCENARIO;
});

describe('editorLaunch (against fake-claude)', () => {
  it('runs on the active account and, on a cap, flips active to the next healthy one', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-editor-'));
    const context = makeContext(home);
    const dirA = path.join(home, 'profiles', 'A');
    const dirB = path.join(home, 'profiles', 'B');
    await addCommand(context, 'A', { dir: dirA, login: false });
    await addCommand(context, 'B', { dir: dirB, login: false });
    seed(dirA, { capped: true }); // active account will hit its limit
    seed(dirB, { capped: false });
    useCommand(context, 'A');
    runLike(dirA);

    const exit = await editorLaunch(context, ['chat']);
    expect(exit).toBe(1); // the capped run's exit code passes through

    // A is recorded capped, and the active account has flipped to B for next time.
    expect(loadLedger(context.ctx).caps.map((c) => c.account)).toContain('A');
    expect(getActive(context.ctx)).toBe('B');
  });

  it('runs on the active account normally when it is not capped', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-editor-'));
    const context = makeContext(home);
    const dirA = path.join(home, 'profiles', 'A');
    await addCommand(context, 'A', { dir: dirA, login: false });
    seed(dirA, { capped: false });
    useCommand(context, 'A');

    expect(await editorLaunch(context, ['chat'])).toBe(0);
    expect(getActive(context.ctx)).toBe('A'); // unchanged
    expect(loadLedger(context.ctx).caps).toHaveLength(0);
  });
});


describe('limit-looking text in an editor session', () => {
  it('ignores a reset time that only the rendered text claims', async () => {
    // The verdict was verified; the DURATION in that text was not. A replayed
    // message announcing a reset days away would otherwise bench the account
    // for days on a limit whose real window nobody reported.
    const home = mkdtempSync(path.join(tmpdir(), 'cas-editor-reset-'));
    const context = makeContext(home, 'limited');
    const dirA = path.join(home, 'profiles', 'A');
    const dirB = path.join(home, 'profiles', 'B');
    await addCommand(context, 'A', { dir: dirA, login: false });
    await addCommand(context, 'B', { dir: dirB, login: false });
    seed(dirA, { capped: true });
    seed(dirB, { capped: false });
    useCommand(context, 'A');
    runLike(dirA);

    await editorLaunch(context, ['chat']);

    const cap = loadLedger(context.ctx).caps.find((c) => c.account === 'A');
    expect(cap).toBeDefined();
    // Bounded by the configured backoff, never by anything the text said, and
    // never null, which would mean capped for ever.
    expect(cap!.capUntil).not.toBeNull();
    const hours = (cap!.capUntil! - Date.now()) / 3_600_000;
    expect(hours).toBeLessThanOrEqual(5.1);
  });
  it('does not bench the account when the API says it has room', async () => {
    // This path wrote the cap straight from the classification, so ANY
    // limit-looking text in an editor session, a replayed cap message or a
    // conversation merely discussing rate limits, benched a healthy account
    // for the default five hours and moved the operator off it. Every other
    // cap-recording path had already learned that text only TRIGGERS a check.
    const home = mkdtempSync(path.join(tmpdir(), 'cas-editor-refute-'));
    const context = makeContext(home, 'allowed');
    const dirA = path.join(home, 'profiles', 'A');
    const dirB = path.join(home, 'profiles', 'B');
    await addCommand(context, 'A', { dir: dirA, login: false });
    await addCommand(context, 'B', { dir: dirB, login: false });
    seed(dirA, { capped: true }); // prints the limit message
    seed(dirB, { capped: false });
    useCommand(context, 'A');
    runLike(dirA);

    await editorLaunch(context, ['chat']);

    expect(loadLedger(context.ctx).caps).toHaveLength(0);
    expect(getActive(context.ctx)).toBe('A'); // and the operator is not moved
  });
});

/** Account A, signed in as the fake claude reads it, and active. */
async function accountA(context: CliContext, home: string): Promise<string> {
  const dirA = path.join(home, 'profiles', 'A');
  await addCommand(context, 'A', { dir: dirA, login: false });
  seed(dirA);
  writeFileSync(path.join(dirA, '.credentials.json'), JSON.stringify({ account: 'A' }), 'utf8');
  useCommand(context, 'A');
  return dirA;
}

const eventMessages = (home: string): string[] =>
  existsSync(eventsFilePath(home))
    ? readFileSync(eventsFilePath(home), 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => (JSON.parse(line) as { msg: string }).msg)
    : [];

describe("editorLaunch on the editor's own folder (against fake-claude)", () => {
  afterEach(() => {
    delete process.env.FAKE_CLAUDE_RUNS_LOG;
    delete process.env.FAKE_CLAUDE_LOG_FOLDER;
  });

  it("runs Claude on the editor's folder, made when missing, with your settings and CLAUDE.md in it", async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-editor-folder-'));
    const context = makeContext(home);
    const dirA = await accountA(context, home);
    const folder = path.join(home, 'editor-active');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({ model: 'fable' }),
      'utf8',
    );
    writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'my memory', 'utf8');
    const runsLog = path.join(home, 'runs.jsonl');
    process.env.FAKE_CLAUDE_RUNS_LOG = runsLog;
    process.env.FAKE_CLAUDE_LOG_FOLDER = '1';
    expect(existsSync(folder)).toBe(false);

    expect(await editorLaunch(context, ['chat'])).toBe(0);

    const launch = JSON.parse(readFileSync(runsLog, 'utf8').trim().split('\n')[0]!) as {
      marker: string | null;
      folder: { configDir: string; settings: unknown };
    };
    expect(launch.folder.configDir).toBe(realpathSync(folder));
    expect(launch.folder.settings).toEqual({ model: 'fable' });
    // The login in it is the active account's, copied from its own folder.
    expect(launch.marker).toBe('A');
    expect(readFileSync(path.join(folder, 'CLAUDE.md'), 'utf8')).toBe('my memory');
    expect(
      JSON.parse(readFileSync(path.join(folder, 'fake-last-run.json'), 'utf8')).configDir,
    ).toBe(folder);
    expect(existsSync(path.join(dirA, 'fake-last-run.json'))).toBe(false);
  });

  it("runs on the account's own folder, and says why, when the editor's folder holds no working login and cannot be brought up now", async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-editor-no-login-'));
    const context = makeContext(home);
    const dirA = await accountA(context, home);
    // The folder is on B, which has no login to put in it.
    const dirB = path.join(home, 'profiles', 'B');
    await addCommand(context, 'B', { dir: dirB, login: false });
    seed(dirB);
    setActive('B', context.ctx);
    await setUpEditor(context);
    setActive('A', context.ctx);
    // Another ccx is changing the folder, so the move to A cannot be made now.
    const lock = acquireOwnedLock(path.join(home, 'editor-folder.lock'), {
      waitMs: 0,
      staleMs: 60_000,
      maxHoldMs: 60_000,
    });
    try {
      expect(await editorLaunch(context, ['chat'])).toBe(0);
    } finally {
      lock.release();
    }

    expect(JSON.parse(readFileSync(path.join(dirA, 'fake-last-run.json'), 'utf8')).configDir).toBe(
      dirA,
    );
    expect(existsSync(path.join(home, 'editor-active', 'fake-last-run.json'))).toBe(false);
    const said = eventMessages(home).find((msg) => msg.includes("runs on A's own folder"));
    expect(said).toContain('another ccx was changing the folder');
  });

  it("runs on the account's own folder, and says why, when the editor's folder cannot be set up", async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-editor-fallback-'));
    const context = makeContext(home);
    const dirA = await accountA(context, home);
    // A file where the folder would be.
    writeFileSync(path.join(home, 'editor-active'), 'in the way', 'utf8');

    expect(await editorLaunch(context, ['chat'])).toBe(0);

    expect(JSON.parse(readFileSync(path.join(dirA, 'fake-last-run.json'), 'utf8')).configDir).toBe(
      dirA,
    );
    expect(readFileSync(path.join(home, 'editor-active'), 'utf8')).toBe('in the way');
    const said = eventMessages(home).find((msg) => msg.includes("runs on A's own folder"));
    expect(said).toContain('is not a folder');
  });
});
