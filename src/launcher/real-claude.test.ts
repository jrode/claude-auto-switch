import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findRealClaude, resolveRealClaude, whereItIsUsuallyInstalled, type ClaudeFs } from './real-claude.js';
import { RealClaudeError } from '../util/errors.js';
import {
  memoryWindowsFs,
  NPM_CMD_SHIM,
  NPM_PLACEHOLDER,
  WINDOWS_PROGRAM,
  type MemoryFs,
} from '../../test/memory-claude-fs.js';

// npm's global layout under nvm-windows, as on the PC this was reported from.
const PREFIX = 'C:\\nvm4w\\nodejs';
const SHIM = `${PREFIX}\\claude`;
const CMD = `${PREFIX}\\claude.cmd`;
const PKG = `${PREFIX}\\node_modules\\@anthropic-ai\\claude-code`;
const PKG_JSON = `${PKG}\\package.json`;
const PACKAGE_JSON = '{"name":"@anthropic-ai/claude-code","version":"2.1.302"}';
const BIN = `${PKG}\\bin\\claude.exe`;
const NESTED = `${PKG}\\node_modules\\@anthropic-ai\\claude-code-win32-x64\\claude.exe`;
const HOISTED = `${PREFIX}\\node_modules\\@anthropic-ai\\claude-code-win32-x64\\claude.exe`;

/** Put an environment variable back exactly as it was, absent included. */
function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('resolveRealClaude', () => {
  it('uses the configured realClaudePath when set', () => {
    const invoker = resolveRealClaude({ config: { realClaudePath: '/opt/claude' } });
    expect(invoker.bin).toBe('/opt/claude');
    expect(invoker.prefixArgs).toEqual([]);
  });

  it('picks the real binary and skips an injected shim candidate (posix)', () => {
    const invoker = resolveRealClaude({
      platform: 'linux',
      findCandidates: () => ['/usr/local/bin/claude-shim', '/usr/local/bin/claude'],
      isShim: (c) => c.includes('shim'),
    });
    expect(invoker.bin).toBe('/usr/local/bin/claude');
  });

  it('excludes our own shim via the default detector (posix)', () => {
    const invoker = resolveRealClaude({
      platform: 'linux',
      findCandidates: () => ['/x/ccx', '/x/claude'],
    });
    expect(invoker.bin).toBe('/x/claude');
  });

  it('throws when no real candidate exists', () => {
    expect(() => resolveRealClaude({ findCandidates: () => [], isShim: () => false })).toThrow(
      RealClaudeError,
    );
  });

  it('refuses a bare .cmd on Windows (node-pty cannot launch it)', () => {
    // A .cmd with no resolvable real .exe must throw, never be returned.
    expect(() =>
      resolveRealClaude({ platform: 'win32', findCandidates: () => ['C:/x/claude.cmd'] }),
    ).toThrow(RealClaudeError);
  });

  it('takes the program in the standard npm layout beside a Windows shim (node-pty needs the exe)', () => {
    const fs = memoryWindowsFs({ [CMD]: NPM_CMD_SHIM, [BIN]: WINDOWS_PROGRAM });
    const invoker = resolveRealClaude({ findCandidates: () => [SHIM, CMD], platform: 'win32', fs });
    expect(invoker.bin).toBe(BIN);
  });

  it('derives the real .exe a Windows .cmd shim points at, when it is not in the standard layout', () => {
    const elsewhere = `${PREFIX}\\tools\\claude\\claude.exe`;
    const fs = memoryWindowsFs({
      [CMD]: '"%dp0%\\tools\\claude\\claude.exe"   %*\r\n',
      [elsewhere]: WINDOWS_PROGRAM,
    });
    const invoker = resolveRealClaude({ findCandidates: () => [CMD], platform: 'win32', fs });
    expect(invoker.bin).toBe(elsewhere);
  });

  it('keeps an .exe on PATH ahead of everything else on Windows', () => {
    const native = 'C:\\Users\\me\\.local\\bin\\claude.exe';
    const fs = memoryWindowsFs({ [native]: WINDOWS_PROGRAM, [CMD]: NPM_CMD_SHIM, [BIN]: WINDOWS_PROGRAM });
    const invoker = resolveRealClaude({ findCandidates: () => [CMD, native], platform: 'win32', fs });
    expect(invoker.bin).toBe(native);
  });

  it('still takes an .exe it cannot read, since that is no sign it is not a program', () => {
    // A file Windows will not let us open (an app execution alias is one) was
    // taken before this check existed, and nothing about it says otherwise now.
    const alias = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\claude.exe';
    const fs = memoryWindowsFs({ [alias]: '' }, { unreadable: [alias] });
    expect(resolveRealClaude({ findCandidates: () => [alias], platform: 'win32', fs }).bin).toBe(alias);
  });

  it('never reads the disk when realClaudePath is set, however broken the install', () => {
    const untouchable = new Proxy({} as ClaudeFs, {
      get: () => {
        throw new Error('the configured path must win before anything is looked up');
      },
    });
    const invoker = resolveRealClaude({
      config: { realClaudePath: 'D:\\claude\\claude.exe' },
      platform: 'win32',
      findCandidates: () => [CMD],
      fs: untouchable,
    });
    expect(invoker.bin).toBe('D:\\claude\\claude.exe');
  });
});

