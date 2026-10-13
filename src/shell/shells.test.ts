import { describe, it, expect } from 'vitest';
import {
  findGitBash,
  loadsBashrc,
  planShells,
  readMachine,
  selectShells,
  shellCoverage,
  type Machine,
  type ShellFs,
  type ShellPlan,
} from './shells.js';
import { shimBlock } from './install-shim.js';
import type { PowerShellFacts } from './profile-path.js';

/** A file system held in memory: no test here reads or writes a real profile. */
function memFs(files: Record<string, string>): ShellFs {
  const norm = (f: string) => f.replace(/\\/g, '/');
  const keys = Object.keys(files).map(norm);
  return {
    exists: (f) => keys.some((k) => k === norm(f) || k.startsWith(`${norm(f)}/`)),
    read: (f) => {
      const hit = Object.keys(files).find((k) => norm(k) === norm(f));
      return hit === undefined ? null : (files[hit] ?? null);
    },
  };
}

function mac(files: Record<string, string> = {}, env: NodeJS.ProcessEnv = {}): Machine {
  return {
    platform: 'darwin',
    env: { HOME: '/Users/me', SHELL: '/bin/zsh', ...env },
    fs: memFs(files),
    powershell: {},
    gitBash: false,
  };
}

function plan(plans: ShellPlan[], id: ShellPlan['id']): ShellPlan {
  const found = plans.find((p) => p.id === id);
  if (!found) throw new Error(`no ${id} plan`);
  return found;
}

const block = shimBlock('posix');

describe('zsh', () => {
  it('is set up in ~/.zshrc when it is the login shell, even before that file exists', () => {
    const zsh = plan(planShells(mac()), 'zsh');
    expect(zsh.state).toBe('use');
    expect(zsh.files).toEqual(['/Users/me/.zshrc']);
    expect(zsh.label).toBe('zsh');
  });

  it('follows ZDOTDIR, which is where zsh reads .zshrc from when it is set', () => {
    const zsh = plan(planShells(mac({}, { ZDOTDIR: '/Users/me/.config/zsh' })), 'zsh');
    expect(zsh.files).toEqual(['/Users/me/.config/zsh/.zshrc']);
    // ccx off still cleans the copy an older ccx wrote to ~/.zshrc.
    expect(zsh.sweep).toContain('/Users/me/.zshrc');
  });

  it('is left alone when it is not the login shell and nothing shows it is used', () => {
    const zsh = plan(planShells(mac({}, { SHELL: '/bin/bash' })), 'zsh');
    expect(zsh.state).toBe('unused');
    expect(zsh.why).toContain('zsh');
  });

  it('counts a startup file or a history as use', () => {
    expect(plan(planShells(mac({ '/Users/me/.zshrc': '' }, { SHELL: '/bin/bash' })), 'zsh').state).toBe('use');
    expect(plan(planShells(mac({ '/Users/me/.zsh_history': '' }, { SHELL: '/bin/bash' })), 'zsh').state).toBe(
      'use',
    );
  });
});

