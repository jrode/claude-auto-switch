import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addCommand } from '../../src/commands/add.js';
import { runCommand } from '../../src/commands/run.js';
import { setActive } from '../../src/state/active.js';
import { loadConfig } from '../../src/config/config.js';
import { readEvents } from '../../src/events/log.js';
import type { CliContext } from '../../src/context.js';
import type { LimitProbeResult } from '../../src/usage/limit-probe.js';

/**
 * What a `claude -p` run through ccx leaves on the limits ledger. Such a run
 * can take minutes, and other sessions record limits while it goes. It used to
 * read the ledger as it started and write that copy back, with its own changes,
 * as it ended, which erased every limit recorded in between: an account still
 * out went back into rotation.
 */

const fakeClaude = fileURLToPath(new URL('../fake-claude/fake-claude.mjs', import.meta.url));
const HOUR = 3_600_000;

interface Cap {
  account: string;
  capUntil: number | null;
  reason: string;
  at: number;
}

const ledgerFile = (home: string): string => path.join(home, 'ledger.json');
const capsIn = (home: string): Cap[] =>
  existsSync(ledgerFile(home)) ? (JSON.parse(readFileSync(ledgerFile(home), 'utf8')) as { caps: Cap[] }).caps : [];
const accountsIn = (home: string): string[] => capsIn(home).map((cap) => cap.account).sort();

async function account(context: CliContext, home: string, name: string, capped: boolean): Promise<void> {
  const dir = path.join(home, 'profiles', name);
  await addCommand(context, name, { dir, login: false });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ account: name }), 'utf8');
  writeFileSync(
    path.join(dir, 'fake-scenario.json'),
    JSON.stringify({
      authStatus: { loggedIn: true, subscriptionType: 'max', email: `${name.toLowerCase()}@example.com` },
      capped,
      capMessage: 'Usage limit reached. Try again later.',
      capExitCode: 1,
    }),
    'utf8',
  );
}

/**
 * Accounts A and B out of room, C with room, and D, which the run never gets
 * to. The usage check calls `whenAsked` with the account it is asked about,
 * then says that account is out.
 */
async function fourAccounts(
  whenAsked: (name: string, home: string) => void,
): Promise<{ home: string; context: CliContext; asked: string[] }> {
  const home = mkdtempSync(path.join(tmpdir(), 'cas-headless-ledger-'));
  const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
  const asked: string[] = [];
  const context: CliContext = {
    ctx,
    config: loadConfig(ctx),
    claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
    capProbe: (credentialsFile) => {
      const name = (JSON.parse(readFileSync(credentialsFile, 'utf8')) as { account: string }).account;
      asked.push(name);
      whenAsked(name, home);
      const out: LimitProbeResult = { verdict: 'limited', fiveHour: 1, sevenDay: 0.4, fiveHourReset: Date.now() + HOUR };
      return Promise.resolve(out);
    },
    out: () => {},
    err: () => {},
    json: false,
    quiet: false,
  };
  await account(context, home, 'A', true);
  await account(context, home, 'B', true);
  await account(context, home, 'C', false);
  await account(context, home, 'D', false);
  setActive('A', ctx);
  return { home, context, asked };
}

describe('the ledger a headless run leaves (against fake-claude)', () => {
  it('keeps a limit another session recorded while the run went on, and records its own as it finds them', async () => {
    let onRecordWhenBWasAsked: string[] = [];
    const { home, context, asked } = await fourAccounts((name, dir) => {
      if (name === 'A') {
        // Meanwhile another session finds D out and records it, as any
        // change to the ledger does: read it, add the limit, write it back.
        const now = Date.now();
        const caps = [...capsIn(dir), { account: 'D', capUntil: now + HOUR, reason: 'another session', at: now }];
        writeFileSync(ledgerFile(dir), JSON.stringify({ caps }), 'utf8');
      }
      if (name === 'B') onRecordWhenBWasAsked = accountsIn(dir);
    });

    expect(await runCommand(context, ['-p', 'hi'])).toBe(0);

    expect(asked).toEqual(['A', 'B']);
    // A's limit was on record while the run was still going, for any other
    // session choosing an account then.
    expect(onRecordWhenBWasAsked).toEqual(['A', 'D']);
    // Its own two limits, and the one another session recorded while it ran.
    expect(accountsIn(home)).toEqual(['A', 'B', 'D']);
  }, 60_000);

  it('goes on to the next account when a limit cannot be recorded, and says what was lost', async () => {
    // The ledger cannot be read while A's limit is being recorded, and is
    // whole again by the time B's is.
    const { home, context, asked } = await fourAccounts((name, dir) => {
      if (name === 'A') writeFileSync(ledgerFile(dir), '{ not json', 'utf8');
      if (name === 'B') writeFileSync(ledgerFile(dir), JSON.stringify({ caps: [] }), 'utf8');
    });

    expect(await runCommand(context, ['-p', 'hi'])).toBe(0);

    expect(asked).toEqual(['A', 'B']);
    expect(accountsIn(home)).toEqual(['B']);
    const failed = readEvents(home, 100).filter((e) => e.kind === 'ledger-write-failed');
    expect(failed.map((e) => e.msg.split(' (')[0])).toEqual(['could not record that "A" is out on the ledger']);
  }, 60_000);
});
