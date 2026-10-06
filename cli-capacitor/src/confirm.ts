import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { PromptAbortError } from "./errors";
import type { WritableStream } from "./output";

export type ConfirmFn = (message: string) => Promise<boolean>;

/**
 * May this run stop and ask? Same gate as `cmpatch`: a real terminal on both
 * ends of the question (it is drawn on stderr, so `2>file` must not block on a
 * prompt nobody can see), and not a CI job — plenty of runners allocate a tty,
 * and a job that stops to ask hangs until it times out.
 */
export function canPrompt(input: {
  env: Record<string, string | undefined>;
  stderr: WritableStream;
  stdin: { isTTY?: boolean };
}): boolean {
  return (
    !isContinuousIntegration(input.env) &&
    input.stdin.isTTY === true &&
    input.stderr.isTTY === true
  );
}

function isContinuousIntegration(
  env: Record<string, string | undefined>,
): boolean {
  const value = env.CI;

  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "0" &&
    value !== "false"
  );
}

/** A y/N question on the process's own terminal. Anything but y/yes is a "no". */
export function createTerminalConfirm(
  input: Readable = process.stdin,
  output: Writable = process.stderr,
): ConfirmFn {
  return (message) =>
    new Promise<boolean>((resolve, reject) => {
      const prompt = createInterface({ input, output });
      let answered = false;

      // readline swallows Ctrl-C on a tty unless someone listens for it; closing
      // turns it (and a closed stdin) into the abort below instead of a hang.
      prompt.on("SIGINT", () => prompt.close());
      prompt.on("close", () => {
        if (!answered) {
          reject(new PromptAbortError());
        }
      });

      prompt.question(`${message} (y/N) `, (answer) => {
        answered = true;
        prompt.close();
        resolve(/^y(es)?$/i.test(answer.trim()));
      });
    });
}
