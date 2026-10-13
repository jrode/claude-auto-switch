import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { shimBlock } from './install-shim.js';

/**
 * The shim block as each shell really runs it: loaded from a temporary file
 * by a shell told to read no startup file of its own, with only stand-ins
 * for ccx and claude on its PATH. No real profile is read or written.
 */

function folder(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** A folder holding one stand-in program that prints its name and arguments. */
function standIn(name: 'ccx' | 'claude', kind: 'sh' | 'ps1' | 'cmd'): string {
  const dir = folder(`cas-${name}-`);
  if (kind === 'sh') {
    const file = path.join(dir, name);
    writeFileSync(file, `#!/bin/sh\necho "${name} $*"\n`, 'utf8');
    chmodSync(file, 0o755);
  } else if (kind === 'ps1') {
    writeFileSync(path.join(dir, `${name}.ps1`), `Write-Output ('${name} ' + ($args -join ' '))\n`, 'utf8');
  } else {
    writeFileSync(path.join(dir, `${name}.cmd`), `@echo ${name} %*\r\n`, 'utf8');
  }
  return dir;
}

function profileWith(kind: 'posix' | 'powershell'): string {
  const file = path.join(folder('cas-shim-'), kind === 'posix' ? 'profile.sh' : 'profile.ps1');
  writeFileSync(file, `${shimBlock(kind)}\n`, 'utf8');
  return file;
}

/** Where a shell is installed, or null. Asked up front: each run's PATH holds only stand-ins. */
function located(shell: string): string | null {
  if (process.platform === 'win32') return null;
  const r = spawnSync('sh', ['-c', `command -v ${shell}`], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** Each shell, and how to start it without reading any startup file. */
const POSIX_SHELLS: Array<[string, string[]]> = [
  ['bash', ['--norc', '--noprofile', '-c']],
  ['zsh', ['-f', '-c']],
  // .profile can get the shim, and plain sh reads that file too.
  ['sh', ['-c']],
];

describe.runIf(process.platform !== 'win32')('the shim in bash, zsh and sh', () => {
  for (const [shell, args] of POSIX_SHELLS) {
    const exe = located(shell);
    const run = (bin: string) => {
      const profile = profileWith('posix');
      return spawnSync(exe as string, [...args, `. '${profile}'; claude --version`], {
        encoding: 'utf8',
        env: { HOME: path.dirname(profile), PATH: bin },
      });
    };

    it.runIf(exe !== null)(`${shell}: claude runs ccx, which gets every argument`, () => {
      const r = run(standIn('ccx', 'sh'));
      expect(r.stderr).toBe('');
      expect(r.stdout.trim()).toBe('ccx run -- --version');
    });

    it.runIf(exe !== null)(`${shell}: with no ccx on PATH, claude runs the real claude`, () => {
      const r = run(standIn('claude', 'sh'));
      expect(r.stdout.trim(), r.stderr).toBe('claude --version');
    });
  }
});

/** The environment with PATH replaced, under whatever case Windows gave its name. */
function withPath(dir: string): NodeJS.ProcessEnv {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  return { ...process.env, [key]: dir };
}

// On the Windows runner only: these start the real PowerShells, and a
// developer's own machine may have a real ccx that the fallback case would find.
const onWindowsCi = process.platform === 'win32' && Boolean(process.env.CI);

describe.runIf(onWindowsCi)('the shim in PowerShell 7 and Windows PowerShell', () => {
  for (const exe of ['pwsh', 'powershell']) {
    const run = (profile: string, bin: string, then: string) =>
      spawnSync(
        exe,
        [
          '-NoProfile',
          '-NoLogo',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `$env:PATH = '${bin}'; . '${profile}'; ${then}`,
        ],
        { encoding: 'utf8', timeout: 60_000 },
      );

    it(`${exe}: claude is the ccx function, and npm's ccx.ps1 gets the -- that ends ccx's own options`, () => {
      // npm puts a ccx.ps1 on PATH, and handing it a bare -- loses it.
      const r = run(profileWith('powershell'), standIn('ccx', 'ps1'), '(Get-Command claude).CommandType; claude --version');
      expect(r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean), r.stderr).toEqual([
        'Function',
        'ccx run -- --version',
      ]);
    }, 60_000);

    it(`${exe}: with no ccx on PATH, claude runs the real claude`, () => {
      const r = run(profileWith('powershell'), standIn('claude', 'cmd'), 'claude --version');
      expect(r.stdout.trim(), r.stderr).toBe('claude --version');
    }, 60_000);
  }
});

const gitBash = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe');

describe.runIf(onWindowsCi && existsSync(gitBash))('the shim in Git Bash', () => {
  const run = (profile: string, bin: string) =>
    spawnSync(gitBash, ['--norc', '--noprofile', '-c', `. '${profile.replace(/\\/g, '/')}'; claude --version`], {
      encoding: 'utf8',
      env: withPath(bin),
      timeout: 60_000,
    });

  it('claude runs ccx, which gets every argument', () => {
    const r = run(profileWith('posix'), standIn('ccx', 'sh'));
    expect(r.stdout.trim(), r.stderr).toBe('ccx run -- --version');
  }, 60_000);

  it('with no ccx on PATH, claude runs the real claude', () => {
    const r = run(profileWith('posix'), standIn('claude', 'sh'));
    expect(r.stdout.trim(), r.stderr).toBe('claude --version');
  }, 60_000);
});
