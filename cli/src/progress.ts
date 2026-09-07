import { Writable } from "node:stream";

import {
  intro as clackIntro,
  log as clackLog,
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
   * Replaces the *animating* line of the step in flight without settling it —
   * the one write that deliberately does not close the current step. Used to
   * keep a minutes-long remote build visibly alive by showing its last raw
   * output line, so the run never looks hung between two milestones. The step
   * still settles into its own `write` label, so the scrollback keeps the
   * milestone history and not a random build line. A no-op on the plain-line
   * renderers, where per-line churn would be noise in a log.
   */
  detail: (message: string) => void;
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

export type IntroMode = "at-first-step" | "at-start" | "inherited";

export type ProgressOptions = {
  /**
   * When the step tree's opening bracket is drawn. `"at-first-step"` (the
   * default) draws it with the first step, so a command that reports no
   * progress leaves no stray bracket behind. `"at-start"` draws it on
   * construction, for a command that asks questions before its first step:
   * the wizard's opening notice and its ssh questions belong inside the tree,
   * not above a bracket that appears once they are answered. `"inherited"`
   * never draws one, nor the closing bracket: the caller was handed a tree
   * another flow opened — `cmpatch init` handing off to the install wizard —
   * and its steps continue that tree, with `stop` and `fail` landing as a
   * line on it rather than closing it under the flow that owns it.
   */
  intro?: IntroMode;
  /** Prefixes the plain-line renderer so CI logs stay greppable. */
  label: string;
  stderr?: WritableStream;
  /**
   * What the opening bracket says, when it should say more than the label:
   * a command that opens its tree at the start can name the product and its
   * version there, the way `cmpatch init` does, without that header also
   * prefixing every plain step line. Defaults to the label.
   */
  title?: string;
};

/**
 * "The user asked to stop the wait in flight" — the one place that decides
 * what Ctrl+C means while a step is animating.
 *
 * A long wait that says "Ctrl+C to stop waiting" cannot get that from
 * `process.on("SIGINT")` alone. clack's spinner calls `block()` (@clack/core
 * 1.4.3), which puts stdin in raw mode and installs its own keypress handler;
 * in raw mode the tty never generates SIGINT, and that handler answers the
 * cancel keys — Ctrl+C and Escape, per `settings.aliases` — with
 * `process.exit(0)`. So in a real terminal every SIGINT hook the wizard
 * installs is dead code, and the run dies mid-wizard with a success code, no
 * summary and no sign-in.
 *
 * @clack/prompts 1.7.0 exposes no hook for that path: the spinner's `onCancel`
 * and `signal` options only cover SIGINT/SIGTERM/abort, and its `exit`
 * listener runs when the process is already leaving. The exit call itself is
 * the only seam, so while a step is animating *and* someone is listening, this
 * module lends `process.exit` a wrapper that reads clack's cancel exit as the
 * interrupt it stands for and routes it here instead of leaving.
 *
 * The wrapper is installed only for that window. With nobody registered —
 * neither a wait nor a cleanup hook (below) — nothing is intercepted and the
 * cancel key still ends the process exactly as before, which is what a step
 * with nothing to abandon and nothing to say should do.
 *
 * One press is all clack offers: its keypress handler expected to be leaving,
 * so it does not listen again afterwards, and the next step's spinner is what
 * re-arms it. A wait that is told to stop therefore has to actually stop.
 *
 * Delivery is innermost-first and to one handler only. Handlers nest — a run
 * can hold a hook for a whole phase and a second one for the wait inside it —
 * and "stop" means the thing the user is looking at, not everything that
 * happens to be listening. The phase's hook is what the next press finds, once
 * the wait it covered has let go.
 *
 * Returns the disposer; a caller that keeps it registered past its own wait
 * would abandon someone else's.
 */
export function onInterrupt(handler: () => void): () => void {
  const listener = () => {
    handler();
  };
  // Insertion-ordered, which is what makes the innermost handler findable.
  interruptHandlers.add(listener);
  syncSignalListeners();
  syncCancelIntercept();

  return () => {
    interruptHandlers.delete(listener);
    syncSignalListeners();
    syncCancelIntercept();
  };
}

/**
 * "The user asked to leave; tidy up on the way out" — the other thing an
 * interrupt can mean, for a run with nothing to abandon but something to say
 * or remove before it goes: a remote build whose log has to be closed and
 * named, a staged backup that must not be left in the server's /tmp, a
 * sign-in whose recovery command is the only thing the user has to go on.
 *
 * Node's default disposition ends the process without unwinding the async
 * stack, so a try/finally alone cannot keep a promise like these; and under an
 * animating step there is no signal at all, only clack's exit (see above).
 * Both paths arrive here, and both end the same way: every animating step is
 * settled, the hooks run innermost first — each awaited, a failure in one
 * never stopping the next — and the process exits with the conventional
 * status for the signal, 130 for SIGINT and 143 for SIGTERM.
 *
 * A wait registered with `onInterrupt` takes precedence: while one is live,
 * a press means "stop waiting" and the run continues, hooks untouched. They
 * are what the press finds once no wait is listening.
 *
 * Returns the disposer; a hook is for the duration of the thing it cleans up
 * after, and one left registered would run for an interrupt that has nothing
 * to do with it.
 */
export function onInterruptCleanup(action: () => Promise<void>): () => void {
  const hook = async () => {
    await action();
  };
  cleanupHooks.add(hook);
  syncSignalListeners();
  syncCancelIntercept();

  return () => {
    cleanupHooks.delete(hook);
    syncSignalListeners();
    syncCancelIntercept();
  };
}

const interruptHandlers = new Set<() => void>();
const cleanupHooks = new Set<() => Promise<void>>();
/**
 * The spinner-backed steps animating right now, across every Progress, each
 * as the function that settles it. Doubles as the count that arms the
 * intercept.
 */
const stepsInFlight = new Set<() => void>();
let restoreExit: (() => void) | null = null;
let sigintListener: (() => void) | null = null;
let sigtermListener: (() => void) | null = null;
/** Set while the cleanup hooks run, so a second press does not run them twice. */
let leaving = false;

function anyoneListening(): boolean {
  return interruptHandlers.size > 0 || cleanupHooks.size > 0;
}

function notifyInterrupt(signal: "SIGINT" | "SIGTERM"): void {
  // The innermost live handler, and only it: two nested hooks are one wait
  // inside one phase, and the press belongs to the wait.
  const innermost = [...interruptHandlers].pop();
  if (innermost !== undefined) {
    innermost();
    return;
  }

  leaveAfterCleanup(signal === "SIGTERM" ? 143 : 130);
}

function leaveAfterCleanup(code: number): void {
  if (leaving) {
    return;
  }

  leaving = true;
  // Settled before any hook runs, and as cancelled rather than done: a hook
  // is about to write plain lines on the same stream, and a step the run left
  // mid-way must not go into the scrollback with a success mark. Copied
  // first because settling a step removes it from the set.
  for (const settle of [...stepsInFlight]) {
    settle();
  }

  // Innermost first, the way finally blocks would have unwound. Each hook's
  // failure is its own: a log that could not be closed must not keep a staged
  // backup from being removed.
  const hooks = [...cleanupHooks].reverse();
  void (async () => {
    for (const hook of hooks) {
      try {
        await hook();
      } catch {
        // Deliberately swallowed; see above.
      }
    }
  })().finally(() => {
    // Cleared before the exit rather than after: under a test's stubbed
    // `process.exit` the call returns, and the module must be reusable then.
    leaving = false;
    process.exit(code);
  });
}

/**
 * Keeps one listener per signal for as long as anyone is registered.
 *
 * Kept beside the intercept rather than replaced by it: whenever stdin is not
 * a raw-mode tty — a pipe, a CI runner, an embedder — the signal is real and
 * arrives here. One shared listener rather than one per handler, so a signal
 * and a keypress reach the same handler. SIGTERM is only listened for on
 * behalf of the cleanup hooks: a wait has never claimed it, and a `kill` that
 * finds nothing to clean up after should still end the process the default
 * way.
 */
function syncSignalListeners(): void {
  sigintListener = syncSignalListener("SIGINT", anyoneListening(), sigintListener);
  sigtermListener = syncSignalListener(
    "SIGTERM",
    cleanupHooks.size > 0,
    sigtermListener,
  );
}

function syncSignalListener(
  signal: "SIGINT" | "SIGTERM",
  wanted: boolean,
  current: (() => void) | null,
): (() => void) | null {
  if (wanted === (current !== null)) {
    return current;
  }

  if (current !== null) {
    process.removeListener(signal, current);
    return null;
  }

  const listener = () => {
    notifyInterrupt(signal);
  };
  process.on(signal, listener);
  return listener;
}

/**
 * Installs or removes the `process.exit` wrapper so it exists for exactly the
 * window where clack could exit under a step that has somewhere else to go.
 */
function syncCancelIntercept(): void {
  const wanted = anyoneListening() && stepsInFlight.size > 0;
  if (wanted === (restoreExit !== null)) {
    return;
  }

  if (!wanted) {
    restoreExit?.();
    restoreExit = null;
    return;
  }

  const original = process.exit;
  // Only the cancel key's own exit is claimed. clack calls `process.exit(0)`
  // from its keypress handler and nothing else in the CLI exits zero from
  // under an animating step, so a code that says something went wrong is
  // still an exit.
  const intercept = ((code?: number | string | null) => {
    // Re-checked here, not only when the wrapper was installed: another owner
    // can capture this function as *its* original and keep calling it long
    // after the window closed, and swallowing those exits would strand the
    // process instead of ending it.
    const claimed =
      (code === undefined || code === 0) &&
      anyoneListening() &&
      stepsInFlight.size > 0;
    if (claimed) {
      // The cancel key is Ctrl+C, and the raw-mode tty is what kept it from
      // being the SIGINT it would otherwise have been.
      notifyInterrupt("SIGINT");
      return undefined as never;
    }

    return original.call(process, code);
  }) as typeof process.exit;

  process.exit = intercept;
  restoreExit = () => {
    // Left alone if something else has since replaced it: restoring would
    // undo that owner's wrapper instead of ours.
    if (process.exit === intercept) {
      process.exit = original;
    }
  };
}

export function createProgress({
  intro = "at-first-step",
  label,
  stderr,
  title = label,
}: ProgressOptions): Progress {
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
      detail: () => {},
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
      detail: () => {},
      // Neither fallback draws a tree, so there is nothing to close or to
      // re-mark; the failure itself is reported by the caller's error output.
      fail: () => {},
      settle: () => {},
      stop: () => {},
      warn: warnLine,
      write: (message) => writeLine(stderr, `${label}: ${message}`),
    };
  }

  return createSpinnerProgress(stderr, title, intro);
}