describe('bash', () => {
  it('is left alone on a Mac where nothing shows bash is used', () => {
    // The state of the machine this was written on: zsh is the login shell,
    // and bash has no startup file and no history. Creating two files for a
    // shell nobody opens would be litter.
    const bash = plan(planShells(mac()), 'bash');
    expect(bash.state).toBe('unused');
    expect(bash.why).toContain('bash');
  });

  it('covers a login shell and a non-login shell, which read different files', () => {
    // A Mac terminal starts bash as a login shell, which reads .bash_profile
    // and never .bashrc; `bash` typed at a prompt reads only .bashrc.
    const bash = plan(planShells(mac({ '/Users/me/.bash_profile': 'export A=1\n' })), 'bash');
    expect(bash.state).toBe('use');
    expect(bash.files).toEqual(['/Users/me/.bashrc', '/Users/me/.bash_profile']);
    expect(bash.retired).toEqual([]);
  });

  it('puts it only in .bashrc when the login file loads .bashrc, so a login shell gets it once', () => {
    const files = { '/Users/me/.bash_profile': '[ -f ~/.bashrc ] && . ~/.bashrc\n', '/Users/me/.bashrc': '' };
    const bash = plan(planShells(mac(files)), 'bash');
    expect(bash.files).toEqual(['/Users/me/.bashrc']);
    // A copy already in that login file would load twice, so it goes.
    expect(bash.retired).toEqual(['/Users/me/.bash_profile']);
  });

  it('writes the login file bash really reads: the first of .bash_profile, .bash_login and .profile', () => {
    const viaLogin = plan(
      planShells(mac({ '/Users/me/.bash_login': 'x\n', '/Users/me/.profile': 'y\n', '/Users/me/.bashrc': '' })),
      'bash',
    );
    expect(viaLogin.files).toEqual(['/Users/me/.bashrc', '/Users/me/.bash_login']);

    const viaProfile = plan(planShells(mac({ '/Users/me/.profile': 'y\n', '/Users/me/.bashrc': '' })), 'bash');
    expect(viaProfile.files).toEqual(['/Users/me/.bashrc', '/Users/me/.profile']);
  });

  it('creates .profile, never .bash_profile, when bash has no login file at all', () => {
    // A new .bash_profile would hide a .profile created later; a new .profile
    // hides nothing, because bash reads it last.
    const bash = plan(planShells(mac({ '/Users/me/.bashrc': '' })), 'bash');
    expect(bash.files).toEqual(['/Users/me/.bashrc', '/Users/me/.profile']);
  });

  it('counts a history as use, and its login shell', () => {
    expect(plan(planShells(mac({ '/Users/me/.bash_history': '' })), 'bash').state).toBe('use');
    expect(plan(planShells(mac({}, { SHELL: '/bin/bash' })), 'bash').state).toBe('use');
  });

  it('keeps the usual Linux setup to .bashrc, which its .profile loads', () => {
    const ubuntuProfile = [
      'if [ -n "$BASH_VERSION" ]; then',
      '    # include .bashrc if it exists',
      '    if [ -f "$HOME/.bashrc" ]; then',
      '        . "$HOME/.bashrc"',
      '    fi',
      'fi',
    ].join('\n');
    const m: Machine = {
      ...mac({ '/home/me/.profile': ubuntuProfile, '/home/me/.bashrc': '' }),
      platform: 'linux',
      env: { HOME: '/home/me', SHELL: '/bin/bash' },
    };
    const bash = plan(planShells(m), 'bash');
    expect(bash.files).toEqual(['/home/me/.bashrc']);
    expect(bash.sweep).toEqual([
      '/home/me/.bashrc',
      '/home/me/.bash_profile',
      '/home/me/.bash_login',
      '/home/me/.profile',
    ]);
  });
});

describe('loadsBashrc', () => {
  it('recognises the ways login files load .bashrc', () => {
    expect(loadsBashrc('[ -f ~/.bashrc ] && . ~/.bashrc')).toBe(true);
    expect(loadsBashrc('source ~/.bashrc')).toBe(true);
    expect(loadsBashrc('if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi')).toBe(true);
    expect(loadsBashrc('test -f ~/.bashrc && . ~/.bashrc')).toBe(true); // Git for Windows writes this
    expect(loadsBashrc('  source "${HOME}/.bashrc"\r\n')).toBe(true);
  });

  it('does not count a mention that loads nothing', () => {
    expect(loadsBashrc('# . ~/.bashrc')).toBe(false);
    expect(loadsBashrc('export A=1  # source ~/.bashrc later')).toBe(false);
    expect(loadsBashrc('[ -f ~/.bashrc ] || echo none')).toBe(false);
    expect(loadsBashrc('. ~/.bashrc.local')).toBe(false);
    expect(loadsBashrc('')).toBe(false);
  });
});

describe('a shell that already has the shim', () => {
  it('counts as used, so an existing install keeps being kept up to date', () => {
    const files = { '/Users/me/.config/powershell/profile.ps1': shimBlock('powershell') };
    const pwsh = plan(planShells(mac(files)), 'pwsh');
    expect(pwsh.state).toBe('use');
  });

  it('is not taken for one that does not', () => {
    // PowerShell on a Mac is set up only when asked: ccx on --shell pwsh.
    expect(plan(planShells(mac()), 'pwsh').state).toBe('absent');
    expect(plan(planShells(mac()), 'pwsh').files).toEqual(['/Users/me/.config/powershell/profile.ps1']);
  });
});

