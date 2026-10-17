import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { acquireOwnedLock } from '../claude/locks.js';
import { configHome, type PathCtx } from '../config/paths.js';
import { appendEvent } from '../events/log.js';
import { readJsonFile, writeJsonFile } from '../util/fs-json.js';
import { LedgerSchema, type CapRecord, type Ledger } from './ledger.schema.js';

const FILENAME = 'ledger.json';

/**
 * Every change holds this lock while it reads the file, applies the change and
 * writes the result, a few milliseconds. A holder that has exited is taken over
 * at once, and a lock that names no holder after five seconds.
 */
const LOCK = { waitMs: 5_000, staleMs: 5_000 };

// -- persistence -----------------------------------------------------------

export function ledgerFilePath(c: PathCtx = {}): string {
  const platform = c.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path.posix;
  return p.join(configHome(c), FILENAME);
}

/**
 * The ledger as it is now, read without the lock: for deciding, never for
 * writing back, since a ledger changed from this copy erases whatever another
 * process recorded after it was read. Every write replaces the file in one
 * step, so a read gets the old ledger or the new one, never part of one.
 */
export function loadLedger(c: PathCtx = {}): Ledger {
  return readJsonFile(ledgerFilePath(c), LedgerSchema) ?? { caps: [] };
}

/**
 * The one way to change the ledger: read it, apply `change` and write the
 * result, as one step under the ledger's lock, so a limit another process
 * records at the same moment is never written over. `change` is handed the
 * ledger as it is now and returns the new one; returning the one it was handed
 * writes nothing. Returns the ledger as it now stands.
 *
 * A lock that is not free within `waitMs` is not waited on further: the change
 * is written without it, and the event log says so. A holder only reads and
 * writes one small file, so one still holding it after seconds is stopped, or
 * gone with its pid now another program's. Waiting longer would freeze the
 * session that asked, and dropping the change would lose a limit for certain,
 * where writing loses one only if another process writes in that same moment.
 */
export function updateLedger(
  c: PathCtx,
  change: (ledger: Ledger) => Ledger,
  options: { waitMs?: number } = {},
): Ledger {
  const file = ledgerFilePath(c);
  const waitMs = options.waitMs ?? LOCK.waitMs;
  // The lock lives beside the ledger, so a first write needs the folder first.
  mkdirSync(path.dirname(file), { recursive: true });
  const lock = acquireOwnedLock(`${file}.lock`, { ...LOCK, waitMs });
  try {
    const current = loadLedger(c);
    const next = change(current);
    if (next === current) return current;
    writeJsonFile(file, next);
    if (!lock.held) {
      appendEvent(
        configHome(c),
        `ledger written without its lock (not free within ${waitMs / 1000} s); ` +
          'a limit another session recorded at that moment may be lost',
        Date.now(),
        { kind: 'ledger-unlocked', data: { waitMs } },
      );
    }
    return next;
  } finally {
    lock.release();
  }
}

// -- pure operations (deterministic over an injected `now`) ----------------

function isActive(cap: { capUntil: number | null }, now: number): boolean {
  return cap.capUntil === null || cap.capUntil > now;
}

/**
 * Are these the same model?
 *
 * One rule, used everywhere a model name is compared here. The name arrives
 * from three places that disagree about spelling ("Fable" from the usage API,
 * "fable" from config, "claude-fable-5" from a flag), so a strict comparison in
 * one function and a case-insensitive one in another reads the same ledger two
 * different ways: caps for "Fable" and "fable" looked like two different models
 * and the last-resort path gave up rather than saying which one was out.
 */
function sameModel(one: string | undefined, other: string | undefined): boolean {
  return (one ?? '').toLowerCase() === (other ?? '').toLowerCase();
}

/**
 * Is this account unusable at time `now`?
 *
 * Only an account-wide limit makes an account unusable. A limit on ONE model
 * leaves everything else about the account working, so it must not count here:
 * treating it as unusable is what stops a session starting on a model that is
 * perfectly available.
 */
export function isCapped(ledger: Ledger, account: string, now: number): boolean {
  return ledger.caps.some((c) => c.account === account && !c.model && isActive(c, now));
}

/** The set of accounts that cannot run at all at time `now`. */
export function cappedNames(ledger: Ledger, now: number): Set<string> {
  return new Set(ledger.caps.filter((c) => !c.model && isActive(c, now)).map((c) => c.account));
}

/**
 * When the account-wide limit recorded for `account` ends, for one active at
 * `now` that has an end; undefined when there is none.
 */
export function accountCapEnd(ledger: Ledger, account: string, now: number): number | undefined {
  const cap = ledger.caps.find((c) => c.account === account && !c.model && isActive(c, now));
  return cap?.capUntil ?? undefined;
}