/**
 * Columns the spinner adds around a message: its frame and two spaces in
 * front, and the elapsed-time indicator behind — `[29m 59s]` at the longest
 * wait — with two spare for glyphs a terminal may draw double width.
 */
const SPINNER_CHROME_COLUMNS = 3 + 1 + 9 + 2;

/**
 * Trims a spinner line so the whole drawn row — frame, message, timer — fits
 * the terminal's current width. clack (1.7.0) counts the rows a line takes
 * from the bare message, not from what it draws, so a message that fits on
 * its own but wraps once decorated is erased one row short and every frame
 * leaves a copy of itself behind (bombshell-dev/clack#132). Read on each call
 * rather than once: the terminal can be resized during a long wait.
 */
export function fitSpinnerLine(
  message: string,
  columns: number | undefined,
): string {
  const room = (columns ?? 80) - SPINNER_CHROME_COLUMNS;
  const glyphs = Array.from(message);
  if (glyphs.length <= room) {
    return message;
  }

  return `${glyphs.slice(0, Math.max(room - 1, 0)).join("")}…`;
}

function createSpinnerProgress(
  stderr: Writable & WritableStream,
  title: string,
  intro: IntroMode,
): Progress {
  let active: SpinnerResult | null = null;
  let activeMessage: string | null = null;
  // An inherited tree counts as open from the start: the first step must not
  // draw a bracket under the one the owning flow already drew.
  const inherited = intro === "inherited";
  let opened = inherited;

  const open = () => {
    opened = true;
    if (!inherited) {
      clackIntro(title, { output: stderr });
    }
  };

  if (intro === "at-start") {
    open();
  }

  /**
   * Settles the step in flight into a permanent line. clack's `stop` defaults
   * its argument to the empty string rather than reusing the running message,
   * so the label is always passed explicitly — otherwise the step would land in
   * the scrollback blank.
   */
  const settle = (outcome: "cancelled" | "done" | "failed" = "done") => {
    if (active === null) {
      return;
    }

    const finished = active;
    const label = activeMessage ?? "";
    // Cleared before stop() so a re-entrant call cannot settle it twice.
    active = null;
    activeMessage = null;
    // clack's `block()` releases stdin here, so the cancel key it answered
    // with `process.exit(0)` stops being reachable.
    stepsInFlight.delete(interrupt);
    syncCancelIntercept();

    if (outcome === "failed") {
      finished.error(label);
      return;
    }

    if (outcome === "cancelled") {
      finished.cancel(label);
      return;
    }

    finished.stop(label);
  };

  const close = (
    message: string | undefined,
    outcome: "cancelled" | "done" | "failed",
  ) => {
    // Nothing was ever reported, so there is no tree to close: a command that
    // finishes without a single step must not leave a stray bracket behind.
    // Also makes the catch-then-finally pair idempotent.
    if (!opened) {
      return;
    }

    opened = false;
    if (inherited) {
      // The owning flow closes the tree; the closing line is still said, as
      // a marked line on it, so the outcome of the steps is not lost.
      if (message !== undefined && message.length > 0) {
        const say =
          outcome === "failed"
            ? clackLog.error
            : outcome === "cancelled"
              ? clackLog.warn
              : clackLog.success;
        say(message, { output: stderr });
      }
      return;
    }

    clackOutro(message ?? "", { output: stderr });
  };

  /**
   * What the interrupt path does to a step it finds animating: the step is
   * marked as cut off, and the tree closed, because the process is leaving
   * and nothing will draw on it again — `stop` has to be reached on every
   * exit path, and this is the one path no caller's finally can reach.
   */
  const interrupt = () => {
    settle("cancelled");
    close("Interrupted.", "cancelled");
  };

  return {
    detail(message) {
      // Only the step in flight has a line to repaint; a detail arriving
      // between steps has nowhere to go and is dropped rather than opening one.
      if (active === null) {
        return;
      }

      active.message(fitSpinnerLine(message, stderr.columns));
    },
    fail(message) {
      settle("failed");
      close(message, "failed");
    },
    settle() {
      settle();
    },
    stop(message) {
      settle();
      close(message, "done");
    },
    warn(message) {
      // Interleaving a raw write with an animating spinner corrupts the line,
      // so the step in flight is settled first. Then a warning line on the
      // step tree itself: the `label: warning:` prefix is for logs, and the
      // tree has its own way of marking one.
      settle();
      clackLog.warn(message, { output: stderr });
    },
    write(message) {
      // Opened on the first step unless the caller opened it at construction,
      // so the bracket only appears for runs that actually report progress.
      if (!opened) {
        open();
      }

      // Each step gets its own spinner: the previous one settles into a
      // completed line so the run keeps a readable history, and only the step
      // actually in flight animates.
      settle();
      activeMessage = fitSpinnerLine(message, stderr.columns);
      active = clackSpinner({ indicator: "timer", output: stderr });
      // Registered before the start rather than after it, so a `start` that
      // threw still has a `settle` to match. From here until it settles, clack
      // owns stdin's raw mode and answers the cancel key itself — the window
      // `onInterrupt` and `onInterruptCleanup` have to cover.
      stepsInFlight.add(interrupt);
      syncCancelIntercept();
      active.start(activeMessage);
    },
  };
}

const NO_OP_PROGRESS: Progress = {
  detail: () => {},
  fail: () => {},
  settle: () => {},
  stop: () => {},
  warn: () => {},
  write: () => {},
};
