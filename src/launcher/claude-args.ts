/**
 * Claude's command line, read the way Claude's own parser reads it.
 *
 * Claude parses its options with commander (read from the 2.1.302 binary, the
 * same in 2.1.299). Everything after `--` is an operand. An option that takes a
 * value takes the value written inside it (`--resume=<id>`) or the argument
 * after it; one that takes a list takes every argument up to the next option.
 * Short options cluster: `-pc` is `-p -c`, up to the first that takes a value,
 * which takes the rest of the cluster as that value, so `-dp` is `--debug p`
 * and not print mode.
 *
 * One difference: an argument that starts with a dash is never read as a value
 * here, where commander gives an option that requires a value whatever follows
 * it. No model, conversation id or name ccx looks for starts with one.
 */

/**
 * Claude's short options, from the same binary: `-d, --debug [filter]`,
 * `-r, --resume [value]`, `-w, --worktree [name]` and `-n, --name <name>` take
 * a value, and `-p, --print`, `-c, --continue`, `-h, --help` and
 * `-v, --version` take none. Its one longer short option, `-d2e`
 * (`--debug-to-stderr`), is read here as `-d` with the value "2e", which is
 * neither print mode nor a conversation flag either.
 */
const SHORT_OPTIONS: ReadonlyMap<string, { long: string; takesValue: boolean }> = new Map([
  ['p', { long: '--print', takesValue: false }],
  ['c', { long: '--continue', takesValue: false }],
  ['h', { long: '--help', takesValue: false }],
  ['v', { long: '--version', takesValue: false }],
  ['d', { long: '--debug', takesValue: true }],
  ['r', { long: '--resume', takesValue: true }],
  ['w', { long: '--worktree', takesValue: true }],
  ['n', { long: '--name', takesValue: true }],
]);

/**
 * Claude's long options that take a value, as `claude --help` lists them. Those
 * shown as `<value>` or `[value]` take the next operand; those shown as
 * `<values...>` take every operand up to the next flag.
 *
 * Every other option takes nothing, so an operand after it is the prompt:
 * `--dangerously-skip-permissions "fix the flaky test"` has one. An option Claude
 * adds later that does take a value is read the same way, which errs toward "this
 * run has a prompt of its own", and an armed prompt then stands aside instead of
 * becoming a second prompt.
 */
const ONE_VALUE_FLAGS = new Set([
  '--agent',
  '--agents',
  '--append-system-prompt',
  '--append-system-prompt-file',
  '--autocompact',
  '--cloud',
  '--debug',
  '--debug-file',
  '--effort',
  '--environment',
  '--fallback-model',
  '--from-pr',
  '--input-format',
  '--json-schema',
  '--max-budget-usd',
  '--max-turns',
  '--model',
  '--name',
  '--output-format',
  '--permission-mode',
  '--permission-prompt-tool',
  '--permission-prompts',
  '--plugin-dir',
  '--plugin-url',
  '--prompt-suggestions',
  '--remote-control',
  '--remote-control-session-name-prefix',
  '--resume',
  '--session-id',
  '--setting-sources',
  '--settings',
  '--system-prompt',
  '--system-prompt-file',
  '--system-prompt-snapshot',
  '--teleport',
  '--worktree',
]);
const MANY_VALUE_FLAGS = new Set([
  '--add-dir',
  '--allowedTools',
  '--allowed-tools',
  '--betas',
  '--disallowedTools',
  '--disallowed-tools',
  '--file',
  '--mcp-config',
  '--tools',
]);

/** Anything that is a value rather than another flag. */
function isOperand(value: string | undefined): boolean {
  return typeof value === 'string' && !value.startsWith('-');
}

/**
 * A long option and the value written inside it, if any. Claude reads
 * `--resume=<id>` exactly as it reads `--resume <id>`, and Claude Desktop
 * launches it in the first form.
 */
function splitOption(arg: string): { flag: string; inline?: string } {
  if (!arg.startsWith('--')) return { flag: arg };
  const eq = arg.indexOf('=');
  return eq === -1 ? { flag: arg } : { flag: arg.slice(0, eq), inline: arg.slice(eq + 1) };
}

/** One option as Claude reads it. */
export interface ClaudeOption {
  /** As written, without its value: `--resume`, or one letter of a cluster such as `-r`. */
  name: string;
  /** The name Claude knows it by, which is the long one: `--resume` for `-r` too. */
  long: string;
  /** Its value, written inside it (`--resume=<id>`, `-r<id>`) or the operand after it. */
  value?: string;
  /** Which argument it is in. */
  at: number;
  /** Which argument its value is, when that is the one after it. */
  valueAt?: number;
}

