// The same three error classes — and the same exit codes (see runCli.ts) — as
// cli/src/commands/shared.ts, so a script written against `cmpatch` reads this
// CLI's failures the same way.

/** A command line that cannot be run as written. Exit code 2. */
export class UsageError extends Error {
  /**
   * The command the line resolved to (`release promote`), when it did: the error
   * then points at that command's help, which lists the flags it takes, instead
   * of the root command listing, which does not (as `cmpatch` does since
   * public #37). Left unset by whoever throws — a flag reader or a command's
   * `run` need not know which command it serves — and filled in by the parser
   * and the runner, which do: `attributeUsageError`.
   */
  command: string | undefined = undefined;

  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** Claims a usage error for `command`, unless a more specific thrower already did. */
export function attributeUsageError(error: unknown, command: string): void {
  if (error instanceof UsageError && error.command === undefined) {
    error.command = command;
  }
}

/** A well-formed command line carrying a value that cannot be right. Exit code 3. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Thrown when the user answers "no" to the release confirmation. Distinct from
 * an interrupted prompt (Ctrl-C, exit code 130): a considered "no" exits 1 with
 * its own message so wrappers can tell decline from interrupt.
 */
export class DeclinedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeclinedError";
  }
}

/** Ctrl-C / closed stdin while the release confirmation was waiting. Exit code 130. */
export class PromptAbortError extends Error {
  constructor() {
    super("Aborted.");
    this.name = "PromptAbortError";
  }
}