/**
 * Which (account, model) pairs are known spent right now, from limits recorded
 * EARLIER, including by other runs.
 *
 * Rotation plans from what it has measured plus what it has proven during the
 * run, and neither of those sees a limit an earlier run confirmed. Without
 * this, a fresh run offers a model back to the account it just ran out on, and
 * only rediscovers the limit by hitting it again.
 */
export function activeModelCaps(
  ledger: Ledger,
  now: number,
): Array<{ account: string; model: string }> {
  return ledger.caps
    .filter((c): c is typeof c & { model: string } => Boolean(c.model) && isActive(c, now))
    .map((c) => ({ account: c.account, model: c.model }));
}

export interface MarkCappedInput {
  account: string;
  now: number;
  reason?: string;
  /** Explicit reset time (epoch ms) if the signal provided one. */
  resetAt?: number | null;
  /** Fallback window when no reset time is known. */
  backoffMinutes?: number;
  /** Set when only ONE MODEL is out, rather than the whole account. */
  model?: string;
}

/**
 * Record (or replace) a cap for an account. Returns a new Ledger.
 *
 * A model-scoped write replaces only the record for THAT model, so an account
 * can hold one per model. Replacing everything for the account was fine while
 * caps were only read as "can this account run at all", and wrong the moment
 * rotation started planning from them: capping Fable and then Opus on one
 * account erased the Fable record, and the next run offered Fable back to an
 * account whose Fable window was demonstrably closed.
 *
 * An account-wide write still replaces everything for the account, which is
 * right: nothing about that account is usable, so no per-model detail survives
 * as anything but noise.
 */
export function markCapped(ledger: Ledger, input: MarkCappedInput): Ledger {
  const capUntil =
    input.resetAt !== undefined && input.resetAt !== null
      ? input.resetAt
      : input.backoffMinutes !== undefined
        ? input.now + input.backoffMinutes * 60_000
        : null;

  const record: CapRecord = {
    account: input.account,
    capUntil,
    reason: input.reason ?? 'usage cap',
    at: input.now,
    ...(input.model ? { model: input.model } : {}),
  };

  const superseded = (c: CapRecord): boolean =>
    c.account === input.account && (input.model === undefined || sameModel(c.model, input.model));

  return { caps: [...ledger.caps.filter((c) => !superseded(c)), record] };
}

/**
 * When every current limit is about ONE MODEL rather than whole accounts, this
 * describes it: the model, and the soonest it frees up.
 *
 * This is the difference between "you cannot work" and "you cannot work on this
 * model". Treating the second as the first is how a Fable limit turns into an
 * apparently unusable setup, when switching models would have carried on fine.
 */
export function modelOnlyLimit(
  ledger: Ledger,
  now: number,
): { model: string; resetsAt: number | null } | null {
  const active = ledger.caps.filter((c) => c.capUntil === null || c.capUntil > now);
  if (active.length === 0) return null;
  if (!active.every((c) => typeof c.model === 'string' && c.model.length > 0)) return null;
  const model = active[0]!.model!;
  if (!active.every((c) => sameModel(c.model, model))) return null; // mixed: not one story
  const resets = active
    .map((c) => c.capUntil)
    .filter((t): t is number => typeof t === 'number')
    .sort((a, b) => a - b);
  return { model, resetsAt: resets[0] ?? null };
}

/** Drop caps whose window has passed. Returns a new Ledger. */
export function clearExpired(ledger: Ledger, now: number): Ledger {
  return { caps: ledger.caps.filter((c) => c.capUntil === null || c.capUntil > now) };
}

/** Remove any cap for an account (e.g. after a successful run). Returns a new Ledger. */
export function clearAccount(ledger: Ledger, account: string): Ledger {
  return { caps: ledger.caps.filter((c) => c.account !== account) };
}

/**
 * Remove the caps for an account recorded at or before `upTo`, keeping any
 * recorded later. Returns the same ledger when there is none to remove, so
 * updateLedger writes nothing.
 *
 * For a run that started at `upTo` and finished fine: the account worked after
 * the older limits were recorded. A later one came from a session that saw the
 * account refuse while the run was going, which the run cannot speak to.
 */
export function clearAccountUpTo(ledger: Ledger, account: string, upTo: number): Ledger {
  const caps = ledger.caps.filter((c) => c.account !== account || c.at > upTo);
  return caps.length === ledger.caps.length ? ledger : { caps };
}

/**
 * One change a run made to the ledger, applied to the file as it stands when it
 * is written (updateLedger), never by writing back a copy read earlier.
 */
export type LedgerChange =
  | { kind: 'capped'; cap: MarkCappedInput }
  | { kind: 'cleared'; account: string; upTo: number };

export function applyLedgerChange(ledger: Ledger, change: LedgerChange): Ledger {
  return change.kind === 'capped'
    ? markCapped(ledger, change.cap)
    : clearAccountUpTo(ledger, change.account, change.upTo);
}
