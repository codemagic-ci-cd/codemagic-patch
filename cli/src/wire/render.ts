// What the developer reads: the project and plan before confirming it, and
// the result afterwards. Both are built from the same rows, so what was
// promised and what happened use the same words. One row per step, grouped
// by where the change lands (SDK, iOS, Android, JS), with the file first and
// a few words on what happens to it; the reasons and instructions for work
// left to the developer are collected once, below the rows, instead of being
// repeated per platform inside them.

import path from "node:path";

import { PLAIN_PALETTE, type Palette } from "../output";
import { renderUnifiedDiff } from "./diff";
import { materializeWrites, type WirePlan } from "./plan";
import { isBlockedByInstall, stepOutcome, type WireResult, type WireStep, type WireStepState } from "./types";

/** The destination step's detail when the developer chose to replace a conflicting group. */
export const REPLACED_DESTINATION = "replace the existing deployment key and URLs";

const PLATFORM_NAMES = { ios: "iOS", android: "Android" } as const;

const STATE_LABELS: Record<Exclude<WireStepState, "changed" | "already-configured">, string> = {
  declined: "not applied",
  deferred: "deferred",
  failed: "failed",
  manual: "left to you",
  preserved: "kept as is",
  skipped: "skipped",
};

/** Paths longer than this lose their middle directories in a row. */
const TARGET_MAX = 40;

type Tone = "plain" | "dim" | "warn" | "err";
type Mode = "plan" | "result";

// --- Before applying -------------------------------------------------------

