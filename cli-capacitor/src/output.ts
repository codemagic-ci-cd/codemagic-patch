import type { ProblemDetails } from "./problem-details";

export type WritableStream = {
  isTTY?: boolean;
  write: (chunk: string) => void;
};

export type OutputFormat = "json" | "text";

export function writeLine(stream: WritableStream, line: string): void {
  stream.write(`${line}\n`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Aligned `key: value` lines, indented under whatever sentence introduces them. */
export function renderFields(fields: Array<[string, string]>): string[] {
  const width = Math.max(...fields.map(([key]) => key.length)) + 1;

  return fields.map(([key, value]) => `  ${`${key}:`.padEnd(width)} ${value}`);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// The plain-text rendering of cli/src/output.ts `renderProblemDetails`
// (@codemagic/patch-cli 0.4.0), without the colour palette.
export function renderProblemDetails(problem: ProblemDetails): string {
  const lines: string[] = [];
  const title = typeof problem.title === "string" ? problem.title : "Request failed";
  const status = typeof problem.status === "number" ? ` (${problem.status})` : "";

  lines.push(`${title}${status}`);

  if (typeof problem.detail === "string" && problem.detail.length > 0) {
    lines.push(problem.detail);
  }

  if (typeof problem.type === "string" && problem.type.length > 0) {
    lines.push(`type: ${problem.type}`);
  }

  if (typeof problem.hint === "string" && problem.hint.length > 0) {
    lines.push(`Hint: ${problem.hint}`);
  }

  const extraEntries = Object.entries(problem).filter(
    ([key]) => !["detail", "hint", "status", "title", "type"].includes(key),
  );

  if (extraEntries.length > 0) {
    lines.push(JSON.stringify(Object.fromEntries(extraEntries), null, 2));
  }

  return lines.join("\n");
}
