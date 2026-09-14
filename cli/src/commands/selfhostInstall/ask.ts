/**
 * The prompt-side helpers the wizard files share: how a notice is printed, how
 * a value is asked for (a hostname included, since three of the files ask for
 * one), how a console gate holds, how a browser offer is made, and how a
 * Ctrl+C during a wait is heard.
 */

import { openBrowser } from "../../browserOpen";
import { writeNote } from "../../notice";
import { onInterrupt } from "../../progress";
import {
  type ConfirmRequest,
  PromptAbortError,
  type SelectChoice,
} from "../../prompt";
import { describeDomainProblem } from "../../selfhostInstall";
import { renderStopRequested } from "../../selfhostSetupCopy";
import {
  paletteFor,
  writeNotice,
  type SelfhostSession,
} from "../selfhostSession";
import { type CommandDeps } from "../shared";

/**
 * One paragraph: a line, or every line of a rendered block, said together.
 *
 * Together matters. In a terminal each paragraph is spaced from the last on
 * the prompt tree's guide line, so a block handed over a line at a time would
 * come out as one paragraph per line.
 */
export function notice(
  deps: CommandDeps,
  message: string | readonly string[],
): void {
  writeNotice(deps, message);
}

/**
 * A block the user copies values out of — the DNS records, the OAuth form's
 * values, the origin header — drawn as a titled box so it stands apart from
 * the prose around it, with the same lines printed plainly under the title
 * everywhere the box cannot be drawn.
 *
 * Only short values belong in one. clack's note hard-wraps at the terminal's
 * width, which puts a real newline inside anything wider than the box, and a
 * URL or a policy line wrapped that way pastes broken. Those stay in `notice`,
 * where the terminal soft-wraps and a selection still copies the whole line.
 */
export function noteBlock(
  deps: CommandDeps,
  title: string,
  lines: readonly string[],
): void {
  if (deps.stderr !== undefined) {
    writeNote(deps.stderr, title, [...lines], { indent: "" });
  }
}

export { paletteFor };

/**
 * "The user asked to stop this."
 *
 * A plain `process.on("SIGINT")` is not enough: every wait here animates a
 * clack spinner, and clack holds stdin in raw mode while it does, so the tty
 * generates no SIGINT and clack answers the cancel key itself. `onInterrupt`
 * owns both halves, so the copy that promises "Ctrl+C to stop waiting" is true
 * in a real terminal and not only under a pipe.
 *
 * The press is answered on screen before `action` runs. Whatever is in flight
 * — a request, a sleep — still has to finish, and a press that leaves the
 * display unchanged reads as one that was missed; the terminal has no second
 * press to offer, because clack listened for the first one only.
 */
export function onSignal(session: SelfhostSession, action: () => void): () => void {
  return onInterrupt(() => {
    session.progress.detail(renderStopRequested());
    action();
  });
}

/**
 * The offer to open a just-printed URL, made only where the wizard then waits
 * for the user to come back from that page with something.
 *
 * Enter means open — the URL stays printed above either way, so declining or a
 * platform with no opener (SSH, containers) loses nothing but the shortcut.
 * `openBrowser` never throws; false is the only failure it reports.
 *
 * `lead` is said before the question: what the page is for, or what to do
 * on it, for the user who says yes and is then looking at the browser rather
 * than at whatever prints here next. `abort: "decline"` is for an offer made
 * once the command's work is done, where Ctrl+C means what "No" means (see
 * `confirmFinishStep`) rather than a failure of work that has succeeded.
 */
export async function offerBrowserOpen(
  deps: CommandDeps,
  input: {
    abort?: "decline";
    lead?: string | readonly string[];
    message: string;
    url: string;
  },
): Promise<void> {
  if (deps.confirm === undefined) {
    return;
  }

  if (input.lead !== undefined) {
    notice(deps, input.lead);
  }

  const request = { initial: true, message: input.message };
  const open =
    input.abort === "decline"
      ? await confirmFinishStep(deps, request)
      : await deps.confirm(request);
  if (!open) {
    return;
  }

  if (!(await (deps.openBrowser ?? openBrowser)(input.url))) {
    notice(deps, [
      "A browser could not be opened here. Open this URL yourself:",
      `  ${input.url}`,
    ]);
  }
}

/**
 * A console gate that takes no for an answer.
 *
 * Every step of the walkthrough leaves something behind that a later step —
 * or install.sh's own verification — needs: the issued certificate, the
 * distribution's id, the key pair. Advancing on a "no" is how each of those
 * ends up absent from a run that otherwise looks finished, so the honest
 * answer holds here and says what the next screen is waiting for. A
 * non-interactive run has nobody to hold for and passes through.
 */
