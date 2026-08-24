import { Writable } from "node:stream";

import {
  intro as clackIntro,
  outro as clackOutro,
  spinner as clackSpinner,
  type SpinnerResult,
} from "@clack/prompts";

import {
  isInteractiveOutput,
  isInteractiveWritable,
  writeLine,
  type WritableStream,
} from "./output";

/**
 * Step reporting for the long-running commands. `write` narrates the step in
 * flight, `warn` records something the user must still see afterwards, and
 * `stop` finalises the display.
 *
 * `stop` MUST be reached on every exit path (use try/finally): the interactive
 * renderer hides the terminal cursor while a step is in flight, and leaves the
 * step tree unclosed. Its optional message becomes the closing line.
 */
export type Progress = {
  /**
   * Closes the run as failed: the step in flight is marked with the error
   * symbol instead of the success one. Idempotent with `stop`, so the usual
   * catch-then-finally pair reports the failure once.
   */
  fail: (message?: string) => void;
  /**
   * Settles the step in flight into a completed line without closing the run.
   * Required before anything else draws on the same stream — a confirm prompt
   * over an animating spinner corrupts both — and a later `write` resumes the
   * same tree.
   */
  settle: () => void;
  stop: (message?: string) => void;
  warn: (message: string) => void;
  write: (message: string) => void;
};

export type ProgressOptions = {
  /** Prefixes the plain-line renderer so CI logs stay greppable. */
  label: string;
  stderr?: WritableStream;
};

export function createProgress({ label, stderr }: ProgressOptions): Progress {
  if (stderr === undefined) {
    return NO_OP_PROGRESS;
  }

  // Warnings are never gated on interactivity: they matter most in CI logs.
  const warnLine = (message: string) =>
    writeLine(stderr, `${label}: warning: ${message}`);

  if (!isInteractiveOutput(stderr)) {
    // Non-interactive keeps the historical contract: steps are noise in a log
    // that already ends with the machine-readable result, warnings are not.
    return {
      fail: () => {},
      settle: () => {},
      stop: () => {},
      warn: warnLine,
      write: () => {},
    };
  }

  if (!isInteractiveWritable(stderr)) {
    // An injected, interactive-but-not-a-real-stream writer (tests, embedders)
    // cannot drive a spinner, so each step is emitted as its own line.
    return {
      // Neither fallback draws a tree, so there is nothing to close or to
      // re-mark; the failure itself is reported by the caller's error output.
      fail: () => {},
      settle: () => {},
      stop: () => {},
      warn: warnLine,
      write: (message) => writeLine(stderr, `${label}: ${message}`),
    };
  }

  return createSpinnerProgress(stderr, label, warnLine);
}

function createSpinnerProgress(
  stderr: Writable & WritableStream,
  label: string,
  warnLine: (message: string) => void,
): Progress {
  let active: SpinnerResult | null = null;
  let activeMessage: string | null = null;
  let opened = false;

  /**
   * Settles the step in flight into a permanent line. clack's `stop` defaults
   * its argument to the empty string rather than reusing the running message,
   * so the label is always passed explicitly — otherwise the step would land in
   * the scrollback blank.
   */
  const settle = (outcome: "done" | "failed" = "done") => {
    if (active === null) {
      return;
    }

    const finished = active;
    const label = activeMessage ?? "";
    // Cleared before stop() so a re-entrant call cannot settle it twice.
    active = null;
    activeMessage = null;

    if (outcome === "failed") {
      finished.error(label);
      return;
    }

    finished.stop(label);
  };

  const close = (message?: string) => {
    // Nothing was ever reported, so there is no tree to close: a command that
    // finishes without a single step must not leave a stray bracket behind.
    // Also makes the catch-then-finally pair idempotent.
    if (!opened) {
      return;
    }

    opened = false;
    clackOutro(message ?? "", { output: stderr });
  };

  return {
    fail(message) {
      settle("failed");
      close(message);
    },
    settle() {
      settle();
    },
    stop(message) {
      settle();
      close(message);
    },
    warn(message) {
      // Interleaving a raw write with an animating spinner corrupts the line,
      // so the step in flight is settled first.
      settle();
      warnLine(message);
    },
    write(message) {
      // Opened on the first step rather than at construction, so the bracket
      // only appears for runs that actually report progress.
      if (!opened) {
        opened = true;
        clackIntro(label, { output: stderr });
      }

      // Each step gets its own spinner: the previous one settles into a
      // completed line so the run keeps a readable history, and only the step
      // actually in flight animates.
      settle();
      activeMessage = message;
      active = clackSpinner({ indicator: "timer", output: stderr });
      active.start(message);
    },
  };
}

const NO_OP_PROGRESS: Progress = {
  fail: () => {},
  settle: () => {},
  stop: () => {},
  warn: () => {},
  write: () => {},
};
