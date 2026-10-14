import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { shouldHintShim, shimHintText, wasHinted, markHinted, markCovered, recentlyCovered } from './shim-hint.js';

describe('shouldHintShim', () => {
  it('hints only while some shell lacks the shim, and not once it has been shown', () => {
    expect(shouldHintShim('none', false)).toBe(true);
    // An install from before ccx covered every shell has it in one of them.
    expect(shouldHintShim('some', false)).toBe(true);
    expect(shouldHintShim('all', false)).toBe(false);
    expect(shouldHintShim('none', true)).toBe(false);
    expect(shouldHintShim('some', true)).toBe(false);
  });
});

describe('shimHintText', () => {
  it('points at ccx on and says it shows once', () => {
    expect(shimHintText()).toContain('ccx on');
    expect(shimHintText()).toContain('once');
  });

  it('tells someone with ccx in only some shells to add the rest', () => {
    // An install from before ccx covered every shell: `claude` already goes
    // through ccx where they typed it, so "type claude directly" would be wrong.
    const partial = shimHintText('some');
    expect(partial).toContain('ccx on');
    expect(partial).toContain('once');
    expect(partial).toContain('other shells');
    expect(partial).not.toContain('without `ccx run`');
  });
});

describe('covered marker', () => {
  it('holds for a day, so a shell taken up later is still noticed', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-covered-'));
    const now = Date.now();
    expect(recentlyCovered(home, now)).toBe(false);
    markCovered(home);
    expect(recentlyCovered(home, now)).toBe(true);
    expect(recentlyCovered(home, now + 23 * 3_600_000)).toBe(true);
    expect(recentlyCovered(home, now + 25 * 3_600_000)).toBe(false);
    // It is not the shown marker: complete coverage never stops the tip for good.
    expect(wasHinted(home)).toBe(false);
  });
});

describe('hinted marker', () => {
  it('is false before marking and true after', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-hint-'));
    expect(wasHinted(home)).toBe(false);
    markHinted(home);
    expect(wasHinted(home)).toBe(true);
  });
});
