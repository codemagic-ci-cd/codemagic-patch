import {
  intro as clackIntro,
  log as clackLog,
  note as clackNote,
  outro as clackOutro,
} from "@clack/prompts";

import { isInteractiveWritable, writeLine, type WritableStream } from "./output";

/**
 * A titled block of detail the user must read before answering something.
 *
 * Drawn as a clack note in a terminal so it belongs to the same tree as the
 * confirm that follows it — an unstyled list above a styled prompt reads as two
 * unrelated pieces of output. Everywhere else it degrades to the plain lines it
 * has always been, which is what the CI logs and the output tests expect.
 *
 * `indent` belongs to the plain rendering only: a summary reads as a headline
 * over indented detail, while a block laid out to be copied line by line
 * passes "" so the plain copy is the same text the box would hold.
 */
export function writeNote(
  stderr: WritableStream,
  title: string,
  lines: string[],
  options: { indent?: string } = {},
): void {
  if (isInteractiveWritable(stderr)) {
    clackNote(lines.join("\n"), title, { output: stderr });
    return;
  }

  const indent = options.indent ?? "  ";
  writeLine(stderr, title);
  for (const line of lines) {
    writeLine(stderr, `${indent}${line}`);
  }
}

/**
 * A paragraph between two prompts.
 *
 * Drawn on clack's guide line — the `│` gutter every prompt already draws —
 * so what is said between two questions reads as part of the same run rather
 * than as unstyled text floating beside it. One call is one paragraph: clack
 * spaces each call from the one before, so a block of lines goes through
 * together and not a line at a time. Everywhere else it degrades to the plain
 * lines it has always been.
 */
export function writeMessage(
  stderr: WritableStream,
  message: string | readonly string[],
): void {
  const lines = typeof message === "string" ? message.split("\n") : [...message];
  if (isInteractiveWritable(stderr)) {
    clackLog.message(lines, { output: stderr });
    return;
  }

  for (const line of lines) {
    writeLine(stderr, line);
  }
}

/**
 * A paragraph between two prompts that the user should not read past: the
 * same guide-line paragraph as `writeMessage`, marked as a warning so it
 * stands out from the plain notes around it. Everywhere else it degrades to
 * plain lines.
 */
export function writeWarning(
  stderr: WritableStream,
  message: string | readonly string[],
): void {
  const lines = typeof message === "string" ? message.split("\n") : [...message];
  if (isInteractiveWritable(stderr)) {
    clackLog.warn(lines.join("\n"), { output: stderr });
    return;
  }

  for (const line of lines) {
    writeLine(stderr, line);
  }
}

/**
 * The opening line of an interactive flow, and the tree `writeClosing` closes.
 *
 * Drawn as a clack intro so every prompt and notice that follows hangs off
 * one bracket instead of starting cold at the first question; everywhere
 * else it degrades to a plain line, which a scripted run's log can grep for.
 */
export function writeOpening(stderr: WritableStream, title: string): void {
  if (isInteractiveWritable(stderr)) {
    clackIntro(title, { output: stderr });
    return;
  }

  writeLine(stderr, title);
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