/** The project and where its updates will come from, as one block. */
export function renderProject(plan: WirePlan): string[] {
  const { shape, destinations } = plan;
  const framework =
    shape.framework === "expo"
      ? `Expo${shape.expoVersion === undefined ? "" : ` ${shape.expoVersion}`} (${shape.expoNative === "generated" ? "native projects from prebuild" : "native projects in the repo"})`
      : "bare React Native";
  const reactNative = shape.reactNativeVersion === undefined ? "" : `, React Native ${shape.reactNativeVersion}`;
  const manager = `${shape.packageManager.kind}${shape.packageManager.pnp ? ", Plug'n'Play" : ""}`;
  const sdk =
    shape.sdk.installedVersion !== undefined
      ? `${shape.sdk.installedVersion} installed`
      : shape.sdk.declared === undefined
        ? "not installed"
        : `${shape.sdk.declared} declared, not installed`;
  const rows: Array<[string, string]> = [
    ["Project", `${shape.name}, ${framework}${reactNative} (${manager})`],
    ["SDK", sdk],
  ];
  // The server and download URLs are the same for every platform of one
  // connection; they are listed once unless they are not.
  const shared =
    destinations.length > 0 &&
    destinations.every(
      (destination) =>
        destination.apiUrl === destinations[0]!.apiUrl &&
        destination.downloadBaseUrl === destinations[0]!.downloadBaseUrl,
    );
  for (const destination of destinations) {
    rows.push([PLATFORM_NAMES[destination.platform], `${destination.app.name} → ${destination.deployment.name}`]);
    rows.push(["", `key ${destination.deploymentKey}`]);
    if (!shared) {
      rows.push(["", `API ${destination.apiUrl}`]);
      rows.push(["", `downloads ${destination.downloadBaseUrl}`]);
    }
  }
  if (shared) {
    rows.push(["API", destinations[0]!.apiUrl]);
    rows.push(["Downloads", destinations[0]!.downloadBaseUrl]);
  }
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`);
}

/** The plan as rows: what changes, what already holds, what is left to do. */
export function renderPlan(steps: WireStep[], plan: WirePlan, palette: Palette = PLAIN_PALETTE): string[] {
  const lines = renderRows(steps, plan.shape.root, palette, { mode: "plan", marks: false });
  const install = plan.steps.find((planned) => planned.step.id === "sdk-install")?.action;
  if (install?.kind === "command" && install.decision === "run") {
    lines.push("", palette.dim(`The lockfile is updated by ${install.command[0]} and is not previewed.`));
  }
  return lines;
}

export async function renderPlanDiffs(plan: WirePlan): Promise<string[]> {
  const lines: string[] = [];
  const { writes, failures } = await materializeWrites(plan.steps);
  for (const write of writes) {
    lines.push(...renderUnifiedDiff(path.relative(plan.shape.root, write.file), write.before ?? "", write.after));
    lines.push("");
  }
  for (const [file, reason] of failures) {
    lines.push(`(no diff for ${path.relative(plan.shape.root, file)}: ${reason})`, "");
  }
  return lines;
}

// --- After applying --------------------------------------------------------

export function renderWireHeadline(result: WireResult): string {
  if (result.notApplied !== undefined) {
    return result.result === "failed"
      ? "SDK wiring failed; nothing was changed"
      : `SDK wiring not applied: ${result.notApplied}`;
  }
  if (result.dryRun) {
    switch (result.result) {
      case "complete":
        return "Dry run: nothing was changed; the plan is ready to apply";
      case "incomplete":
        return "Dry run: nothing was changed; the plan leaves steps to do by hand";
      case "failed":
        return "Dry run: SDK wiring cannot proceed";
    }
  }
  switch (result.result) {
    case "complete":
      return result.steps.every((step) => step.state === "already-configured")
        ? "SDK already wired; nothing to change"
        : "SDK wiring complete";
    case "incomplete":
      return "SDK wiring incomplete";
    case "failed":
      return "SDK wiring failed";
  }
}

/**
 * The headline with its mark, both in the outcome's colour, so success reads
 * as clearly as failure does.
 */
export function renderWireHeadlineLine(result: WireResult, palette: Palette): string {
  const tone =
    result.result === "complete" && result.notApplied === undefined
      ? { mark: "✓", paint: palette.ok }
      : result.result === "failed"
        ? { mark: "✗", paint: palette.err }
        : { mark: "!", paint: palette.warn };
  return tone.paint(`${tone.mark} ${palette.bold(renderWireHeadline(result))}`);
}

/**
 * The result under its headline: the rows of what happened, then what
 * failed and how to fix it, then the work left to the developer. A dry run
 * or a plan that was not applied was just shown in full as the plan, so
 * only the failures and the left-over work are repeated.
 */
export function renderWireReport(result: WireResult, palette: Palette): string[] {
  const lines: string[] = [];
  if (!result.dryRun && result.notApplied === undefined) {
    lines.push(...renderRows(result.steps, result.project.root, palette, { mode: "result", marks: true }));
  }
  const sections: Array<[string, string[]]> = [
    [palette.err(palette.bold("What failed")), renderFailures(result.steps, result.project.root, palette)],
    [palette.warn(palette.bold("Left for you to do")), renderAttention(result.steps, result.project.root, palette)],
  ];
  for (const [heading, body] of sections) {
    if (body.length === 0) continue;
    if (lines.length > 0) lines.push("");
    lines.push(heading, "", ...body);
  }
  return lines;
}

export function renderWireResult(result: WireResult, palette: Palette): string {
  const lines = [renderWireHeadlineLine(result, palette)];
  const report = renderWireReport(result, palette);
  if (report.length > 0) lines.push("", ...report.map((line) => (line === "" ? "" : `  ${line}`)));
  if (result.nextSteps.length > 0) {
    lines.push("", palette.bold("Next steps"), ...renderNextSteps(result.nextSteps, palette).map((line) => `  ${line}`));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Numbered next steps. A step written as `Title: \`a\`, then \`b\`` puts each
 * command on its own line, in the colour of something to type elsewhere;
 * any other backticked command is coloured in place.
 */
export function renderNextSteps(steps: readonly string[], palette: Palette): string[] {
  const lines: string[] = [];
  steps.forEach((step, index) => {
    const number = `${index + 1}. `;
    const commandsOnly = /^(.*?): ((?:`[^`]+`(?:, (?:then )?)?)+)$/.exec(step);
    if (commandsOnly !== null) {
      lines.push(`${number}${commandsOnly[1]}`);
      for (const [, command] of commandsOnly[2]!.matchAll(/`([^`]+)`/g)) {
        lines.push(`${" ".repeat(number.length + 2)}${palette.value(command!)}`);
      }
      return;
    }
    lines.push(`${number}${commands(step, palette)}`);
  });
  return lines;
}

/** Backticked commands in prose, in the colour of something to type elsewhere. */
function commands(text: string, palette: Palette): string {
  return text.replace(/`([^`]+)`/g, (_, command: string) => palette.value(command));
}

// --- Rows ------------------------------------------------------------------

type Row = { area: string; target: string; note: string; tone: Tone; mark: string; sub?: string };

function renderRows(
  steps: readonly WireStep[],
  root: string,
  palette: Palette,
  options: { mode: Mode; marks: boolean },
): string[] {
  const ordered = [...steps].sort((a, b) => areaRank(a) - areaRank(b));
  const rows = ordered.map((step): Row => {
    const { text, tone } = noteOf(step, options.mode);
    const outcome = stepOutcome(step.state);
    // What the failed install kept back is not a problem of its own: it
    // stays quiet, and says why once, under the rows.
    const quiet = isBlockedByInstall(step);
    return {
      area: areaOf(step, steps),
      target: targetOf(step, root),
      note: text,
      tone,
      mark: quiet
        ? palette.dim("–")
        : outcome === "complete"
          ? palette.ok("✓")
          : outcome === "failed"
            ? palette.err("✗")
            : palette.warn("!"),
      // Failures and work left to the developer are explained once, below
      // the rows; the other incomplete states say why on the line under
      // their row.
      ...(outcome !== "complete" && !isFailure(step) && !isAttention(step) && !quiet && step.state !== "declined"
        ? { sub: reasonOf(step, root) }
        : {}),
    };
  });
  const areaWidth = Math.max(...rows.map((row) => row.area.length));
  const targetWidth = Math.max(0, ...rows.map((row) => row.target.length));
  const markWidth = options.marks ? 2 : 0;
  const lines: string[] = [];
  let previousArea: string | undefined;
  for (const row of rows) {
    const area = row.area === previousArea ? "" : row.area;
    previousArea = row.area;
    const mark = options.marks ? `${row.mark} ` : "";
    const note = paint(row.note, row.tone, palette);
    const body = row.target === "" ? note : `${row.target.padEnd(targetWidth)}  ${note}`;
    lines.push(`${mark}${area.padEnd(areaWidth)}  ${body}`);
    for (const sub of row.sub?.split("\n") ?? []) {
      lines.push(`${" ".repeat(markWidth + areaWidth + 2)}${palette.dim(sub)}`);
    }
  }
  const held = steps.filter(isBlockedByInstall).length;
  if (held > 0) {
    lines.push(
      "",
      palette.dim(`${options.marks ? "– " : ""}${held === 1 ? "1 change was" : `${held} changes were`} not applied because the SDK install failed.`),
    );
  }
  return lines;
}

function paint(text: string, tone: Tone, palette: Palette): string {
  switch (tone) {
    case "plain":
      return text;
    case "dim":
      return palette.dim(text);
    case "warn":
      return palette.warn(text);
    case "err":
      return palette.err(text);
  }
}

/**
 * The step's detail without the `file: ` (or `file (ios, android): `) prefix
 * its row or heading already shows.
 */
function reasonOf(step: WireStep, root: string): string {
  const file = step.files?.[0];
  const prefix = /^(\S+)(?: \([a-z, ]+\))?: /.exec(step.detail);
  return file !== undefined && prefix !== null && prefix[1] === path.relative(root, file)
    ? step.detail.slice(prefix[0].length)
    : step.detail;
}

/** The platform is named on a JS root only when the platforms have different roots. */
function areaOf(step: WireStep, steps: readonly WireStep[]): string {
  if (step.id === "sdk-install") return "SDK";
  if (step.id === "js-root") {
    const separate = steps.filter((other) => other.id === "js-root").length > 1;
    return step.platform === undefined || !separate ? "JS" : `JS (${PLATFORM_NAMES[step.platform]})`;
  }
  return step.platform === undefined ? "" : PLATFORM_NAMES[step.platform];
}

function areaRank(step: WireStep): number {
  if (step.id === "sdk-install") return 0;
  if (step.id === "js-root") return 3;
  return step.platform === "android" ? 2 : 1;
}

function targetOf(step: WireStep, root: string): string {
  if (step.id === "sdk-install") return "";
  if (step.id === "pod-install") return "CocoaPods";
  const file = step.files?.[0];
  return file === undefined ? "" : elidePath(path.relative(root, file));
}

/** `android/…/java/com/demo/MainApplication.kt`: the first directory and as much of the end as fits. */
export function elidePath(file: string, max = TARGET_MAX): string {
  if (file.length <= max) return file;
  const parts = file.split("/");
  if (parts.length <= 2) return file;
  for (let keep = parts.length - 2; keep >= 1; keep -= 1) {
    const candidate = [parts[0], "…", ...parts.slice(parts.length - keep)].join("/");
    if (candidate.length <= max) return candidate;
  }
  return `…/${parts[parts.length - 1]}`;
}

function noteOf(step: WireStep, mode: Mode): { text: string; tone: Tone } {
  switch (step.state) {
    case "changed":
      return { text: changedNote(step, mode === "result"), tone: "plain" };
    case "already-configured":
      return { text: step.id === "sdk-install" ? step.detail : "already set up", tone: "dim" };
    default:
      if (isBlockedByInstall(step)) return { text: "not applied", tone: "dim" };
      return {
        text: isFailure(step) || isAttention(step) ? `${STATE_LABELS[step.state]}, see below` : STATE_LABELS[step.state],
        tone: step.state === "failed" ? "err" : "warn",
      };
  }
}

function changedNote(step: WireStep, done: boolean): string {
  switch (step.id) {
    case "sdk-install":
      return done ? step.detail.replace(/^install /, "installed ").replace(/^upgrade /, "upgraded ") : step.detail;
    case "destination": {
      const replaced = step.detail.includes(REPLACED_DESTINATION);
      return done
        ? `deployment key and URLs ${replaced ? "replaced" : "set"}`
        : `${replaced ? "replace" : "set"} deployment key and URLs`;
    }
    case "native-hook":
      return done ? "loads the Patch bundle first" : "load the Patch bundle first";
    case "js-root":
      return done ? "root wrapped with Patch.wrap" : "wrap the root with Patch.wrap";
    case "pod-install":
      return done ? step.detail.replace(/^run /, "ran ") : step.detail;
  }
}

// --- Failures and work left to the developer ------------------------------

function isFailure(step: WireStep): boolean {
  return step.state === "failed";
}

/**
 * Work only the developer can finish. Pods are left out — the next steps
 * carry their command — and so are failures, which have their own section.
 */
function isAttention(step: WireStep): boolean {
  if (step.id === "pod-install") return false;
  return step.state === "manual" || (step.state === "deferred" && step.manual !== undefined);
}

/**
 * Each failure once, under a marked heading: why, what the command printed,
 * then what to do about it. A failure several platforms share is folded into
 * one entry.
 */
export function renderFailures(steps: readonly WireStep[], root: string, palette: Palette): string[] {
  return renderEntries(steps.filter(isFailure), steps, root, palette, (step) => [
    ...lines(reasonOf(step, root)).map((line) => commands(line, palette)),
    ...(step.output ?? []).map((line) => palette.dim(`│ ${line}`)),
    ...(step.manual ?? []).map((line) =>
      // Indented lines are values to compare or paste; the rest is what to do.
      line.startsWith("  ") ? palette.value(line) : `${palette.value("→")} ${commands(line, palette)}`,
    ),
  ], palette.err("✗"));
}

/** Work only the developer can finish: the reason, then what to do. */
export function renderAttention(steps: readonly WireStep[], root: string, palette: Palette): string[] {
  return renderEntries(steps.filter(isAttention), steps, root, palette, (step) => [
    ...lines(reasonOf(step, root)).map((line) => commands(line, palette)),
    ...(step.manual ?? []).map((line) =>
      // Indented manual lines are code or values to paste.
      line.startsWith("  ") ? palette.value(line) : commands(line, palette),
    ),
  ], palette.warn("!"));
}

function renderEntries(
  selected: readonly WireStep[],
  steps: readonly WireStep[],
  root: string,
  palette: Palette,
  body: (step: WireStep) => string[],
  mark: string,
): string[] {
  // A step whose instruction another step already gave is folded into that one.
  const groups = new Map<string, { areas: string[]; step: WireStep }>();
  for (const step of [...selected].sort((a, b) => areaRank(a) - areaRank(b))) {
    const key = JSON.stringify([step.id, step.detail, step.manual ?? [], step.output ?? []]);
    const existing = groups.get(key);
    if (existing === undefined) groups.set(key, { areas: [areaOf(step, steps) || targetOf(step, root)], step });
    else existing.areas.push(areaOf(step, steps));
  }
  const out: string[] = [];
  for (const { areas, step } of groups.values()) {
    if (out.length > 0) out.push("");
    const file = step.files?.[0];
    const target = file === undefined ? targetOf(step, root) : path.relative(root, file);
    const where = target === "" ? "" : ` · ${target}`;
    out.push(`${mark} ${palette.bold(`${areas.join(", ")}${where}`)}`);
    out.push(...body(step).map((line) => `  ${line}`));
  }
  return out;
}

function lines(text: string): string[] {
  return text.split("\n");
}