export async function holdUntilConfirmed(
  deps: CommandDeps,
  input: { message: string; nudge: () => string[] },
): Promise<void> {
  for (;;) {
    const done =
      (await deps.confirm?.({ initial: true, message: input.message })) ?? true;
    if (done) {
      return;
    }

    notice(deps, input.nudge());
  }
}

export async function askChecked(
  deps: CommandDeps,
  input: {
    check: (value: string) => string | null;
    initial?: string;
    message: string;
    type: "password" | "text";
  },
): Promise<string> {
  for (;;) {
    const value = await askValue(deps, {
      ...(input.initial !== undefined ? { initial: input.initial } : {}),
      message: input.message,
      type: input.type,
    });
    const problem = input.check(value);
    if (problem === null) {
      return value;
    }

    // Named without echoing the value: some of these are secrets.
    notice(deps, problem);
  }
}

export async function askDomain(
  deps: CommandDeps,
  input: { initial?: string; message: string; purpose?: string; differentFrom?: readonly string[] },
): Promise<string> {
  if (input.purpose !== undefined) {
    notice(deps, input.purpose);
  }

  return askChecked(deps, {
    check: value => describeDomainProblem(value) ?? (
      input.differentFrom?.some(domain => domain.toLowerCase() === value.toLowerCase())
        ? "Use a different hostname for the API, downloads and origin."
        : null
    ),
    ...(input.initial !== undefined ? { initial: input.initial } : {}),
    message: input.message,
    type: "text",
  });
}

/**
 * A confirm in the finish phase, where Ctrl+C means what "No" means.
 *
 * Every question from here on is asked once the server has passed health —
 * `commitServerIdentity`'s own adopt question included — and each one already
 * has an answer for "not now": the run ends successfully and the step the user
 * did not take is carried into the closing summary. An abort is that same
 * intent — stop here — so it takes the same exit. Letting `PromptAbortError`
 * unwind instead reported "Install failed." over an install that is complete,
 * and through `cmpatch init` it also skipped the summary and the sign-in that
 * follow.
 *
 * Only this phase treats an abort that way. Everything before the commit can
 * still leave the machine unable to reach a server that is up, so an abort
 * there keeps the failure path.
 */
export async function confirmFinishStep(
  deps: CommandDeps,
  request: ConfirmRequest,
  phase?: FinishPhase,
): Promise<boolean> {
  // Already told to stop, during a step that had no question of its own to
  // decline: asking now would be asking something the user has answered, and
  // the press they made had nowhere else to land.
  if (phase?.stopped() === true) {
    return false;
  }

  try {
    return (await deps.confirm?.(request)) ?? false;
  } catch (error) {
    if (error instanceof PromptAbortError) {
      return false;
    }

    throw error;
  }
}

/**
 * The finish phase's own interrupt state, threaded to every confirm it asks.
 *
 * A press that lands between the waits — on a probe, a check, a settling line
 * — has no local wait to abandon, so it is carried here until the next
 * question, which then answers itself with "not now". That is what turns an
 * interrupt anywhere in the phase into the same complete-with-next-steps
 * ending a declined step produces.
 */
export type FinishPhase = { stopped: () => boolean };

export async function askValue(
  deps: CommandDeps,
  request: {
    initial?: string;
    message: string;
    optional?: boolean;
    type: "password" | "text";
  },
): Promise<string> {
  const answer = await deps.prompt?.(
    request.type === "password"
      ? { message: request.message, type: "password" }
      : {
          ...(request.initial !== undefined ? { initial: request.initial } : {}),
          message: request.message,
          ...(request.optional === true ? { optional: true } : {}),
          type: "text",
        },
  );
  return (typeof answer === "string" ? answer : (answer?.[0] ?? "")).trim();
}

/**
 * The select's half of the same normalization.
 *
 * Its fallback is the caller's, not a shared default: an answerless select is
 * "no choice was made", and what that means differs by question — the recovery
 * edge falls back to its own least-destructive default, the delivery select to
 * no CDN at all.
 */
export async function askSelect(
  deps: CommandDeps,
  request: {
    choices: SelectChoice[];
    fallback: string;
    initial?: number;
    message: string;
  },
): Promise<string> {
  const answer = await deps.prompt?.({
    choices: request.choices,
    ...(request.initial !== undefined ? { initial: request.initial } : {}),
    message: request.message,
    type: "select",
  });
  return typeof answer === "string" ? answer : (answer?.[0] ?? request.fallback);
}
