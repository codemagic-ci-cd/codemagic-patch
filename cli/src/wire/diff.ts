/**
 * A unified diff of two texts, for the `--diff` preview. Line-based LCS is
 * enough: the files wire edits are a few hundred lines, and the point is
 * to show the handful of changed lines with a little context.
 */
export function renderUnifiedDiff(
  label: string,
  before: string,
  after: string,
  context = 3,
): string[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const ops = diffLines(a, b);
  const lines = [`--- ${label}`, `+++ ${label}`];
  let index = 0;
  while (index < ops.length) {
    if (ops[index]!.kind === "same") {
      index += 1;
      continue;
    }
    const start = Math.max(0, index - context);
    let end = index;
    let quiet = 0;
    while (end < ops.length && quiet <= context * 2) {
      quiet = ops[end]!.kind === "same" ? quiet + 1 : 0;
      end += 1;
    }
    end = Math.min(ops.length, end - Math.max(0, quiet - context));
    const hunk = ops.slice(start, end);
    const oldStart = hunk[0]!.oldLine;
    const newStart = hunk[0]!.newLine;
    const oldCount = hunk.filter((op) => op.kind !== "add").length;
    const newCount = hunk.filter((op) => op.kind !== "remove").length;
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of hunk) {
      lines.push(`${op.kind === "add" ? "+" : op.kind === "remove" ? "-" : " "}${op.text}`);
    }
    index = end;
  }
  return lines;
}

type Op = { kind: "add" | "remove" | "same"; text: string; oldLine: number; newLine: number };

function diffLines(a: string[], b: string[]): Op[] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] =
        a[i] === b[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ kind: "same", text: a[i]!, oldLine: i + 1, newLine: j + 1 });
      i += 1;
      j += 1;
    } else if (j < b.length && (i === a.length || table[i]![j + 1]! >= table[i + 1]![j]!)) {
      ops.push({ kind: "add", text: b[j]!, oldLine: i + 1, newLine: j + 1 });
      j += 1;
    } else {
      ops.push({ kind: "remove", text: a[i]!, oldLine: i + 1, newLine: j + 1 });
      i += 1;
    }
  }
  return ops;
}
