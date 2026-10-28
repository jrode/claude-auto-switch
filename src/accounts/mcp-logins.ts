/**
 * The sign-ins to a person's own MCP servers (`claude mcp login`), which
 * Claude keeps in the login text beside the Claude account's, under `mcpOAuth`.
 *
 * Such a sign-in has a refresh token that works once, so two stores holding
 * one sign-in cancel each other at the first refresh. Each is held by one
 * store, the one a Claude runs on: ccx never copies a live store's into another,
 * a store that ends hands its own to the account's saved login, and a store that
 * starts takes what was handed over.
 */

export const MCP_OAUTH_KEY = 'mcpOAuth';

/**
 * What installing one login over another does with `mcpOAuth`:
 * - keep-target: the target keeps its own and gets none of the source's. For an
 *   account's saved login written from a store that lives on.
 * - folder: keep-target for a folder a Claude runs on, except that a folder
 *   holding no login at all is new, and gets the source whole.
 * - park: the source's MCP logins replace the target's, because its store is
 *   ending. A source that holds none leaves the target's, since another store
 *   may have parked some there meanwhile.
 */
export type McpMode = 'keep-target' | 'folder' | 'park';

function asObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Whether a store holds no login text at all: nothing there, or the `{}` that is put where a Claude is to read again. */
export function holdsNoLogin(text: string | null): boolean {
  if (text === null || text.trim() === '') return true;
  const held = asObject(text);
  return held !== null && Object.keys(held).length === 0;
}

/** Whether a text holds MCP logins: an `mcpOAuth` entry, even an empty one. */
export function holdsMcpLogins(text: string): boolean {
  const held = asObject(text);
  return held !== null && Object.hasOwn(held, MCP_OAUTH_KEY);
}

/** Whether two texts hold the same MCP logins, or none. False when either is not a JSON object. */
export function sameMcpLogins(a: string, b: string): boolean {
  const first = asObject(a);
  const second = asObject(b);
  if (first === null || second === null) return false;
  return JSON.stringify(first[MCP_OAUTH_KEY]) === JSON.stringify(second[MCP_OAUTH_KEY]);
}

/**
 * The text to write when `source` is installed over `target`, what the store
 * holds now (null when it holds nothing). Everything of the source but
 * `mcpOAuth` is kept as it is. When neither text holds `mcpOAuth`, or one is
 * not a JSON object, the result is `source` itself.
 */
export function mergeMcpLogins(
  source: string,
  target: string | null,
  mode: McpMode = 'keep-target',
): string {
  if (mode === 'folder' && holdsNoLogin(target)) return source;
  const incoming = asObject(source);
  if (incoming === null) return source;
  if (mode === 'park' && Object.hasOwn(incoming, MCP_OAUTH_KEY)) return source;
  let own: unknown;
  if (target !== null) {
    const held = asObject(target);
    if (held === null) return source;
    own = held[MCP_OAUTH_KEY];
  }
  if (own === undefined && !Object.hasOwn(incoming, MCP_OAUTH_KEY)) return source;
  const merged = { ...incoming };
  if (own === undefined) delete merged[MCP_OAUTH_KEY];
  else merged[MCP_OAUTH_KEY] = own;
  return JSON.stringify(merged);
}

/**
 * `copy`, an account's saved login, with the MCP logins of `ending`, the text of
 * a store that is going, and its Claude login as it is. `copy` itself when
 * `ending` holds none, or already agrees, or either is not a JSON object.
 */
export function parkMcpLogins(copy: string, ending: string): string {
  const leaving = asObject(ending);
  const saved = asObject(copy);
  if (leaving === null || saved === null || !Object.hasOwn(leaving, MCP_OAUTH_KEY)) return copy;
  const parked = leaving[MCP_OAUTH_KEY];
  if (JSON.stringify(saved[MCP_OAUTH_KEY]) === JSON.stringify(parked)) return copy;
  return JSON.stringify({ ...saved, [MCP_OAUTH_KEY]: parked });
}
