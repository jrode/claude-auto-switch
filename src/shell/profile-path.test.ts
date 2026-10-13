import { describe, it, expect } from 'vitest';
import { parsePowerShellFacts, shouldAskPowerShell } from './profile-path.js';

describe('shouldAskPowerShell', () => {
  it('decides by what was injected, on any host', () => {
    expect(shouldAskPowerShell({}, 'win32')).toBe(true);
    expect(shouldAskPowerShell({ env: { USERPROFILE: 'C:\\tmp' } }, 'win32')).toBe(false);
    expect(shouldAskPowerShell({ platform: 'win32' }, 'win32')).toBe(false);
    expect(shouldAskPowerShell({}, 'linux')).toBe(false);
  });
});

describe('parsePowerShellFacts', () => {
  const docs = 'C:\\Users\\me\\OneDrive\\Documents\\WindowsPowerShell';

  it('reads both profiles and the policy, and whether Group Policy set it', () => {
    const out = [
      `${docs}\\profile.ps1`,
      `${docs}\\Microsoft.PowerShell_profile.ps1`,
      'Restricted',
      'Undefined',
      'Undefined',
      '',
    ].join('\r\n');
    expect(parsePowerShellFacts(out)).toEqual({
      allHosts: `${docs}\\profile.ps1`,
      currentHost: `${docs}\\Microsoft.PowerShell_profile.ps1`,
      policy: 'Restricted',
      policyFromGroupPolicy: false,
    });
    const managed = out.replace('Undefined\r\nUndefined', 'Undefined\r\nAllSigned');
    expect(parsePowerShellFacts(managed)?.policyFromGroupPolicy).toBe(true);
  });

  it('takes anything that does not name two profiles as no answer', () => {
    expect(parsePowerShellFacts('')).toBeNull();
    expect(parsePowerShellFacts('The term is not recognized\r\n')).toBeNull();
    expect(parsePowerShellFacts(`${docs}\\profile.ps1\r\n`)).toBeNull();
  });
});