const facts = (dir: string, policy = 'RemoteSigned', policyFromGroupPolicy = false): PowerShellFacts => ({
  allHosts: `${dir}\\profile.ps1`,
  currentHost: `${dir}\\Microsoft.PowerShell_profile.ps1`,
  policy,
  policyFromGroupPolicy,
});

function windows(over: Partial<Machine> = {}, files: Record<string, string> = {}): Machine {
  return {
    platform: 'win32',
    env: { USERPROFILE: 'C:\\Users\\me' },
    fs: memFs(files),
    powershell: {},
    gitBash: false,
    ...over,
  };
}

describe('PowerShell on Windows', () => {
  const docs = 'C:\\Users\\me\\OneDrive\\Documents';

  it('uses the all-hosts profile of each edition, which every host reads', () => {
    const plans = planShells(
      windows({ powershell: { powershell: facts(`${docs}\\WindowsPowerShell`), pwsh: facts(`${docs}\\PowerShell`) } }),
    );
    const ps5 = plan(plans, 'powershell');
    expect(ps5.label).toBe('Windows PowerShell');
    expect(ps5.state).toBe('use');
    expect(ps5.files).toEqual([`${docs}\\WindowsPowerShell\\profile.ps1`]);
    // Where ccx put it before: the console-only profile, read after the
    // all-hosts one, so an old copy left there would win.
    expect(ps5.retired).toEqual([`${docs}\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1`]);

    const ps7 = plan(plans, 'pwsh');
    expect(ps7.label).toBe('PowerShell 7');
    expect(ps7.state).toBe('use');
    expect(ps7.files).toEqual([`${docs}\\PowerShell\\profile.ps1`]);
  });

  it('covers Windows PowerShell always, since it ships with Windows, and PowerShell 7 only when it answers', () => {
    const plans = planShells(windows({ powershell: { powershell: facts(`${docs}\\WindowsPowerShell`), pwsh: null } }));
    expect(plan(plans, 'powershell').state).toBe('use');
    expect(plan(plans, 'pwsh').state).toBe('absent');
    // Even when Windows PowerShell itself did not answer in time.
    expect(plan(planShells(windows({ powershell: { powershell: null, pwsh: null } })), 'powershell').state).toBe(
      'use',
    );
  });

  it('works the folders out when PowerShell was not asked, OneDrive first', () => {
    const plans = planShells(
      windows({ env: { USERPROFILE: 'C:\\Users\\me', OneDrive: 'C:\\Users\\me\\OneDrive' } }, {
        [`${docs}\\PowerShell\\Modules\\x.psm1`]: '',
      }),
    );
    expect(plan(plans, 'powershell').files).toEqual([`${docs}\\WindowsPowerShell\\profile.ps1`]);
    // Not asked, so PowerShell 7 counts as installed when its folder exists.
    expect(plan(plans, 'pwsh').state).toBe('use');
    expect(plan(planShells(windows()), 'pwsh').state).toBe('absent');
    expect(plan(planShells(windows()), 'powershell').files).toEqual([
      'C:\\Users\\me\\Documents\\WindowsPowerShell\\profile.ps1',
    ]);
  });

  it('cleans every profile an older ccx could have written, on ccx off', () => {
    const plans = planShells(
      windows({
        env: { USERPROFILE: 'C:\\Users\\me', OneDrive: 'C:\\Users\\me\\OneDrive' },
        powershell: { pwsh: facts('D:\\Docs\\PowerShell'), powershell: facts('D:\\Docs\\WindowsPowerShell') },
      }),
    );
    expect(plan(plans, 'pwsh').sweep).toEqual([
      'D:\\Docs\\PowerShell\\profile.ps1',
      'D:\\Docs\\PowerShell\\Microsoft.PowerShell_profile.ps1',
      `${docs}\\PowerShell\\profile.ps1`,
      `${docs}\\PowerShell\\Microsoft.PowerShell_profile.ps1`,
      'C:\\Users\\me\\Documents\\PowerShell\\profile.ps1',
      'C:\\Users\\me\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1',
    ]);
  });

  it('is blocked where the execution policy runs no scripts, and says the command that changes it', () => {
    const plans = planShells(
      windows({ powershell: { powershell: facts(`${docs}\\WindowsPowerShell`, 'Restricted'), pwsh: facts(`${docs}\\PowerShell`, 'AllSigned') } }),
    );
    expect(plan(plans, 'powershell').blocked).toEqual({
      detail: expect.stringContaining('Restricted'),
      fix: 'powershell -NoProfile -Command Set-ExecutionPolicy -Scope CurrentUser RemoteSigned',
    });
    expect(plan(plans, 'pwsh').blocked?.fix).toBe(
      'pwsh -NoProfile -Command Set-ExecutionPolicy -Scope CurrentUser RemoteSigned',
    );
    expect(plan(plans, 'powershell').blocked?.detail).toContain('ccx');
  });

  it('gives no command to run when Group Policy sets it, because only an administrator can change it', () => {
    const plans = planShells(
      windows({ powershell: { powershell: facts(`${docs}\\WindowsPowerShell`, 'Restricted', true), pwsh: null } }),
    );
    const blocked = plan(plans, 'powershell').blocked;
    expect(blocked?.fix).toBeUndefined();
    expect(blocked?.detail).toContain('Group Policy');
  });

  it('is not blocked by a policy that runs local scripts', () => {
    for (const policy of ['RemoteSigned', 'Unrestricted', 'Bypass']) {
      const plans = planShells(windows({ powershell: { powershell: facts(`${docs}\\WindowsPowerShell`, policy) } }));
      expect(plan(plans, 'powershell').blocked).toBeUndefined();
    }
  });
});