export interface CommandLine {
  options: ClaudeOption[];
  /**
   * Every argument that is no option and no option's value, everything after
   * `--` included. Claude's prompt is one of these.
   */
  operands: string[];
  /**
   * Whether an operand added at the end would be read as one more value of the
   * last option, because that option takes every value after it.
   */
  endsInList: boolean;
}

/** Where Claude's options end: at the first `--`, or with the arguments. */
function optionsEnd(args: readonly string[]): number {
  const at = args.indexOf('--');
  return at === -1 ? args.length : at;
}

/** `args` as Claude reads them. */
export function readCommandLine(args: readonly string[]): CommandLine {
  const options: ClaudeOption[] = [];
  const operands: string[] = [];
  const end = optionsEnd(args);
  /** Whether the operands coming are the values of a list-taking option. */
  let inList = false;
  for (let i = 0; i < end; i++) {
    const arg = args[i] as string;
    if (isOperand(arg)) {
      if (!inList) operands.push(arg);
      continue;
    }
    inList = false;
    if (arg.startsWith('--')) {
      const { flag, inline } = splitOption(arg);
      if (inline !== undefined) {
        options.push({ name: flag, long: flag, value: inline, at: i });
      } else if (ONE_VALUE_FLAGS.has(flag) && isOperand(args[i + 1])) {
        const value = args[i + 1] as string;
        options.push({ name: flag, long: flag, value, at: i, valueAt: i + 1 });
        i += 1;
      } else {
        options.push({ name: flag, long: flag, at: i });
        inList = MANY_VALUE_FLAGS.has(flag);
      }
      continue;
    }
    const letters = arg.slice(1);
    for (let j = 0; j < letters.length; j++) {
      const letter = letters[j] as string;
      if (!/[A-Za-z]/.test(letter)) {
        // Not an option letter, so commander reads the rest as an option it does not know.
        const rest = `-${letters.slice(j)}`;
        options.push({ name: rest, long: rest, at: i });
        break;
      }
      const name = `-${letter}`;
      const known = SHORT_OPTIONS.get(letter);
      if (known === undefined || !known.takesValue) {
        // A letter Claude does not know is read as one that takes no value, as
        // most short options do, so the letters after it are still read.
        options.push({ name, long: known?.long ?? name, at: i });
        continue;
      }
      const attached = letters.slice(j + 1);
      if (attached !== '') {
        options.push({ name, long: known.long, value: attached, at: i });
      } else if (isOperand(args[i + 1])) {
        const value = args[i + 1] as string;
        options.push({ name, long: known.long, value, at: i, valueAt: i + 1 });
        i += 1;
      } else {
        options.push({ name, long: known.long, at: i });
      }
      break;
    }
  }
  if (end < args.length) operands.push(...args.slice(end + 1));
  return { options, operands, endsInList: inList && end === args.length };
}

/** Whether Claude runs `args` in print mode: `-p` or `--print`, alone or in a cluster such as `-pc`. */
export function isPrintMode(args: readonly string[]): boolean {
  // `--print` takes no value, so `--print=x` is not print mode to Claude.
  return readCommandLine(args).options.some(
    (o) => o.long === '--print' && o.value === undefined,
  );
}

/**
 * `args` with `added` among its options: before a `--`, after which Claude
 * reads everything as the prompt, and at the end otherwise.
 */
export function withOptions(args: readonly string[], added: readonly string[]): string[] {
  const end = optionsEnd(args);
  return [...args.slice(0, end), ...added, ...args.slice(end)];
}

/**
 * `args` without the options Claude knows by any of `longs`, each with its
 * value. A cluster loses only those letters (`-pc` without `--continue` is
 * `-p`), and nothing after `--` is touched.
 */
export function withoutOptions(args: readonly string[], longs: ReadonlySet<string>): string[] {
  const inArg = new Map<number, ClaudeOption[]>();
  const droppedValues = new Set<number>();
  for (const option of readCommandLine(args).options) {
    inArg.set(option.at, [...(inArg.get(option.at) ?? []), option]);
    if (longs.has(option.long) && option.valueAt !== undefined) droppedValues.add(option.valueAt);
  }
  const out: string[] = [];
  args.forEach((arg, i) => {
    if (droppedValues.has(i)) return;
    const here = inArg.get(i) ?? [];
    const kept = here.filter((o) => !longs.has(o.long));
    if (kept.length === here.length) out.push(arg);
    // Only a cluster holds more than one option, so what is left is written as one.
    else if (kept.length > 0) out.push(`-${kept.map(inCluster).join('')}`);
  });
  return out;
}

/** An option's letter in a cluster, and its value when that is written there too (`-dapi`). */
function inCluster(option: ClaudeOption): string {
  const attached = option.valueAt === undefined ? (option.value ?? '') : '';
  return `${option.name.slice(1)}${attached}`;
}
