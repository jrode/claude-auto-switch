#!/usr/bin/env node
// The launcher an editor points at. The extension's claudeProcessWrapper invokes it
// as `ccx-claude <nodePath> <cli.js> <...args>` and expects us to run that command.
// Conductor's claude_code_executable_path invokes it with Claude's own arguments,
// and we resolve the real claude instead. Either way Claude runs on the editor's
// own folder, kept on the active account, with inherited stdio (protocol intact),
// and a limit its chat meets moves that folder, and every chat on it, to the next
// account in place.
import { existsSync } from 'node:fs';
import { buildContext } from './context.js';
import { wrapperLaunch, editorLaunch } from './commands/editor-launch.js';

function looksLikeCommand(firstArg: string | undefined): boolean {
  if (!firstArg) return false;
  // The editor passes an absolute path to node (or a real executable) first.
  return existsSync(firstArg) || /[\\/]/.test(firstArg);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const context = buildContext({});
  process.exitCode = looksLikeCommand(argv[0])
    ? await wrapperLaunch(context, argv)
    : await editorLaunch(context, argv);
}

void main();
