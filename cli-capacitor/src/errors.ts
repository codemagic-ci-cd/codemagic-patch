// The same three error classes — and the same exit codes (see runCli.ts) — as
// cli/src/commands/shared.ts, so a script written against `cmpatch` reads this
// CLI's failures the same way.

/** A command line that cannot be run as written. Exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
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
