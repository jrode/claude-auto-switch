# Security

## What this tool stores

Claude Auto-Switch manages several Claude Code accounts on one machine. Each
account has its own config directory (its `CLAUDE_CONFIG_DIR`), which holds the
same credentials the real Claude Code stores for a single account: on Windows a
plaintext `.credentials.json`, on macOS the Keychain, on Linux a `0600` file.
The tool adds no new secret storage; it keeps N independent sets, one per
account.

## Where secrets live

- Profile folders default to `~/.claude-auto-switch/profiles/<name>/`, OUTSIDE
  this repository. The tool refuses to register or purge a profile outside this
  tree.
- The registry (`accounts.json`), the rate-limit ledger (`ledger.json`), and the
  config live under `~/.claude-auto-switch/`.
- Files the tool writes that can carry credentials or identity (the session
  credential, the session config, tokens, JSON state) are written owner-only
  (mode `0600`), and directories it creates are `0700`, where the OS supports it.
  On Windows the user-profile ACL provides the equivalent restriction.
- `.gitignore` also blocks `profiles/`, `*.credentials.json`, `accounts.json`,
  `ledger.json`, `oauth-token`, `session-debug.log`, and
  `last-setup-token-output.txt` as defense in depth.
- `ccx doctor` asks git about ccx's own folders (`~/.claude-auto-switch`, the
  profiles folder, and each account's folder) and fails when a repository, a
  dotfiles one say, tracks any file in them other than ccx's settings,
  `config.json`. It names the folder, the repository, and the files. In
  `~/.claude` and in the repository it is run from, it looks only for login
  files by name (`.credentials.json`, `.credentials.prev.json`, `oauth-token`).
  A repository whose files git cannot list (a damaged index, or a list of
  files over 64 MiB) is reported as not checked, never passed.

## How rotation handles credentials

To switch accounts mid-session, the tool copies the active account's credential
into one reused session directory and copies any refreshed credential back to
the account afterward. That session credential is removed when the session ends
and is never left lingering from one account into another's session. The tool
never sends credentials anywhere; the swap is local file movement only.

## The `CAS_DEBUG` transcript

Setting `CAS_DEBUG=1` writes the **entire raw transcript** of the session to
`~/.claude-auto-switch/session/session-debug.log` for troubleshooting. This can
contain anything shown or typed in the session. It is written owner-only, but
you should only enable it transiently and delete the file when done.

## What it never does

- It never reads or stores your password. Logins ride your browser's existing
  sessions.
- It makes no network calls of its own and sends no telemetry.

## Resolving the real `claude`

The tool executes the real `claude` binary by absolute path. On Windows it
resolves to the actual `.exe` and refuses to run a `.cmd` shim; you can pin the
path explicitly with `realClaudePath` in config. As with any tool that finds a
binary on `PATH`, keep your `PATH` free of untrusted directories.

## Usage-terms note

Rotating across multiple paid accounts to extend usage sits in a gray area of
Anthropic's usage terms. This is your machine and your accounts, so it is your
decision; the tool does not hide the question.

## Reporting

This is a personal, pre-release project. If you find a security issue, please
open a private report via GitHub Security Advisories on the repository rather
than a public issue.