describe('a Claude Code npm install that has lost its program (Windows)', () => {
  // Claude Code's npm package ships bin\claude.exe as a short placeholder
  // script, and its postinstall puts the real program over it from the
  // platform package. An update that runs while Claude is open can leave the
  // install with only the placeholder, or with nothing there at all, while
  // npm's claude and claude.cmd stay behind. On the owner's PC ccx then said it
  // found claude.cmd and could not launch it, and named no fix.

  const brokenMessage = (fs: MemoryFs, arch = 'x64'): string => {
    try {
      resolveRealClaude({ findCandidates: () => [SHIM, CMD], platform: 'win32', fs, arch });
    } catch (err) {
      expect(err).toBeInstanceOf(RealClaudeError);
      return (err as Error).message;
    }
    throw new Error('expected no claude to be found');
  };

  it('never picks the placeholder, and names the install and the fix', () => {
    const fs = memoryWindowsFs({ [SHIM]: '', [CMD]: NPM_CMD_SHIM, [PKG_JSON]: PACKAGE_JSON, [BIN]: NPM_PLACEHOLDER });
    const message = brokenMessage(fs);
    expect(message).toContain(PKG);
    expect(message).toContain('missing its program');
    expect(message).toContain('only the placeholder');
    expect(message).toContain('an update ran while Claude was open');
    expect(message).toContain('close every Claude window');
    expect(message).toContain('npm i -g @anthropic-ai/claude-code');
    expect(message).toContain('native build');
    expect(message).not.toContain('none of them can be launched directly');
  });

  it('names an install whose bin\\claude.exe is not there at all', () => {
    const fs = memoryWindowsFs({ [SHIM]: '', [CMD]: NPM_CMD_SHIM, [PKG_JSON]: PACKAGE_JSON });
    const message = brokenMessage(fs);
    expect(message).toContain(PKG);
    expect(message).toContain('is not there');
    expect(message).toContain('npm i -g @anthropic-ai/claude-code');
  });

  it('tells the placeholder by what it holds, not by its name or where it is', () => {
    // The npm global folder is one of the places searched without PATH, so the
    // placeholder can arrive as an .exe candidate of its own.
    const fs = memoryWindowsFs({ [PKG_JSON]: PACKAGE_JSON, [BIN]: NPM_PLACEHOLDER });
    let message = '';
    try {
      resolveRealClaude({ findCandidates: () => [BIN], platform: 'win32', fs });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(PKG);
    expect(message).toContain('only the placeholder');
  });

  it('passes over an .exe that is no program for one further down that is', () => {
    const native = 'C:\\Users\\me\\.local\\bin\\claude.exe';
    const fs = memoryWindowsFs({ [BIN]: NPM_PLACEHOLDER, [native]: WINDOWS_PROGRAM });
    expect(resolveRealClaude({ findCandidates: () => [BIN, native], platform: 'win32', fs }).bin).toBe(native);
  });

  it('falls back to the platform package nested under the install, where a global npm install puts it', () => {
    const fs = memoryWindowsFs({ [CMD]: NPM_CMD_SHIM, [PKG_JSON]: PACKAGE_JSON, [NESTED]: WINDOWS_PROGRAM });
    const search = findRealClaude({ findCandidates: () => [SHIM, CMD], platform: 'win32', fs, arch: 'x64' });
    expect(search.bin).toBe(NESTED);
    expect(search.fromPlatformPackage).toBe(true);
    expect(search.broken).toEqual([
      {
        folder: PKG,
        prefix: PREFIX,
        program: BIN,
        state: 'missing',
        platformProgram: NESTED,
        version: '2.1.302',
      },
    ]);
  });

  it('falls back to the platform package hoisted beside the install', () => {
    const fs = memoryWindowsFs({
      [CMD]: NPM_CMD_SHIM,
      [PKG_JSON]: PACKAGE_JSON,
      [BIN]: NPM_PLACEHOLDER,
      [HOISTED]: WINDOWS_PROGRAM,
    });
    const search = findRealClaude({ findCandidates: () => [SHIM, CMD], platform: 'win32', fs, arch: 'x64' });
    expect(search.bin).toBe(HOISTED);
    expect(search.broken[0]?.state).toBe('placeholder');
  });

  it('takes the platform package for this processor only', () => {
    const arm = `${PKG}\\node_modules\\@anthropic-ai\\claude-code-win32-arm64\\claude.exe`;
    const fs = memoryWindowsFs({ [CMD]: NPM_CMD_SHIM, [PKG_JSON]: PACKAGE_JSON, [NESTED]: WINDOWS_PROGRAM, [arm]: WINDOWS_PROGRAM });
    const find = (arch: string) => findRealClaude({ findCandidates: () => [CMD], platform: 'win32', fs, arch }).bin;
    expect(find('x64')).toBe(NESTED);
    expect(find('arm64')).toBe(arm);
    expect(find('ia32')).toBeNull();
  });

  it('does not fall back to a platform package file that is no program', () => {
    const fs = memoryWindowsFs({ [CMD]: NPM_CMD_SHIM, [PKG_JSON]: PACKAGE_JSON, [NESTED]: 'half a download' });
    expect(brokenMessage(fs)).toContain(PKG);
  });

  it('lists a broken install even when another Claude is picked, without picking it', () => {
    const native = 'C:\\Users\\me\\.local\\bin\\claude.exe';
    const fs = memoryWindowsFs({ [native]: WINDOWS_PROGRAM, [CMD]: NPM_CMD_SHIM, [PKG_JSON]: PACKAGE_JSON });
    const search = findRealClaude({ findCandidates: () => [native, CMD], platform: 'win32', fs });
    expect(search.bin).toBe(native);
    expect(search.fromPlatformPackage).toBe(false);
    expect(search.broken.map((b) => b.folder)).toEqual([PKG]);
  });

  it('finds nothing broken in a healthy install', () => {
    const fs = memoryWindowsFs({ [CMD]: NPM_CMD_SHIM, [PKG_JSON]: PACKAGE_JSON, [BIN]: WINDOWS_PROGRAM });
    const search = findRealClaude({ findCandidates: () => [SHIM, CMD], platform: 'win32', fs });
    expect(search.bin).toBe(BIN);
    expect(search.broken).toEqual([]);
  });

  it('keeps a version only when it is one', () => {
    const fs = memoryWindowsFs({ [CMD]: NPM_CMD_SHIM, [PKG_JSON]: '{"version":"2.1.302 --registry=http://x"}' });
    const search = findRealClaude({ findCandidates: () => [CMD], platform: 'win32', fs });
    expect(search.broken[0]?.version).toBeNull();
  });

  it('says nothing about npm when no install sits beside the shims', () => {
    const fs = memoryWindowsFs({ [CMD]: NPM_CMD_SHIM });
    const message = brokenMessage(fs);
    expect(message).toContain('none of them can be launched directly');
    expect(message).not.toContain('missing its program');
  });
});

describe('finding claude when PATH does not know about it', () => {
  // The reported failure on a fresh machine: Claude IS installed and runs in
  // the operator's own shell, but the installer put its directory on a PATH
  // this process never inherited, so `where claude` found nothing and ccx said
  // the binary did not exist.

  it('looks where Claude Code actually installs itself', () => {
    const windows = whereItIsUsuallyInstalled('win32');
    // The native installer, the local install `claude migrate-installer`
    // leaves behind, and both npm global layouts.
    expect(windows.some((p) => p.includes(path.join('.local', 'bin')))).toBe(true);
    expect(windows.some((p) => p.includes(path.join('.claude', 'local')))).toBe(true);
    expect(windows.some((p) => p.includes(path.join('npm', 'node_modules')))).toBe(true);
    expect(windows.every((p) => p.endsWith('.exe'))).toBe(true);

    const posix = whereItIsUsuallyInstalled('linux');
    expect(posix).toContain('/usr/local/bin/claude');
    expect(posix.some((p) => p.includes('homebrew'))).toBe(true);
    expect(posix.every((p) => !p.endsWith('.exe'))).toBe(true);
  });

  it('finds a REAL install through the real search when PATH knows nothing', () => {
    // Only onPath is stubbed, so the known-location search, the launchability
    // filter and the pick all run for real. Injecting findCandidates instead
    // would replace the very thing under test, leaving a test that passes
    // whether the fallback exists or not.
    const home = mkdtempSync(path.join(tmpdir(), 'cas-home-'));
    const isWindows = process.platform === 'win32';
    const binDir = path.join(home, '.local', 'bin');
    mkdirSync(binDir, { recursive: true });
    const installed = path.join(binDir, isWindows ? 'claude.exe' : 'claude');
    writeFileSync(installed, WINDOWS_PROGRAM);
    if (!isWindows) chmodSync(installed, 0o755);

    const previous = { home: process.env.HOME, profile: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const claude = resolveRealClaude({
        platform: process.platform,
        onPath: () => [], // this machine's PATH does not mention claude
      });
      expect(claude.bin).toBe(installed);
    } finally {
      // Deleted rather than assigned when there was nothing there: assigning
      // undefined stores the STRING "undefined", which is not absence, and
      // leaks into whatever runs next.
      restoreEnv('HOME', previous.home);
      restoreEnv('USERPROFILE', previous.profile);
    }
  });

  it('steps over something unlaunchable to reach the real install', () => {
    // Existing is not enough: a DIRECTORY named claude, or a file without the
    // executable bit, would otherwise be picked and hide a working install.
    const dir = mkdtempSync(path.join(tmpdir(), 'cas-unlaunchable-'));
    const decoy = path.join(dir, 'claude');
    mkdirSync(decoy); // a directory, not a program
    const real = path.join(dir, 'real-claude');
    writeFileSync(real, 'binary');
    if (process.platform !== 'win32') chmodSync(real, 0o755);

    const claude = resolveRealClaude({
      platform: process.platform === 'win32' ? 'linux' : process.platform,
      onPath: () => [decoy, real],
    });
    expect(claude.bin).toBe(real);
  });

  it('says where it looked, and how to fix it, when there is nothing to find', () => {
    // The old message named a config key and stopped, which reads as "you have
    // not installed Claude" to someone who plainly has.
    let thrown: Error | null = null;
    try {
      resolveRealClaude({ platform: 'win32', findCandidates: () => [] });
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeInstanceOf(RealClaudeError);
    expect(thrown?.message).toContain('looked on PATH, and in:');
    expect(thrown?.message).toContain('.local');
    expect(thrown?.message).toContain('realClaudePath');
    expect(thrown?.message).toContain('CAS_REAL_CLAUDE_PATH');
  });
});