describe('Git Bash on Windows', () => {
  it('is absent when Git Bash is not installed', () => {
    expect(plan(planShells(windows()), 'bash').state).toBe('absent');
  });

  it('is covered like bash elsewhere, in the home Git Bash uses', () => {
    const bash = plan(
      planShells(
        windows({ gitBash: true }, { 'C:\\Users\\me\\.bash_profile': 'test -f ~/.bashrc && . ~/.bashrc\n' }),
      ),
      'bash',
    );
    expect(bash.label).toBe('Git Bash');
    expect(bash.state).toBe('use');
    expect(bash.files).toEqual(['C:\\Users\\me\\.bashrc']);
    expect(bash.retired).toEqual(['C:\\Users\\me\\.bash_profile']);
  });

  it('is left alone when installed but never used', () => {
    expect(plan(planShells(windows({ gitBash: true })), 'bash').state).toBe('unused');
    expect(
      plan(planShells(windows({ gitBash: true }, { 'C:\\Users\\me\\.bash_history': '' })), 'bash').state,
    ).toBe('use');
  });

  it('uses HOME when it is set to a Windows folder, as Git Bash does', () => {
    const bash = plan(
      planShells(windows({ gitBash: true, env: { USERPROFILE: 'C:\\Users\\me', HOME: 'H:\\' } }, { 'H:\\.bashrc': '' })),
      'bash',
    );
    expect(bash.files[0]).toBe('H:\\.bashrc');
    // A POSIX-style HOME is Git Bash's own view of it, not a Windows path.
    const posixHome = plan(
      planShells(windows({ gitBash: true, env: { USERPROFILE: 'C:\\Users\\me', HOME: '/c/Users/me' } })),
      'bash',
    );
    expect(posixHome.files[0]).toBe('C:\\Users\\me\\.bashrc');
  });

  it('is found where Git installs it, or beside the git on PATH', () => {
    const fs = memFs({ 'C:\\Program Files\\Git\\bin\\bash.exe': '' });
    expect(findGitBash({ ProgramFiles: 'C:\\Program Files' }, fs)).toBe(true);
    const scoop = memFs({
      'C:\\Users\\me\\scoop\\apps\\git\\current\\cmd\\git.exe': '',
      'C:\\Users\\me\\scoop\\apps\\git\\current\\bin\\bash.exe': '',
    });
    expect(findGitBash({ Path: 'C:\\Windows;C:\\Users\\me\\scoop\\apps\\git\\current\\cmd' }, scoop)).toBe(true);
    expect(findGitBash({ ProgramFiles: 'C:\\Program Files' }, memFs({}))).toBe(false);
  });
});

