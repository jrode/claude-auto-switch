import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addCommand } from '../../src/commands/add.js';
import { runCommand } from '../../src/commands/run.js';
import { setActive } from '../../src/state/active.js';
import { loadConfig } from '../../src/config/config.js';
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

describe('the ledger a headless run leaves (against fake-claude)', () => {
  it('keeps a limit another session recorded while the run went on, and records its own as it finds them', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-headless-ledger-'));
    const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
    const asked: string[] = [];
    let onRecordWhenBWasAsked: string[] = [];
    const context: CliContext = {
      ctx,
      config: loadConfig(ctx),
      claude: { bin: process.execPath, prefixArgs: [fakeClaude] },
      // The usage check, asked by the account whose login it is given: every
      // account it is asked about is out.
      capProbe: (credentialsFile) => {
        const name = (JSON.parse(readFileSync(credentialsFile, 'utf8')) as { account: string }).account;
        asked.push(name);
        if (name === 'A') {
          // Meanwhile another session finds D out and records it, as any
          // change to the ledger does: read it, add the limit, write it back.
          const now = Date.now();
          const caps = [...capsIn(home), { account: 'D', capUntil: now + HOUR, reason: 'another session', at: now }];
          writeFileSync(ledgerFile(home), JSON.stringify({ caps }), 'utf8');
        }
        if (name === 'B') onRecordWhenBWasAsked = accountsIn(home);
        const out: LimitProbeResult = { verdict: 'limited', fiveHour: 1, sevenDay: 0.4, fiveHourReset: Date.now() + HOUR };
        return Promise.resolve(out);
      },
      out: () => {},
      err: () => {},
      json: false,
      quiet: false,
    };
    // In this order: A and B are out, C has room, and the run never gets to D.
    await account(context, home, 'A', true);
    await account(context, home, 'B', true);
    await account(context, home, 'C', false);
    await account(context, home, 'D', false);
    setActive('A', ctx);

    expect(await runCommand(context, ['-p', 'hi'])).toBe(0);

    expect(asked).toEqual(['A', 'B']);
    // A's limit was on record while the run was still going, for any other
    // session choosing an account then.
    expect(onRecordWhenBWasAsked).toEqual(['A', 'D']);
    // Its own two limits, and the one another session recorded while it ran.
    expect(accountsIn(home)).toEqual(['A', 'B', 'D']);
  }, 60_000);
});
