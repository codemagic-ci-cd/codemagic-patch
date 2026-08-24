// How a command's result is shown to a person.
//
// Results come in three shapes and only one of them is a table. A list of
// things is tabular; a single record is a set of labelled fields; and an action
// is neither — the user changed something and wants to read what changed, not
// to be handed its serialised form. Rendering all three as a KEY/VALUE table
// gave every command the presentation of the one shape that fit worst.
//
// Machine-readable output does not come through here: `--format json` and piped
// stdout are handled before any of this.

import { isRecord, type Palette } from "./output";

export type ObjectField = [label: string, path: string];

/**
 * A labelled record: aligned, unruled, and quiet about the labels so the values
 * are what the eye lands on. `fields` supplies human labels and an order;
 * without it the raw paths are used, which is honest — they are what the JSON
 * output calls those values — but is the reason declaring fields is worth it.
 */
export function renderObjectView(
  value: unknown,
  palette: Palette,
  fields?: readonly ObjectField[],
): string {
  // A scalar result is its own presentation. Wrapping "fp-abc123" in a labelled
  // field, or in a one-column table, only adds furniture around the answer.
  if (!isRecord(value)) {
    return value === undefined || value === null ? "" : `${formatValue(value)}\n`;
  }

  const rows =
    fields === undefined ? flattenRecord(value) : withRemainder(value, fields);

  if (rows.length === 0) {
    return "";
  }

  const width = Math.max(...rows.map(([label]) => label.length));

  return `${rows
    .map(([label, cell]) => `${palette.dim(label.padEnd(width))}  ${formatValue(cell)}`)
    .join("\n")}\n`;
}

export type ActionSummary = {
  /**
   * Where to go for the detail this line leaves out. Details belong to the
   * commands built to show them, so an action names the next command instead of
   * printing a record nobody asked for.
   */
  hint?: string;
  summary: string;
};

/** One sentence about what changed, and where to look for more. */
export function renderActionView(
  action: ActionSummary,
  palette: Palette,
): string {
  const head = `${palette.ok("✓")} ${action.summary}\n`;

  return action.hint === undefined
    ? head
    : `${head}${palette.dim(`  ${action.hint}`)}\n`;
}

/**
 * The API wraps every collection in a single named key — { tokens: [...] },
 * { apps: [...] }. Without unwrapping, a list from a command that has not
 * declared its own table renderer is shown as one field holding a JSON blob,
 * which is the least readable form of the most tabular data the CLI has.
 */
export function unwrapSingleList(value: unknown): unknown[] | null {
  if (!isRecord(value)) {
    return null;
  }

  const entries = Object.entries(value);
  const [entry] = entries;

  return entries.length === 1 && entry !== undefined && Array.isArray(entry[1])
    ? entry[1]
    : null;
}

/**
 * Declared fields first, then everything the declaration did not mention.
 *
 * A curated field list must not become a filter: the server can add a key, or
 * return a `warnings` array, and a view written before that existed would hide
 * it. The declaration decides what is important and what it is called, never
 * what the user is allowed to see.
 */
function withRemainder(
  value: Record<string, unknown>,
  fields: readonly ObjectField[],
): Array<[string, unknown]> {
  const declared = fields
    .map(([label, path]): [string, unknown, string] => [
      label,
      readPath(value, path),
      path,
    ])
    .filter(([, cell]) => cell !== undefined);
  const covered = new Set(declared.map(([, , path]) => path));

  return [
    ...declared.map(([label, cell]): [string, unknown] => [label, cell]),
    ...flattenRecord(value).filter(([path]) => !covered.has(path)),
  ];
}

function readPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    return isRecord(current) ? current[key] : undefined;
  }, value);
}

function flattenRecord(value: unknown, prefix = ""): Array<[string, unknown]> {
  if (!isRecord(value)) {
    return value === undefined ? [] : [[prefix.length === 0 ? "value" : prefix, value]];
  }

  return Object.entries(value).flatMap(([key, nested]) => {
    const path = prefix.length === 0 ? key : `${prefix}.${key}`;

    if (isRecord(nested)) {
      const rows = flattenRecord(nested, path);
      return rows.length === 0 ? [[path, nested]] : rows;
    }

    return [[path, nested] as [string, unknown]];
  });
}

function formatValue(value: unknown): string {
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
