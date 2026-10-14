import path from 'node:path';
import { readTarget } from '../daemon/junction.js';
import { configHome, type PathCtx } from '../config/paths.js';

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
