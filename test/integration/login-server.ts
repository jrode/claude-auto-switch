import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';
import { readOauthToken, type LimitProbeResult } from '../../src/usage/limit-probe.js';
import { sha256Fingerprint } from '../../src/util/fingerprint.js';

/**
 * Anthropic, as far as a login is concerned: the usage read that says whether
 * an access token is still accepted, and the token endpoint that renews a
 * login or refuses it. Nothing else is on the network while it is installed.
 *
 * Every account starts signed in. `signOut(name)` is that account being signed
 * out at claude.ai (or put on hold): from then on its token is turned away and
 * its login cannot be renewed.
 */
export interface LoginServer {
  /** Stands in for the usage read: give it to the context as `loginProbe`. */
  loginProbe: (credentialsFile: string) => Promise<LimitProbeResult>;
  signOut: (name: string) => void;
}

/** Give account `name` in `dir` a real-shaped login with hours left on it. */
export function signIn(dir: string, name: string): void {
  writeFileSync(
    path.join(dir, '.credentials.json'),
    JSON.stringify({
      account: name,
      claudeAiOauth: { accessToken: `a-${name}`, refreshToken: `r-${name}`, expiresAt: Date.now() + 8 * 3_600_000 },
    }),
    'utf8',
  );
}

/**
 * Installed until `vi.unstubAllGlobals()`. `slowMs`: how long the usage read
 * takes to turn a signed-out account's token away, for a check still under way
 * when something else happens.
 */
export function loginServer(options: { slowMs?: number } = {}): LoginServer {
  const revoked = new Set<string>();
  const refused = new Set<string>();
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.endsWith('/v1/oauth/token')) return Promise.reject(new Error(`no network in tests: ${url}`));
    const { refresh_token: refresh } = JSON.parse(String(init?.body)) as { refresh_token: string };
    const answer = refused.has(refresh)
      ? { status: 400, body: { error: 'invalid_grant', error_description: 'Refresh token not found or invalid' } }
      : { status: 200, body: { access_token: `${refresh}-renewed`, refresh_token: `${refresh}-next`, expires_in: 28_800 } };
    return Promise.resolve(
      new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } }),
    );
  });
  return {
    loginProbe: (file) => {
      const token = readOauthToken(file);
      if (!token || !revoked.has(token)) return Promise.resolve({ verdict: 'allowed', fiveHour: 0.1, sevenDay: 0.1 });
      const turnedAway: LimitProbeResult = {
        verdict: 'unknown',
        detail: 'status 401',
        rejected: { message: 'OAuth access token has been revoked.', token: sha256Fingerprint(token) },
      };
      return new Promise((resolve) => setTimeout(() => resolve(turnedAway), options.slowMs ?? 0));
    },
    signOut: (name) => {
      revoked.add(`a-${name}`);
      refused.add(`r-${name}`);
    },
  };
}
