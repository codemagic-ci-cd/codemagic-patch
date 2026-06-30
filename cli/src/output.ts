import type { ProblemDetails } from "./problem-details";

export type WritableStream = {
  isTTY?: boolean;
  write: (chunk: string) => void;
};

export type StructuredOutputFormat = "json" | "table";

export type StructuredOutputSelection = {
  format: StructuredOutputFormat;
  source: "default" | "explicit";
  stdout: "pipe" | "tty";
};

export function writeJson(
  stream: { write: (chunk: string) => void },
  value: unknown,
): void {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function writeLine(
  stream: { write: (chunk: string) => void },
  line: string,
): void {
  stream.write(`${line}\n`);
}

export function selectStructuredOutputFormat(
  requestedFormat: StructuredOutputFormat | undefined,
  stdout: WritableStream,
): StructuredOutputSelection {
  const stdoutKind = isInteractiveOutput(stdout) ? "tty" : "pipe";
  const defaultFormat = stdoutKind === "tty" ? "table" : "json";

  return {
    format: requestedFormat ?? defaultFormat,
    source: requestedFormat === undefined ? "default" : "explicit",
    stdout: stdoutKind,
  };
}

export function renderGenericTable(value: unknown): string {
  if (Array.isArray(value)) {
    return renderArrayTable(value);
  }

  if (isRecord(value)) {
    const rows = flattenRecord(value);
    return renderTable(
      ["key", "value"],
      rows.length === 0
        ? [["-", "-"]]
        : rows.map(([key, cellValue]) => [key, formatTableValue(cellValue)]),
    );
  }

  return renderTable([value === null ? "result" : typeof value], [
    [formatTableValue(value)],
  ]);
}

export function isInteractiveOutput(stream: WritableStream): boolean {
  return stream.isTTY === true;
}

function renderArrayTable(values: unknown[]): string {
  if (values.length === 0) {
    return renderTable(["value"], [["-"]]);
  }

  const recordRows = values.filter(isRecord);
  if (recordRows.length === values.length) {
    const keys = Array.from(
      new Set(recordRows.flatMap((row) => Object.keys(row))),
    );
    return renderTable(
      keys.length === 0 ? ["value"] : keys,
      recordRows.map((row) =>
        keys.length === 0
          ? ["-"]
          : keys.map((key) => formatTableValue(row[key])),
      ),
    );
  }

  return renderTable(
    ["value"],
    values.map((row) => [formatTableValue(row)]),
  );
}

function flattenRecord(
  value: Record<string, unknown>,
  prefix = "",
): Array<[string, unknown]> {
  return Object.entries(value).flatMap(([key, nestedValue]) => {
    const path = prefix.length === 0 ? key : `${prefix}.${key}`;

    if (isRecord(nestedValue)) {
      const nestedRows = flattenRecord(nestedValue, path);
      return nestedRows.length === 0 ? [[path, nestedValue]] : nestedRows;
    }

    return [[path, nestedValue]];
  });
}

function renderTable(headers: string[], rows: string[][]): string {
  const normalizedRows = rows.length === 0 ? [headers.map(() => "-")] : rows;
  const widths = headers.map((header, index) =>
    Math.max(
      header.length,
      ...normalizedRows.map((row) => (row[index] ?? "").length),
    ),
  );

  const renderRow = (row: string[]) =>
    row
      .map((cell, index) => cell.padEnd(widths[index] ?? cell.length))
      .join("  ")
      .trimEnd();

  return `${[
    renderRow(headers.map((header) => header.toUpperCase())),
    renderRow(widths.map((width) => "-".repeat(width))),
    ...normalizedRows.map(renderRow),
  ].join("\n")}\n`;
}

function formatTableValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "-";
  }

  if (typeof value === "string") {
    return value.length === 0 ? "-" : value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readCell(
  record: Record<string, unknown>,
  key: string,
  fallback = "-",
): string {
  const value = record[key];
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  return String(value);
}

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

  const extraEntries = Object.entries(problem).filter(
    ([key]) => !["detail", "status", "title", "type"].includes(key),
  );

  if (extraEntries.length > 0) {
    lines.push(JSON.stringify(Object.fromEntries(extraEntries), null, 2));
  }

  return `${lines.join("\n")}\n`;
}
