import path from 'node:path';
import { getActive } from '../state/active.js';
import { getAccount, listAccounts } from '../accounts/registry.js';
import { setTarget, removeTarget, isLink, readTarget } from '../daemon/junction.js';
import { ensureEditorReady } from '../commands/editor-ready.js';
import { hasWorkingLogin } from '../accounts/account-login.js';
import { configHome, type PathCtx } from '../config/paths.js';
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

/**
 * The account the editor pointer targets, resolved from paths alone.
 *
 * A separate, lighter version of editorTargetAccount for callers that only have
 * a paths context. It exists because the editor's Claude reads an account's login
 * DIRECTLY through this pointer, so ccx is not in the loop for those sessions and
 * cannot know one is running: renewing that login can sign the editor out the
 * same way it used to sign terminal sessions out.
 *
 * Returns null when the editor integration is off, so nothing is protected
 * needlessly.
 */
export function editorPointerAccount(
  accounts: Array<{ name: string; dir: string }>,
  c: PathCtx = {},
): string | null {
  const target = readTarget(editorLinkPath(c));
  if (!target) return null;
  const resolved = path.resolve(target);
  return accounts.find((a) => path.resolve(a.dir) === resolved)?.name ?? null;
}

/** Where the editor's pointer lives, for a caller with only a paths context. */
export function editorLinkPath(c: PathCtx = {}): string {
  return path.join(configHome(c), 'editor-active');
}

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
  // Already there: left alone. Rewriting removes the link and makes it again,
  // and two sessions moving at once would meet each other's half-made one.
  const now = readTarget(editorJunctionPath(context));
  if (now !== null && path.resolve(now) === path.resolve(account.dir)) return true;
  setTarget(editorJunctionPath(context), account.dir, { platform: context.ctx.platform });
  return true;
}

/**
 * Repoint the editor pointer at the active account, but ONLY if the editor is
 * actually set up (the pointer already exists). Safe to call from any switch
 * site; it is a no-op when the editor integration is off.
 *
 * At once, whatever the account's login: one due for renewal may still be
 * renewed by a session moving onto it, since the editor's Claude renews it
 * under the same lock and reads it again there (see renewIdleLogin).
 */
export function syncEditorPointerIfEnabled(context: CliContext): void {
  // Never throws: it is called from a running session's poll, where nothing
  // would catch it, and the editor following is not worth ending a session.
  try {
    if (isLink(editorJunctionPath(context))) syncEditorJunctionToActive(context);
  } catch {
    /* the pointer stays as it was until the next switch points it */
  }
}

/** Remove the editor pointer (used by `ccx editor off`). */
export function removeEditorJunction(context: CliContext): void {
  removeTarget(editorJunctionPath(context));
}
