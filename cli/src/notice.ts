import { note as clackNote, outro as clackOutro } from "@clack/prompts";

import { isInteractiveWritable, writeLine, type WritableStream } from "./output";

/**
 * A titled block of detail the user must read before answering something.
 *
 * Drawn as a clack note in a terminal so it belongs to the same tree as the
 * confirm that follows it — an unstyled list above a styled prompt reads as two
 * unrelated pieces of output. Everywhere else it degrades to the plain lines it
 * has always been, which is what the CI logs and the output tests expect.
 */
export function writeNote(
  stderr: WritableStream,
  title: string,
  lines: string[],
): void {
  if (isInteractiveWritable(stderr)) {
    clackNote(lines.join("\n"), title, { output: stderr });
    return;
  }

  writeLine(stderr, title);
  for (const line of lines) {
    writeLine(stderr, `  ${line}`);
  }
}

/**
 * The closing line of an interactive flow. Drawn as a clack outro so the
 * prompt tree the flow opened is visually closed instead of trailing off into
 * an unstyled line; everywhere else it degrades to the plain line it has
 * always been.
 */
export function writeClosing(stderr: WritableStream, message: string): void {
  if (isInteractiveWritable(stderr)) {
    clackOutro(message, { output: stderr });
    return;
  }

  writeLine(stderr, message);
}
