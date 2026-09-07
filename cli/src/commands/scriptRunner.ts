/**
 * Running one of the repo's shell scripts through the shared presentation:
 * the milestone view on the progress renderer, the byte-for-byte log file,
 * the Ctrl+C hook, and the failure report.
 *
 * The `selfhost` maintenance commands run their script over ssh and
 * `selfhost local-eval` runs its script as a child of this process; the only
 * difference between them is how the process is launched, which is the one
 * thing taken as input here.
 */

import { writeMessage } from "../notice";
import { isInteractiveOutput, writeLine } from "../output";
import { onInterruptCleanup, type Progress } from "../progress";
import type { ProcessRunResult } from "../remoteExec";
import {
  createRemoteLog,
  createRemoteOutputRenderer,
  renderRemoteFailure,
  type RemoteLog,
  type RemoteMilestone,
} from "../remoteOutput";
import type { CommandDeps } from "./shared";

export class RemoteScriptFailure extends Error {
  /**
   * The script's own `FAIL:` line, unrendered — null when the process died
   * without producing one. `install` classifies the previous run's failure
   * from it to choose a recovery edge, which must key on the script's wording
   * rather than on the assembled report the user reads.
   */
  readonly failureMessage: string | null;

  constructor(message: string, failureMessage: string | null = null) {
    super(message);
    this.failureMessage = failureMessage;
    this.name = "RemoteScriptFailure";
  }
}

export type RenderedScriptInput = {
  /**
   * What to print when Ctrl+C lands mid-run, given the log path when a log
   * was opened. The renderer is not flushed on that path: a partial line
   * could open a new step under a tree the interrupt has just closed.
   */
  interruptNotice: (logPath: string | undefined) => readonly string[];
  /** Starts the process; every chunk of its merged output goes to `onOutput`. */
  launch: (onOutput: (chunk: string) => void) => Promise<ProcessRunResult>;
  milestones: readonly RemoteMilestone[];
  /** Names the log file (`<timestamp>-<name>.log`). */
  name: string;
  /** The script's own log prefix; `[selfhost] ` when omitted. */
  prefix?: string;
  progress: Progress;
  /** Wording for the failure report; the remote defaults when omitted. */
  wording?: { subject: string; tailHeading: string };
};

export async function runRenderedScript(
  deps: CommandDeps,
  input: RenderedScriptInput,
): Promise<void> {
  let log: RemoteLog | null = null;
  try {
    log = await createRemoteLog({
      env: deps.env,
      name: input.name,
      now: deps.now(),
    });
  } catch {
    // A log the CLI could not open must never stop the run it was only
    // recording; the streamed view still shows everything.
    log = null;
  }

  const renderer = createRemoteOutputRenderer({
    milestones: input.milestones,
    ...(log !== null ? { onRawChunk: (chunk) => log?.append(chunk) } : {}),
    ...(input.prefix !== undefined ? { prefix: input.prefix } : {}),
    progress: input.progress,
    ...(terminalWidth(deps.stderr) !== undefined
      ? { width: terminalWidth(deps.stderr) }
      : {}),
  });

  // Ctrl+C during the run. The spinner keeps the tty from ever raising a
  // SIGINT (progress.ts explains), so without this hook the press ended a
  // twenty-minute build with a success code, no word on what the script was
  // left doing, and the log's last chunk still in the stream's buffer. The
  // child is not touched: it is left to the OS, and whether the script
  // survives is not something this side can promise either way.
  let finalized = false;
  const finalize = async () => {
    if (finalized) {
      return;
    }

    finalized = true;
    await log?.close();
  };
  const removeInterruptHook = onInterruptCleanup(async () => {
    await finalize();
    if (deps.stderr === undefined) {
      return;
    }

    writeLine(deps.stderr, input.interruptNotice(log?.path).join("\n"));
  });

  // Where the full output goes, said before the long step and not only on
  // failure: a build that runs for minutes is exactly when the user wants a
  // second terminal on the raw log, and until now the path was printed only
  // once there was nothing left to watch. Interactive runs only — a CI log
  // already ends with the result, and names the path if the script fails.
  // The step in flight is settled first (a paragraph under an animating
  // spinner corrupts both), and a step of its own opens so the output before
  // the script's first milestone still has a line to repaint.
  const subject = input.wording?.subject ?? "the remote script";
  if (
    log !== null &&
    deps.stderr !== undefined &&
    isInteractiveOutput(deps.stderr)
  ) {
    input.progress.settle();
    writeMessage(
      deps.stderr,
      `Full output: ${log.path} (tail -f it in another terminal to watch)`,
    );
    input.progress.write(`starting ${subject}`);
  }

  // Finalized in `finally`: a launch that throws rather than exiting leaves
  // the renderer holding a partial line and the log file open, and the
  // failure the user then sees would be drawn over a spinner still animating.
  let result: ProcessRunResult;
  try {
    result = await input.launch((chunk) => renderer.write(chunk));
  } finally {
    removeInterruptHook();
    renderer.end();
    await finalize();
  }

  // Completion keys on the exit code, never on a final log line: install.sh's
  // closing summary is a bare printf with no [selfhost] prefix, and a restore
  // that skipped its smoke prints nothing new at the end at all.
  if (result.exitCode !== 0) {
    throw new RemoteScriptFailure(
      renderRemoteFailure({
        exitCode: result.exitCode,
        failureMessage: renderer.failureMessage(),
        ...(log !== null ? { logPath: log.path } : {}),
        signal: result.signal,
        tail: renderer.tail(),
        ...(input.wording !== undefined ? input.wording : {}),
      }),
      renderer.failureMessage(),
    );
  }

}

function terminalWidth(
  stream: CommandDeps["stderr"],
): number | undefined {
  const columns = (stream as { columns?: unknown } | undefined)?.columns;
  return typeof columns === "number" && columns > 0 ? columns : undefined;
}
