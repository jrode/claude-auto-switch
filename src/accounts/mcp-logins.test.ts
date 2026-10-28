import { describe, expect, it } from 'vitest';
import {
  holdsMcpLogins,
  holdsNoLogin,
  mergeMcpLogins,
  parkMcpLogins,
  sameMcpLogins,
} from './mcp-logins.js';

const claude = (n: number) => ({
  accessToken: `a-${n}`,
  refreshToken: `r-${n}`,
  expiresAt: 1_800_000_000_000 + n,
});
const mcp = (n: number) => ({
  'notion|1': { accessToken: `mcp-access-fake-${n}`, refreshToken: `mcp-refresh-fake-${n}` },
});
const text = (value: unknown): string => JSON.stringify(value);
const parse = (value: string): Record<string, unknown> =>
  JSON.parse(value) as Record<string, unknown>;

describe('the text written when one login is installed over another', () => {
  const source = text({ claudeAiOauth: claude(2), mcpOAuth: mcp(2) });
  const target = text({ claudeAiOauth: claude(1), mcpOAuth: mcp(1) });

  it('keeps the target its own MCP logins, and the source its Claude login, by default', () => {
    const merged = parse(mergeMcpLogins(source, target));
    expect(merged.claudeAiOauth).toEqual(claude(2));
    expect(merged.mcpOAuth).toEqual(mcp(1));
  });

  it('gives the source no MCP logins when the target has none', () => {
    const merged = parse(mergeMcpLogins(source, text({ claudeAiOauth: claude(1) })));
    expect(merged).toEqual({ claudeAiOauth: claude(2) });
  });

  it('gives a target with no text no MCP logins either, as an account with no login has none', () => {
    expect(parse(mergeMcpLogins(source, null))).toEqual({ claudeAiOauth: claude(2) });
  });

  it('adds the target its MCP logins to a source that has none', () => {
    const merged = parse(mergeMcpLogins(text({ claudeAiOauth: claude(2) }), target));
    expect(merged).toEqual({ claudeAiOauth: claude(2), mcpOAuth: mcp(1) });
  });

  it('keeps every other key of the source as it is, and MCP logins where the source had them', () => {
    const rich = text({
      organizationUuid: 'org',
      claudeAiOauth: claude(2),
      mcpOAuth: mcp(2),
      future: { a: [1, 2] },
    });
    const merged = mergeMcpLogins(rich, target);
    expect(Object.keys(parse(merged))).toEqual([
      'organizationUuid',
      'claudeAiOauth',
      'mcpOAuth',
      'future',
    ]);
    expect(parse(merged)).toEqual({
      organizationUuid: 'org',
      claudeAiOauth: claude(2),
      mcpOAuth: mcp(1),
      future: { a: [1, 2] },
    });
  });

  it('is the source itself, byte for byte, when neither side holds MCP logins', () => {
    const pretty = `${JSON.stringify({ claudeAiOauth: claude(2), other: 1 }, null, 2)}\n`;
    const plain = text({ claudeAiOauth: claude(1) });
    expect(mergeMcpLogins(pretty, plain)).toBe(pretty);
    expect(mergeMcpLogins(pretty, null)).toBe(pretty);
    expect(mergeMcpLogins(pretty, plain, 'folder')).toBe(pretty);
  });

  it.each([
    ['a source that is not JSON', '{"claudeAiOauth":', target],
    ['a target that is not JSON', source, '{"claudeAiOauth":'],
    ['a source that is not an object', '[1,2]', target],
    ['a target that is not an object', source, 'null'],
    ['a target that is blank', source, '  '],
  ])('is the source as it is, and throws nothing, for %s', (_what, from, over) => {
    expect(mergeMcpLogins(from, over)).toBe(from);
    expect(mergeMcpLogins(from, over, 'folder')).toBe(from);
  });

  describe('from a store that is ending (park)', () => {
    it('is the source whole when it holds MCP logins, though the target holds some', () => {
      expect(mergeMcpLogins(source, target, 'park')).toBe(source);
      expect(mergeMcpLogins(source, null, 'park')).toBe(source);
    });

    it('is the source whole when it holds an empty set, which is the person having signed out of every one', () => {
      const emptied = text({ claudeAiOauth: claude(2), mcpOAuth: {} });
      expect(mergeMcpLogins(emptied, target, 'park')).toBe(emptied);
    });

    it('leaves the target its MCP logins when the source holds none, since another store may have parked them', () => {
      const none = text({ claudeAiOauth: claude(2) });
      expect(parse(mergeMcpLogins(none, target, 'park'))).toEqual({
        claudeAiOauth: claude(2),
        mcpOAuth: mcp(1),
      });
    });

    it('is the source as it is when neither holds any', () => {
      const none = `${JSON.stringify({ claudeAiOauth: claude(2) }, null, 2)}\n`;
      expect(mergeMcpLogins(none, text({ claudeAiOauth: claude(1) }), 'park')).toBe(none);
    });
  });

  describe('into a folder a Claude runs on', () => {
    it.each([null, '', '  \n', '{}', ' { } '])(
      'starts a folder holding %j from the source whole',
      (held) => {
        expect(mergeMcpLogins(source, held, 'folder')).toBe(source);
      },
    );

    it('keeps a folder its own MCP logins once it holds a login', () => {
      expect(parse(mergeMcpLogins(source, target, 'folder')).mcpOAuth).toEqual(mcp(1));
    });

    it('keeps its MCP logins in a folder whose Claude signed out, though it holds no login', () => {
      const signedOut = text({
        claudeAiOauth: { accessToken: '', refreshToken: '' },
        mcpOAuth: mcp(1),
      });
      expect(parse(mergeMcpLogins(source, signedOut, 'folder')).mcpOAuth).toEqual(mcp(1));
      const onlyMcp = text({ mcpOAuth: mcp(1) });
      expect(parse(mergeMcpLogins(source, onlyMcp, 'folder')).mcpOAuth).toEqual(mcp(1));
    });

    it('writes the source as it is over a folder whose text is not JSON', () => {
      expect(mergeMcpLogins(source, '{"claudeAiOauth":', 'folder')).toBe(source);
    });
  });
});

