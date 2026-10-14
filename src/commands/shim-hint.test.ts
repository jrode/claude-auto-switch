import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { shouldHintShim, shimHintText, wasHinted, markHinted } from './shim-hint.js';

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

describe('hinted marker', () => {
  it('is false before marking and true after', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cas-hint-'));
    expect(wasHinted(home)).toBe(false);
    markHinted(home);
    expect(wasHinted(home)).toBe(true);
  });
});
