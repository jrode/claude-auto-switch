import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { useCommand } from './use.js';
import { addCommand } from './add.js';
import { loadConfig } from '../config/config.js';
import { readSwitchRequest, writeSwitchRequest } from '../state/switch-request.js';
import type { SessionLease } from '../session/lease.js';
import type { CliContext } from '../context.js';

describe('`ccx use` with several sessions running and no --all', () => {
  it('moves none, and takes back a move still waiting for one already on the account', async () => {
    // `ccx use B --all` asked both to move to B; `ccx use A` before they had
    // moved returned without asking anything, so they still moved to B.
    const home = mkdtempSync(path.join(tmpdir(), 'cas-use-stays-'));
    const ctx = { env: { CLAUDE_AUTO_SWITCH_HOME: home, HOME: home, USERPROFILE: home } };
    const context: CliContext = { ctx, config: loadConfig(ctx), out: () => {}, err: () => {}, json: false, quiet: false };
    for (const name of ['A', 'B']) await addCommand(context, name, { dir: path.join(home, 'profiles', name), login: false });
    const lease = (pid: number, account: string): SessionLease => ({ pid, account, configDir: path.join(home, `s${pid}`), at: Date.now() });
    writeSwitchRequest('B', 1, 'seamless', ctx, 111);
    writeSwitchRequest('B', 1, 'seamless', ctx, 222);

    expect(useCommand(context, 'A', {}, () => [lease(111, 'A'), lease(222, 'C')])).toBe(0);
    // The one on A stays there; the one on C was not asked to come to A, and keeps its request.
    expect(readSwitchRequest(ctx, 111)).toBeNull();
    expect(readSwitchRequest(ctx, 222)?.account).toBe('B');
  });
});
