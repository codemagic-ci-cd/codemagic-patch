// Reading raw argv, for the few decisions that must be made before the parser
// runs — which defaults to load, whether a flag is missing, what the user
// already told us. Both forms the parser accepts are handled here, so a
// pre-parse decision can never disagree with the parse itself.

export function hasOption(argv: string[], option: string): boolean {
  return argv.some((arg) => arg === option || arg.startsWith(`${option}=`));
}

/**
 * A boolean flag's presence, honouring the `--flag=false` form the parser
 * accepts (see the boolean branch of `parseFlags`).
 *
 * `hasOption` answers "was this spelled at all", which is the wrong question for
 * a boolean gate: `--yes=false` and `--non-interactive=false` parse to `false`,
 * so treating them as present would make a pre-parse gate disagree with the
 * command it is gating. Any other value is a parse error, so it is left to the
 * parser to report rather than being second-guessed here.
 */
export function hasBooleanOption(argv: string[], option: string): boolean {
  return argv.some(
    (arg) =>
      arg === option ||
      (arg.startsWith(`${option}=`) && arg !== `${option}=false`),
  );
}

/**
 * The value the parser will resolve for this option. The parser walks argv in
 * order and lets each occurrence overwrite the previous one, so the LAST
 * occurrence wins regardless of its spelling — this reader must scan the same
 * way, or `--opt=a --opt b` would make a pre-parse decision about `a` while
 * the command executes against `b`.
 */
export function readOptionValue(
  argv: string[],
  option: string,
): string | undefined {
  const equalsPrefix = `${option}=`;

  for (let index = argv.length - 1; index >= 0; index -= 1) {
    const arg = argv[index];

    if (arg.startsWith(equalsPrefix)) {
      return arg.slice(equalsPrefix.length);
    }

    if (arg === option) {
      const value = argv[index + 1];
      // A following `--…` is the next flag, not a value; the parser reports
      // that as an error, so there is no value to read here either.
      return value !== undefined && !value.startsWith("--") ? value : undefined;
    }
  }

  return undefined;
}

/**
 * The same argv without any occurrence of `option` (either value form).
 * Used to replay a command after an interactive sign-in: an explicit token the
 * server just refused must come off, or it keeps outranking the credential the
 * user just obtained.
 */
export function withoutOption(
  argv: readonly string[],
  option: string,
): string[] {
  const kept: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === option) {
      const value = argv[index + 1];
      // Mirrors readOptionValue: a following `--…` is the next flag, not a value.
      if (value !== undefined && !value.startsWith("--")) {
        index += 1;
      }
      continue;
    }

    if (arg.startsWith(`${option}=`)) {
      continue;
    }

    kept.push(arg);
  }

  return kept;
}

/**
 * Renders one argument so it survives a shell verbatim.
 *
 * Anything the CLI prints as a command is meant to be copied and pasted, which
 * means the shell will read it. Values reaching these lines include names the
 * server supplied, so quoting only when a value contains a space leaves `$(…)`,
 * backticks, `;` and redirects live. Single quotes disable all of it; an
 * embedded single quote is closed, escaped, and reopened.
 */
export function quoteForShell(value: string): string {
  if (value.length === 0) {
    return "''";
  }

  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** A full command line, every argument quoted. */
export function renderCommand(args: readonly string[]): string {
  return args.map(quoteForShell).join(" ");
}

const REDACTED_VALUE = "<redacted>";

/**
 * The same command line with credential values blanked. Anything the CLI
 * echoes back — the `Using:` replay line above all — lands in terminal
 * captures and retained CI logs, so a secret the user typed must never be
 * repeated there. Handles both value forms the parser accepts.
 */
export function redactSecretFlags(args: readonly string[]): string[] {
  const redacted: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--token") {
      redacted.push(arg);
      const value = args[index + 1];
      // Mirrors readOptionValue: a following `--…` is the next flag, not a value.
      if (value !== undefined && !value.startsWith("--")) {
        redacted.push(REDACTED_VALUE);
        index += 1;
      }
      continue;
    }

    if (arg.startsWith("--token=")) {
      redacted.push(`--token=${REDACTED_VALUE}`);
      continue;
    }

    redacted.push(arg);
  }

  return redacted;
}
