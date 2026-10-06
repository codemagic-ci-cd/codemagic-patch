// How a command's result is shown to a person — the three shapes of
// cli/src/resultView.ts (@codemagic/patch-cli 0.4.0): a list is a table, a single
// thing is a set of labelled fields, and an action is a sentence about what changed.
// `--format json` bypasses all of it and prints the server's response as it came.

import type { Column, CommandOutput } from "./command";
import { isRecord, type OutputFormat } from "./output";

export function renderOutput(output: CommandOutput, format: OutputFormat): string {
  if (format === "json") {
    return `${JSON.stringify(output.json, null, 2)}\n`;
  }

  switch (output.kind) {
    case "list":
      return renderList(output.columns, output.rows, output.empty, output.footer);
    case "record":
      return `${output.title === undefined ? "" : `${output.title}\n`}${renderRecord(output.record, output.fields)}`;
    case "action":
      return [output.summary, ...(output.details ?? []).map((line) => `  ${line}`)]
        .map((line) => `${line}\n`)
        .join("");
  }
}

function renderList(
  columns: readonly Column[],
  rows: ReadonlyArray<Record<string, unknown>>,
  empty: string,
  footer: string | undefined,
): string {
  if (rows.length === 0) {
    return `${empty}\n`;
  }

  const cells = rows.map((row) =>
    columns.map((column) => formatValue(readPath(row, column.path))),
  );
  const widths = columns.map((column, index) =>
    Math.max(column.header.length, ...cells.map((row) => row[index]!.length)),
  );
  const line = (values: string[]): string =>
    values
      .map((value, index) => value.padEnd(widths[index]!))
      .join("  ")
      .trimEnd();

  return [
    line(columns.map((column) => column.header)),
    ...cells.map(line),
    ...(footer === undefined ? [] : ["", footer]),
  ]
    .map((text) => `${text}\n`)
    .join("");
}

/**
 * Declared fields first, then everything the declaration did not mention: a
 * curated field list decides what matters and what it is called, never what the
 * user is allowed to see — the server may add a key after this was written.
 */
function renderRecord(
  record: unknown,
  fields: ReadonlyArray<readonly [label: string, path: string]>,
): string {
  const declared = fields
    .map(([label, path]) => [label, readPath(record, path), path] as const)
    .filter(([, value]) => value !== undefined);
  const covered = new Set(declared.map(([, , path]) => path));
  const rows: Array<readonly [string, unknown]> = [
    ...declared.map(([label, value]) => [label, value] as const),
    ...flattenRecord(record).filter(([path]) => !covered.has(path)),
  ];

  if (rows.length === 0) {
    return "";
  }

  const width = Math.max(...rows.map(([label]) => label.length));
  return rows
    .map(([label, value]) => `${label.padEnd(width)}  ${formatValue(value)}\n`)
    .join("");
}

function readPath(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((current, key) => (isRecord(current) ? current[key] : undefined), value);
}

function flattenRecord(value: unknown, prefix = ""): Array<[string, unknown]> {
  if (!isRecord(value)) {
    return value === undefined ? [] : [[prefix.length === 0 ? "value" : prefix, value]];
  }

  return Object.entries(value).flatMap(([key, nested]) => {
    const path = prefix.length === 0 ? key : `${prefix}.${key}`;
    if (isRecord(nested)) {
      const rows = flattenRecord(nested, path);
      return rows.length === 0 ? [[path, nested] as [string, unknown]] : rows;
    }

    return [[path, nested] as [string, unknown]];
  });
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "-";
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}
