import path from 'node:path';
import { getActive } from '../state/active.js';
import { getAccount, listAccounts } from '../accounts/registry.js';
import { setTarget, removeTarget, isLink, readTarget } from '../daemon/junction.js';
import { ensureEditorReady } from '../commands/editor-ready.js';
import { hasWorkingLogin } from '../accounts/account-login.js';
import { renewalIsDue } from '../usage/oauth-refresh.js';
import { renewIdleLogin } from '../usage/usage-store.js';
import { editorLinkPath, editorPointerAccount } from './pointer.js';
import type { CliContext } from '../context.js';

/** The account the editor pointer currently resolves to, or null. */
export function editorTargetAccount(context: CliContext): { name: string; loggedIn: boolean } | null {
  const target = readTarget(editorJunctionPath(context));
  if (!target) return null;
  const resolved = path.resolve(target);
  const account = listAccounts(context.ctx).find((a) => path.resolve(a.dir) === resolved);
  if (!account) return null;
  // Not `existsSync` on the credential file: a signed-OUT profile keeps a
  // complete one with empty tokens, which is the check this project replaced
  // everywhere else years ago and which survived here. Refused logins are
  // excluded too, so doctor does not report the editor as pointed at a
  // working account when it is pointed at a finished one.
  const loggedIn = hasWorkingLogin(account.dir, context.ctx);
  return { name: account.name, loggedIn };
}

export { editorPointerAccount, editorLinkPath };

/**
 * The editor points CLAUDE_CONFIG_DIR at this stable path, and ccx flips it to
 * whichever account is active. It is the editor's OWN pointer (distinct from the
 * daemon's "active" link) so `ccx editor off` and `ccx daemon uninstall` never
 * disturb each other.
 */
export function editorJunctionPath(context: CliContext): string {
  return editorLinkPath(context.ctx);
}

/**
 * Point the editor pointer at the active account (seeded so the editor's Claude
 * does not re-onboard). Returns false when there is no usable active account.
 */
export function syncEditorJunctionToActive(context: CliContext): boolean {
  const active = getActive(context.ctx);
  if (!active) return false;
  const account = getAccount(active, context.ctx);
  if (!account) return false;
  ensureEditorReady(account.dir, context.ctx);
  setTarget(editorJunctionPath(context), account.dir, { platform: context.ctx.platform });
  return true;
}

/**
 * Repoint the editor pointer at the active account, but ONLY if the editor is
 * actually set up (the pointer already exists). Safe to call from any switch
 * site; it is a no-op when the editor integration is off.
 *
 * When that account's login is due for renewal, it is renewed first, by the
 * rule for renewing a login nothing here is on (renewIdleLogin), while the
 * editor is still on the account it was on, and the editor is moved once the
 * renewal is over, however it went. Pointed there first, the editor may be
 * using the login, so nothing else may renew it, and a session moving onto the
 * same account would be restarted to have it renewed.
 */
export function syncEditorPointerIfEnabled(context: CliContext): void {
  if (!isLink(editorJunctionPath(context))) return;
  const active = getActive(context.ctx);
  const account = active ? getAccount(active, context.ctx) : undefined;
  if (!account || !renewalIsDue(account.dir)) {
    syncEditorJunctionToActive(context);
    return;
  }
  void renewIdleLogin(account, listAccounts(context.ctx), context.ctx)
    .catch(() => undefined)
    // To whatever is active by then, and only if the editor still follows it.
    .finally(() => {
      if (isLink(editorJunctionPath(context))) syncEditorJunctionToActive(context);
    });
}

/** Remove the editor pointer (used by `ccx editor off`). */
export function removeEditorJunction(context: CliContext): void {
  removeTarget(editorJunctionPath(context));
}