describe('whether a store holds no login at all', () => {
  it.each([null, '', ' ', '\n', '{}', ' {\n} '])('is true for %j', (held) => {
    expect(holdsNoLogin(held)).toBe(true);
  });

  it.each([
    text({ claudeAiOauth: claude(1) }),
    text({ mcpOAuth: mcp(1) }),
    text({ claudeAiOauth: { accessToken: '' } }),
    '{"claudeAiOauth":',
    '[]',
  ])('is false for %j', (held) => {
    expect(holdsNoLogin(held)).toBe(false);
  });
});

describe("an ending store's MCP logins, parked in an account's saved login", () => {
  const saved = text({ claudeAiOauth: claude(5), mcpOAuth: mcp(1) });

  it('replaces the saved MCP logins and keeps the saved Claude login as it is', () => {
    const parked = parse(
      parkMcpLogins(saved, text({ claudeAiOauth: claude(3), mcpOAuth: mcp(2) })),
    );
    expect(parked.claudeAiOauth).toEqual(claude(5));
    expect(parked.mcpOAuth).toEqual(mcp(2));
  });

  it('adds them to a saved login that has none', () => {
    const parked = parse(
      parkMcpLogins(text({ claudeAiOauth: claude(5) }), text({ mcpOAuth: mcp(2) })),
    );
    expect(parked).toEqual({ claudeAiOauth: claude(5), mcpOAuth: mcp(2) });
  });

  it('leaves the saved login alone, as the same string, when the store holds none', () => {
    expect(parkMcpLogins(saved, text({ claudeAiOauth: claude(3) }))).toBe(saved);
  });

  it('leaves the saved login alone, as the same string, when it holds the same ones already', () => {
    const pretty = `${JSON.stringify({ claudeAiOauth: claude(5), mcpOAuth: mcp(2) }, null, 2)}\n`;
    expect(parkMcpLogins(pretty, text({ mcpOAuth: mcp(2) }))).toBe(pretty);
  });

  it.each([
    ['a saved login that is not JSON', '{"claudeAiOauth":', text({ mcpOAuth: mcp(2) })],
    ["an ending store's text that is not JSON", saved, '{"mcpOAuth":'],
  ])('leaves the saved login alone for %s', (_what, copy, ending) => {
    expect(parkMcpLogins(copy, ending)).toBe(copy);
  });
});

describe('whether a text holds MCP logins', () => {
  it('does when it has an mcpOAuth entry, even an empty one', () => {
    expect(holdsMcpLogins(text({ claudeAiOauth: claude(1), mcpOAuth: mcp(1) }))).toBe(true);
    expect(holdsMcpLogins(text({ mcpOAuth: {} }))).toBe(true);
  });

  it.each([text({ claudeAiOauth: claude(1) }), '{}', '{"mcpOAuth":', '[]', ''])(
    'does not for %j',
    (held) => {
      expect(holdsMcpLogins(held)).toBe(false);
    },
  );

  it('is the same in two texts that hold the same, or none', () => {
    expect(
      sameMcpLogins(
        text({ claudeAiOauth: claude(1), mcpOAuth: mcp(1) }),
        text({ mcpOAuth: mcp(1) }),
      ),
    ).toBe(true);
    expect(
      sameMcpLogins(text({ claudeAiOauth: claude(1) }), text({ claudeAiOauth: claude(2) })),
    ).toBe(true);
    expect(sameMcpLogins(text({ mcpOAuth: mcp(1) }), text({ mcpOAuth: mcp(2) }))).toBe(false);
    expect(sameMcpLogins(text({ mcpOAuth: mcp(1) }), text({ claudeAiOauth: claude(1) }))).toBe(
      false,
    );
    expect(sameMcpLogins('{"mcpOAuth":', text({ claudeAiOauth: claude(1) }))).toBe(false);
  });
});
