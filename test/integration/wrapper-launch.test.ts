import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addCommand } from '../../src/commands/add.js';
import { useCommand } from '../../src/commands/use.js';
import { wrapperLaunch } from '../../src/commands/editor-launch.js';
import { loadConfig } from '../../src/config/config.js';
import { getActive } from '../../src/state/active.js';
import { loadLedger } from '../../src/ledger/ledger.js';
import type { CliContext } from '../../src/context.js';
import type { LimitVerdict } from '../../src/usage/limit-probe.js';

// The "command" the editor would hand the wrapper: node running the fake claude.
const fakeClaude = fileURLToPath(new URL('../fake-claude/fake-claude.mjs', import.meta.url));

function makeContext(home: string, verdict: LimitVerdict = 'limited'): CliContext {
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home } };
  return {
    ctx,
    config: loadConfig(ctx),
    claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
    // Text only TRIGGERS a cap; the account decides. Injected here so these
    // tests exercise a VERIFIED limit rather than reaching the network.
    verifyCap: () => Promise.resolve(verdict), // health probes use the fake
    out: () => {},
    err: () => {},
    json: false,
    quiet: false,
  };
}

function seed(
  dir: string,
  capped: boolean,
  capMessage = "You've reached your Fable 5 limit. Run /usage-credits to continue.",
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '.credentials.json'), '{}', 'utf8');
  writeFileSync(
    path.join(dir, 'fake-scenario.json'),
    JSON.stringify({
      authStatus: { loggedIn: true, subscriptionType: 'max', email: 'x@y.com' },
      capped,
      capMessage,
      capExitCode: 1,
    }),
    'utf8',
  );
}

describe('wrapperLaunch (runs the editor-supplied command on the active account)', () => {
  it('runs the command with the active account config dir injected', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-wrap-'));
    const context = makeContext(home);
    const dirA = path.join(home, 'profiles', 'A');
    await addCommand(context, 'A', { dir: dirA, login: false });
    seed(dirA, false);
    useCommand(context, 'A');

    // Editor-style invocation: run `node <fakeClaude> chat`.
    const exit = await wrapperLaunch(context, [process.execPath, fakeClaude, 'chat']);
    expect(exit).toBe(0);
    const record = JSON.parse(readFileSync(path.join(dirA, 'fake-last-run.json'), 'utf8'));
    expect(record.configDir).toBe(dirA); // command ran on account A's config dir
    expect(getActive(context.ctx)).toBe('A'); // no cap, stays put
  });

  it('flips the active account to a healthy one when the command caps', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-wrap-'));
    const context = makeContext(home);
    const dirA = path.join(home, 'profiles', 'A');
    const dirB = path.join(home, 'profiles', 'B');
    await addCommand(context, 'A', { dir: dirA, login: false });
    await addCommand(context, 'B', { dir: dirB, login: false });
    seed(dirA, true); // active caps
    seed(dirB, false);
    useCommand(context, 'A');

    const exit = await wrapperLaunch(context, [process.execPath, fakeClaude, 'chat']);
    expect(exit).toBe(1);
    expect(loadLedger(context.ctx).caps.map((c) => c.account)).toContain('A');
    expect(getActive(context.ctx)).toBe('B'); // next editor chat uses B
  });

  it("flips the active account when the command ends on Claude 2.1.302's words at a limit", async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-wrap-'));
    const context = makeContext(home);
    const dirA = path.join(home, 'profiles', 'A');
    const dirB = path.join(home, 'profiles', 'B');
    await addCommand(context, 'A', { dir: dirA, login: false });
    await addCommand(context, 'B', { dir: dirB, login: false });
    seed(dirA, true, "You've hit your limit · resets 9pm (America/New_York)");
    seed(dirB, false);
    useCommand(context, 'A');

    expect(await wrapperLaunch(context, [process.execPath, fakeClaude, 'chat'])).toBe(1);
    expect(loadLedger(context.ctx).caps.map((c) => c.account)).toEqual(['A']);
    expect(getActive(context.ctx)).toBe('B');
  });
});

describe("wrapperLaunch on the editor's own folder", () => {
  it("runs the editor's command on the editor's folder, made when missing, with your setup in it", async () => {
    // A home of its own, so ccx can build the editor's folder and find your ~/.claude.
    const home = mkdtempSync(path.join(tmpdir(), 'cas-wrap-folder-'));
    const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
    const context: CliContext = { ...makeContext(home), ctx, config: loadConfig(ctx) };
    const dirA = path.join(home, 'profiles', 'A');
    await addCommand(context, 'A', { dir: dirA, login: false });
    seed(dirA, false);
    useCommand(context, 'A');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'my memory', 'utf8');
    const folder = path.join(home, 'editor-active');
    expect(existsSync(folder)).toBe(false);

    expect(await wrapperLaunch(context, [process.execPath, fakeClaude, 'chat'])).toBe(0);

    expect(JSON.parse(readFileSync(path.join(folder, 'fake-last-run.json'), 'utf8')).configDir).toBe(folder);
    expect(readFileSync(path.join(folder, 'CLAUDE.md'), 'utf8')).toBe('my memory');
    expect(existsSync(path.join(dirA, 'fake-last-run.json'))).toBe(false);
  });
});