describe('readMachine: an injected environment is the whole world', () => {
  it('never asks the real PowerShell when it was given an environment or a platform', () => {
    // This rule caused real damage once: `ccx off` pointed at a temporary home
    // still asked PowerShell for its profile, got the developer's own back,
    // and removed the shim from it.
    const asked: string[] = [];
    const queryPowerShell = (exe: string) => {
      asked.push(exe);
      return null;
    };
    readMachine({ env: { USERPROFILE: 'C:\\tmp\\sandbox' } }, { hostPlatform: 'win32', queryPowerShell });
    readMachine({ platform: 'win32' }, { hostPlatform: 'win32', queryPowerShell });
    expect(asked).toEqual([]);

    // With nothing injected it is real CLI use, and both editions are asked.
    const real = readMachine({}, { hostPlatform: 'win32', queryPowerShell, findGitBash: () => false });
    expect(asked.sort()).toEqual(['powershell', 'pwsh']);
    expect(real.powershell).toEqual({ powershell: null, pwsh: null });
  });

  it('never asks PowerShell anywhere but Windows', () => {
    let asked = 0;
    readMachine({}, {
      hostPlatform: 'linux',
      queryPowerShell: () => {
        asked += 1;
        return null;
      },
    });
    expect(asked).toBe(0);
  });

  it('looks for Git Bash only through the environment it was given', () => {
    const m = readMachine(
      { platform: 'win32', env: { USERPROFILE: 'C:\\tmp\\sandbox' } },
      { fs: memFs({ 'C:\\Program Files\\Git\\bin\\bash.exe': '' }) },
    );
    // The sandbox names no Program Files, so the real one is never looked at.
    expect(m.gitBash).toBe(false);
  });
});

describe('selectShells', () => {
  const plans = planShells(mac({ '/Users/me/.zshrc': block }));

  it('takes every shell in use by default', () => {
    expect(selectShells(plans, undefined)).toEqual({ ok: true, chosen: [plan(plans, 'zsh')] });
  });

  it('sets up a named shell even when nothing shows it is used', () => {
    expect(plan(plans, 'bash').state).toBe('unused');
    expect(selectShells(plans, 'bash')).toEqual({ ok: true, chosen: [plan(plans, 'bash')] });
    // On a Mac, powershell and pwsh both mean pwsh.
    expect(selectShells(plans, 'powershell')).toEqual({ ok: true, chosen: [plan(plans, 'pwsh')] });
  });

  it('keeps posix as the shells in use among zsh and bash', () => {
    expect(selectShells(plans, 'posix')).toEqual({ ok: true, chosen: [plan(plans, 'zsh')] });
  });

  it('refuses a shell it does not know', () => {
    expect(selectShells(plans, 'fish')).toEqual({ ok: false, reason: expect.stringContaining('fish') });
  });
});

describe('shellCoverage', () => {
  it('is none, some or all of the shells ccx would set up', () => {
    expect(shellCoverage(planShells(mac()), memFs({}))).toBe('none');

    const zshOnly = { '/Users/me/.zshrc': block, '/Users/me/.bash_history': '' };
    expect(shellCoverage(planShells(mac(zshOnly)), memFs(zshOnly))).toBe('some');

    const both = { ...zshOnly, '/Users/me/.bashrc': block, '/Users/me/.profile': block };
    expect(shellCoverage(planShells(mac(both)), memFs(both))).toBe('all');
  });

  it('does not hold a shell its execution policy blocks against the rest', () => {
    const files = { 'C:\\Users\\me\\Documents\\PowerShell\\profile.ps1': shimBlock('powershell') };
    const plans = planShells(
      windows(
        {
          powershell: {
            powershell: facts('C:\\Users\\me\\Documents\\WindowsPowerShell', 'Restricted'),
            pwsh: facts('C:\\Users\\me\\Documents\\PowerShell'),
          },
        },
        files,
      ),
    );
    expect(shellCoverage(plans, memFs(files))).toBe('all');
  });
});
