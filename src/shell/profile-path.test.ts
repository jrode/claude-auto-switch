import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  FACTS_ARGS,
  parsePowerShellFacts,
  queryPowerShell,
  shouldAskPowerShell,
  utf8Base64,
  type PowerShellExe,
} from './profile-path.js';

describe('shouldAskPowerShell', () => {
  it('decides by what was injected, on any host', () => {
    expect(shouldAskPowerShell({}, 'win32')).toBe(true);
    expect(shouldAskPowerShell({ env: { USERPROFILE: 'C:\\tmp' } }, 'win32')).toBe(false);
    expect(shouldAskPowerShell({ platform: 'win32' }, 'win32')).toBe(false);
    expect(shouldAskPowerShell({}, 'linux')).toBe(false);
  });
});

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

describe('parsePowerShellFacts', () => {
  // A user name outside ASCII. PowerShell writes to a pipe in the console's
  // code page, so the paths come back as Base64 of their UTF-8 bytes.
  const user = `Jos${String.fromCharCode(0xe9)} ${String.fromCharCode(0x7530, 0x4e2d)}`;
  const docs = `C:\\Users\\${user}\\OneDrive\\Documents\\WindowsPowerShell`;
  const answer = (policy: string, machine = 'Undefined', userPolicy = 'Undefined') =>
    [
      `allHosts=${b64(`${docs}\\profile.ps1`)}`,
      `currentHost=${b64(`${docs}\\Microsoft.PowerShell_profile.ps1`)}`,
      `policy=${policy}`,
      `machinePolicy=${machine}`,
      `userPolicy=${userPolicy}`,
      '',
    ].join('\r\n');

  it('reads both profiles, with any user name, and the policy and whether Group Policy set it', () => {
    expect(parsePowerShellFacts(answer('Restricted'))).toEqual({
      allHosts: `${docs}\\profile.ps1`,
      currentHost: `${docs}\\Microsoft.PowerShell_profile.ps1`,
      policy: 'Restricted',
      policyFromGroupPolicy: false,
    });
    expect(parsePowerShellFacts(answer('AllSigned', 'Undefined', 'AllSigned'))?.policyFromGroupPolicy).toBe(true);
  });

  it('reads each value by its name, whatever else PowerShell printed around it', () => {
    const noisy = `WARNING: something first\r\n\r\n${answer('RemoteSigned').split('\r\n').reverse().join('\r\n')}`;
    expect(parsePowerShellFacts(noisy)?.policy).toBe('RemoteSigned');
    // A policy line that never came does not move another value into its place.
    const noPolicy = answer('RemoteSigned').replace(/policy=RemoteSigned\r\n/, '');
    expect(parsePowerShellFacts(noPolicy)).toEqual(expect.objectContaining({ policy: 'Unknown', policyFromGroupPolicy: false }));
  });

  it('takes anything that does not name two profiles as no answer', () => {
    expect(parsePowerShellFacts('')).toBeNull();
    expect(parsePowerShellFacts('The term is not recognized\r\n')).toBeNull();
    expect(parsePowerShellFacts(`allHosts=${b64(`${docs}\\profile.ps1`)}\r\n`)).toBeNull();
    // A path written in plain text, in whatever code page, is never taken for one.
    expect(parsePowerShellFacts(`allHosts=${docs}\\profile.ps1\r\ncurrentHost=${docs}\\x.ps1\r\n`)).toBeNull();
  });
});

// The real PowerShells, on the Windows runner only. They are asked where
// their profiles are; no profile is read or written.
const onWindowsCi = process.platform === 'win32' && Boolean(process.env.CI);

describe.runIf(onWindowsCi)('queryPowerShell, asking the real PowerShells', () => {
  /** What PowerShell itself said, stderr included, for when the answer did not parse. */
  const said = (exe: string): string => {
    const started = Date.now();
    const r = spawnSync(exe, FACTS_ARGS, { encoding: 'utf8', timeout: 60_000, windowsHide: true });
    return JSON.stringify({
      ms: Date.now() - started,
      status: r.status,
      error: r.error?.message,
      stdout: r.stdout,
      stderr: r.stderr,
    });
  };
  const folders: Array<[PowerShellExe, string]> = [
    ['powershell', 'WindowsPowerShell'],
    ['pwsh', 'PowerShell'],
  ];

  for (const [exe, folder] of folders) {
    it(`gets ${exe} its own profiles and a policy`, () => {
      const started = Date.now();
      const facts = queryPowerShell(exe);
      const took = Date.now() - started;
      const why = facts && facts.policy !== 'Unknown' ? '' : `query took ${took} ms; again: ${said(exe)}`;
      expect(facts?.allHosts, why).toMatch(new RegExp(`\\\\${folder}\\\\profile\\.ps1$`));
      expect(facts?.currentHost, why).toMatch(
        new RegExp(`\\\\${folder}\\\\Microsoft\\.PowerShell_profile\\.ps1$`),
      );
      expect(facts?.policy, why).toMatch(/^(Restricted|AllSigned|RemoteSigned|Unrestricted|Bypass|Undefined)$/);
    }, 120_000);
  }

  it('brings back a name outside ASCII whole, from both editions', () => {
    const expr = '([string][char]0x00E9 + [string][char]0x7530)';
    for (const exe of ['powershell', 'pwsh']) {
      const r = spawnSync(exe, ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', utf8Base64(expr)], {
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(Buffer.from(r.stdout.trim(), 'base64').toString('utf8'), r.stderr).toBe(
        String.fromCharCode(0xe9, 0x7530),
      );
    }
  }, 60_000);
});
