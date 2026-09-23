// The wiring operation `cmpatch wire` runs and `cmpatch init` composes:
// inspect, resolve destinations, plan, show, decide, apply, report.

import path from "node:path";

import { PRODUCT_NAME } from "../branding";
import { UsageError, type CommandDeps, canPromptOnStderr } from "../commands/shared";
import {
  loadProjectConfigFile,
  resolveProjectConfigPath,
  saveProjectConfig,
  type ProjectConfig,
} from "../configStore";
import { writeClosing, writeMessage, writeNote, writeOpening, writeWarning } from "../notice";
import { createPalette, isInteractiveWritable, type Palette } from "../output";
import { createProgress, onInterruptCleanup } from "../progress";
import type { NativePlatform } from "../projectAnalysis";
import { getCliVersion } from "../version";
import { applyPlan } from "./apply";
import { resolveDestinations } from "./destination";
import { isFile } from "./fs";
import { buildPlan, hasWork, previewStep, type PlannedStep, type WirePlan } from "./plan";
import { inspectProject, summarizeProject } from "./project";
import {
  renderAttention,
  renderPlan,
  renderPlanDiffs,
  renderProject,
  REPLACED_DESTINATION,
} from "./render";
import {
  aggregateOutcome,
  stepOutcome,
  WIRE_EXIT_CODES,
  type WireResult,
  type WireStep,
} from "./types";
import { isWorktreeDirty } from "./worktree";

const PLATFORM_NAMES = { ios: "iOS", android: "Android" } as const;

export type WireOptions = {
  allowDirty: boolean;
  dryRun: boolean;
  nativeProjects?: "generated" | "maintained";
  nonInteractive: boolean;
  platforms?: NativePlatform[];
  podInstall: "ask" | "run" | "skip";
  replaceDestination: boolean;
  showDiff: boolean;
  skipJs: boolean;
  token?: string;
  yes: boolean;
};

export type WireInput = {
  connection: Pick<ProjectConfig, "apps" | "nativeProjects" | "serverUrl" | "teamId">;
  options: WireOptions;
  projectRoot: string;
  /** Computed by init before it wrote the project config; wire computes it itself otherwise. */
  worktreeDirty?: boolean | null;
  /**
   * Whether an enclosing flow already opened the terminal's prompt tree —
   * `cmpatch init`, handing off to wiring. Otherwise wiring opens its own and
   * closes it on every way out.
   */
  inheritsTree?: boolean;
};

export async function runWire(deps: CommandDeps, input: WireInput): Promise<WireResult> {
  const stderr = deps.stderr;
  if (input.inheritsTree === true || stderr === undefined || !isInteractiveWritable(stderr)) {
    return wire(deps, input);
  }
  const palette = createPalette(stderr, deps.env);
  writeOpening(
    stderr,
    `${PRODUCT_NAME} · cmpatch wire ${palette.dim(getCliVersion())}${input.options.dryRun ? " (dry run)" : ""}`,
  );
  let result: WireResult;
  try {
    result = await wire(deps, input);
  } catch (error) {
    writeClosing(stderr, "");
    throw error;
  }
  writeClosing(stderr, closingLine(result, palette));
  return result;
}

/** The tree's last line agrees with the result printed under it. */
function closingLine(result: WireResult, palette: Palette): string {
  if (result.notApplied !== undefined) {
    return result.result === "failed" ? palette.err("Nothing was changed") : "Nothing was changed";
  }
  if (result.dryRun) return result.result === "failed" ? palette.err("Dry run: wiring cannot proceed") : "Done";
  switch (result.result) {
    case "complete":
      return palette.ok("Done");
    case "incomplete":
      return palette.warn("Done, with steps left for you");
    case "failed":
      return palette.err("Wiring failed");
  }
}

async function wire(deps: CommandDeps, input: WireInput): Promise<WireResult> {
  const { options, projectRoot } = input;
  const interactive =
    canPromptOnStderr(deps, options.nonInteractive) &&
    !options.yes &&
    deps.prompt !== undefined &&
    deps.confirm !== undefined &&
    deps.stderr !== undefined;
  const palette = deps.stderr === undefined ? undefined : createPalette(deps.stderr, deps.env);
  const say = (lines: string | string[]) => {
    if (deps.stderr !== undefined) writeMessage(deps.stderr, lines);
  };
  const warn = (lines: string | string[]) => {
    if (deps.stderr !== undefined) writeWarning(deps.stderr, lines);
  };
  const note = (title: string, lines: string[]) => {
    if (deps.stderr !== undefined) writeNote(deps.stderr, title, lines);
  };

  const shape = await inspectProject(projectRoot);
  let nativeProjectsAnswer: "generated" | "maintained" | undefined;
  if (shape.framework === "expo") {
    // Flag, then the answer saved by an earlier run, then Git evidence, then the question.
    nativeProjectsAnswer = options.nativeProjects ?? input.connection.nativeProjects;
    if (nativeProjectsAnswer === undefined && shape.expoNative === "unknown") {
      if (!interactive) {
        throw new UsageError(
          "Git evidence could not establish whether Expo prebuild generates this project's native directories. Pass --native-projects generated or --native-projects maintained.",
        );
      }
      nativeProjectsAnswer = await askNativeProjects(deps);
    }
    if (nativeProjectsAnswer !== undefined) shape.expoNative = nativeProjectsAnswer;
  }
  // An explicit answer is kept only once the plan it informed is applied; a
  // declined or dry run leaves the saved config as it was.
  const remember = async () => {
    if (nativeProjectsAnswer !== undefined) await rememberNativeProjects(projectRoot, nativeProjectsAnswer);
  };
  const linked = (["ios", "android"] as const).filter(
    (platform) => input.connection.apps?.[platform] !== undefined,
  );
  const platforms = linked.filter(
    (platform) => options.platforms === undefined || options.platforms.includes(platform),
  );
  if (platforms.length === 0) {
    throw new UsageError(
      linked.length === 0
        ? "No platform is linked in codemagic-patch.config.json. Run `cmpatch init` first."
        : `The linked platforms are ${linked.join(", ")}; --platform ${options.platforms?.join(", ")} is not among them.`,
    );
  }
  const worktreeDirty =
    input.worktreeDirty !== undefined ? input.worktreeDirty : await isWorktreeDirty(deps, projectRoot);

  const resolved = await resolveDestinations(deps, input.connection, platforms, options.token);
  const plan = await buildPlan({
    shape,
    platforms,
    linkedPlatforms: linked,
    destinations: resolved.destinations,
    destinationFailures: resolved.failures,
    skipJs: options.skipJs,
    os: deps.platform ?? process.platform,
  });

  note("Project", renderProject(plan));
  // Decisions come before the plan is shown, so what is confirmed is what
  // will be applied — including a replaced destination's diff. The one
  // exception is the optional `pod install`: an interactive run asks it once
  // the plan is confirmed, not before the plan has been seen.
  await decideConflicts(deps, plan, options, interactive);
  const podQuestion = decidePodInstall(plan, options, interactive);
  const preview = plan.steps.map((planned) =>
    planned === podQuestion ? { ...previewStep(planned), state: "changed" as const } : previewStep(planned),
  );
  note(options.dryRun ? "Plan (dry run)" : "Plan", renderPlan(preview, plan, palette));
  const attention = palette === undefined ? [] : renderAttention(preview, plan.shape.root, palette);
  if (attention.length > 0) {
    warn("Left for you to do");
    say(attention);
  }
  if (options.showDiff) say(await renderPlanDiffs(plan));
  if (worktreeDirty === true) {
    warn("The working tree has uncommitted changes; these edits would be mixed in with them.");
  }

  if (options.dryRun) {
    return finish(plan, plan.steps.map(previewStep), options, "dry-run");
  }
  // A step that already failed in planning is not applied around: the rest
  // of the plan assumes it, and an app wired without its deployment key
  // would build and ship without updates.
  if (plan.steps.some(failedInPlanning)) {
    return finish(plan, blocked(plan), options, "failed-plan", "fix what failed first");
  }
  const applies = plan.steps.some((planned) => hasWork(planned) || planned === podQuestion);
  if (!applies) {
    await remember();
    return finish(plan, plan.steps.map(previewStep), options, "applied");
  }
  if (worktreeDirty === true && !interactive && !options.allowDirty) {
    return finish(plan, blocked(plan), options, "blocked", "the working tree has uncommitted changes; pass --allow-dirty to apply anyway");
  }
  if (interactive) {
    // When `pod install` is the only change, its question is the confirmation.
    if (plan.steps.some(hasWork)) {
      const confirmed = await deps.confirm!({ initial: true, message: "Apply these changes?" });
      if (!confirmed) {
        return finish(plan, blocked(plan, "declined"), options, "declined", "declined at confirmation");
      }
    }
    if (podQuestion !== undefined) await askPodInstall(deps, podQuestion);
    if (!plan.steps.some(hasWork)) {
      await remember();
      return finish(plan, plan.steps.map(previewStep), options, "applied");
    }
  } else if (!options.yes) {
    return finish(plan, blocked(plan, "declined"), options, "declined", "pass --yes to approve the plan non-interactively");
  }

  const progress = createProgress({ intro: "inherited", label: "wire", stderr: deps.stderr });
  const dispose = onInterruptCleanup(async () => {
    progress.fail("Wiring interrupted; completed changes are kept");
    if (deps.stderr === undefined) return;
    writeMessage(deps.stderr, "Run `cmpatch wire` again to resume from the project's current state.");
    // The process exits after the cleanup hooks without unwinding to the
    // flow that opened the prompt tree — wire's own or init's — so it is
    // closed here.
    if (isInteractiveWritable(deps.stderr)) writeClosing(deps.stderr, "Interrupted");
  });
  let steps: WireStep[];
  try {
    steps = await applyPlan(deps, plan, { progress });
    await remember();
    progress.stop();
  } catch (error) {
    progress.fail("Wiring failed");
    throw error;
  } finally {
    dispose();
  }
  return finish(plan, steps, options, "applied");
}

function failedInPlanning(planned: PlannedStep): boolean {
  return planned.action.kind === "none" && planned.action.state === "failed";
}

function failedNextSteps(plan: WirePlan, steps: WireStep[], rerun: string): string[] {
  const lines = [`Fix what failed, then run it again: ${rerun}`];
  // A platform that failed only for its own destination can be wired alone meanwhile.
  const failing = new Set(steps.filter((step) => step.state === "failed").map((step) => step.platform));
  const healthy = plan.platforms.filter((platform) => !failing.has(platform));
  if (!failing.has(undefined) && healthy.length > 0 && healthy.length < plan.platforms.length) {
    lines.push(
      `Or wire ${healthy.map((platform) => PLATFORM_NAMES[platform]).join(" and ")} alone for now: \`cmpatch wire ${healthy.map((platform) => `--platform ${platform}`).join(" ")}\``,
    );
  }
  return lines;
}

/** The planned changes as not made; the one reason they were not is the result's `notApplied`. */
function blocked(plan: WirePlan, state: "declined" | "deferred" = "deferred"): WireStep[] {
  return plan.steps.map((planned) => {
    const step = previewStep(planned);
    return hasWork(planned) ? { ...step, state } : step;
  });
}

async function askNativeProjects(deps: CommandDeps): Promise<"generated" | "maintained"> {
  const answer = await deps.prompt!({
    choices: [
      { title: "Generated — I run `expo prebuild` and do not edit ios/ and android/ by hand", value: "generated" },
      { title: "Maintained — ios/ and android/ are committed and edited directly", value: "maintained" },
    ],
    message: "How are the native projects managed?",
    type: "select",
  });
  return answer === "maintained" ? "maintained" : "generated";
}

/**
 * The ownership answer is kept in the project config so later runs do not
 * ask again; a project without a config file is not given one for it.
 */
async function rememberNativeProjects(projectRoot: string, answer: "generated" | "maintained"): Promise<void> {
  if (!(await isFile(resolveProjectConfigPath(projectRoot)))) return;
  const config = await loadProjectConfigFile(projectRoot);
  if (config.nativeProjects === answer) return;
  await saveProjectConfig(projectRoot, { ...config, nativeProjects: answer });
}

/**
 * A destination that points elsewhere is replaced only on an explicit
 * decision: a choice in the terminal, or `--replace-destination`. A blanket
 * `--yes` does not count, and without a decision the step fails.
 */
async function decideConflicts(
  deps: CommandDeps,
  plan: WirePlan,
  options: WireOptions,
  interactive: boolean,
): Promise<void> {
  for (const planned of plan.steps) {
    const conflict = planned.conflict;
    if (conflict === undefined) continue;
    const platform = planned.step.platform === undefined ? "The app" : PLATFORM_NAMES[planned.step.platform];
    const carrier = path.relative(plan.shape.root, conflict.carrier);
    const fields = [
      ["deployment key", "deploymentKey"],
      ["API URL", "apiUrl"],
      ["download URL", "downloadBaseUrl"],
    ] as const;
    const lines = [
      `${platform}: ${carrier}`,
      ...fields.map(
        ([label, field]) => `  ${label.padEnd(16)}${conflict.current[field] ?? "(missing)"}  →  ${conflict.selected[field]}`,
      ),
    ];
    let replace: boolean;
    if (options.replaceDestination) {
      replace = true;
    } else if (interactive && deps.stderr !== undefined) {
      writeNote(deps.stderr, "This platform already points at another destination", lines);
      const answer = await deps.prompt!({
        choices: [
          { title: "Replace the deployment key, API URL and download URL with the selected destination", value: "replace" },
          { title: "Keep the existing deployment key, API URL and download URL (missing values stay missing)", value: "keep" },
        ],
        message: `${platform}: which destination should the app use?`,
        type: "select",
      });
      replace = answer === "replace";
    } else {
      planned.action = { kind: "none", state: "failed" };
      planned.step.manual = [
        ...lines.slice(1),
        "Pass --replace-destination to use the selected destination, or run `cmpatch wire` without --yes to decide.",
      ];
      continue;
    }
    if (replace) {
      planned.step.detail = `${carrier}: ${REPLACED_DESTINATION} with ${conflict.selected.deploymentKey}`;
      planned.action = { kind: "edit", intents: [conflict.replacement] };
    } else {
      planned.action = { kind: "none", state: "preserved" };
      planned.step.detail = `${carrier} keeps its existing deployment key and URLs; nothing filled in`;
    }
    delete planned.conflict;
  }
}

/**
 * Resolve the optional command before the plan is shown, from the flags and
 * the mode. The one decision left open is an interactive run's question:
 * that step is returned, to be asked once the plan is confirmed.
 */
function decidePodInstall(
  plan: WirePlan,
  options: WireOptions,
  interactive: boolean,
): PlannedStep | undefined {
  const step = plan.steps.find((planned) => planned.step.id === "pod-install");
  if (step?.action.kind !== "command") return undefined;
  const action = step.action;
  const command = `\`${action.command.join(" ")}\``;
  if (options.podInstall === "ask" && interactive && !options.dryRun) {
    step.step.detail = `${command}, asked after you confirm`;
    return step;
  }
  // A dry run projects the question rather than asking it: the real run
  // would ask, with yes as the default.
  const run = options.podInstall === "run" || (options.podInstall === "ask" && interactive);
  if (run) {
    step.step.detail = options.dryRun && options.podInstall === "ask" ? `would ask to run ${command}` : `run ${command}`;
  } else {
    const why =
      options.podInstall === "skip"
        ? "--no-pod-install"
        : options.yes
          ? "pass --pod-install, or run without --yes to be asked"
          : "pass --pod-install to run it non-interactively";
    step.step.detail = `${action.detail} (not run: ${why})`;
  }
  action.decision = run ? "run" : "skip";
  return undefined;
}

async function askPodInstall(deps: CommandDeps, step: PlannedStep): Promise<void> {
  if (step.action.kind !== "command") return;
  const action = step.action;
  const command = `\`${action.command.join(" ")}\``;
  const run = await deps.confirm!({ initial: true, message: `Run ${command} after the changes are applied?` });
  step.step.detail = run ? `run ${command}` : `${action.detail} (not run: declined)`;
  action.decision = run ? "run" : "skip";
}

function finish(
  plan: WirePlan,
  steps: WireStep[],
  options: WireOptions,
  mode: Mode,
  notApplied?: string,
): WireResult {
  const result = aggregateOutcome(steps.map((step) => stepOutcome(step.state)));
  return {
    command: "wire",
    result,
    exitCode: WIRE_EXIT_CODES[result],
    dryRun: options.dryRun,
    project: summarizeProject(plan.shape, plan.platforms),
    destinations: plan.destinations,
    steps,
    ...(notApplied === undefined ? {} : { notApplied }),
    nextSteps: nextSteps(plan, steps, mode),
  };
}

type Mode = "applied" | "blocked" | "declined" | "dry-run" | "failed-plan";

function nextSteps(plan: WirePlan, steps: WireStep[], mode: Mode): string[] {
  // Nothing past a failure is worth doing yet: a build would ship without
  // what failed. Fixing it and running wire again is the one next step.
  // CocoaPods is the exception: its own command is the retry, and it has
  // its own next step below.
  const failed = steps.some((step) => step.state === "failed" && step.id !== "pod-install");
  if (failed) return failedNextSteps(plan, steps, mode === "dry-run" ? "`cmpatch wire --dry-run`" : "`cmpatch wire`");
  if (mode === "dry-run") return ["Apply this plan: `cmpatch wire`"];
  if (mode !== "applied") return ["Review and apply the plan: `cmpatch wire`"];
  const lines: string[] = [];
  // `steps` is `plan.steps` in the same order, as applied or previewed.
  // CocoaPods has its own next step.
  const left = plan.steps.filter(
    (planned, index) => planned.step.id !== "pod-install" && stepOutcome(steps[index]!.state) !== "complete",
  );
  // Work only doctor can see is confirmed by doctor up front, which also
  // stands in for the closing setup check.
  const doctorFirst = left.length > 0 && left.every((planned) => planned.confirmedByDoctorOnly === true);
  if (doctorFirst) {
    lines.push("Finish the steps left for you, then confirm them: `cmpatch doctor`");
  } else if (left.length > 0) {
    lines.push("Finish the steps left for you, then check them: `cmpatch wire`");
  }
  if (plan.shape.expoNative === "generated") {
    lines.push("Regenerate the native projects: `npx expo prebuild`");
    lines.push("Build the app with EAS or `npx expo run:ios` / `npx expo run:android`, so the SDK and its configuration ship in the binary.");
  } else {
    const pods = steps.find((step) => step.id === "pod-install");
    const action = plan.steps.find((planned) => planned.step.id === "pod-install")?.action;
    if (pods !== undefined && stepOutcome(pods.state) !== "complete") {
      if (action?.kind === "command") {
        lines.push(`Install the iOS pods: \`cd ${path.relative(plan.shape.root, action.cwd)} && ${action.command.join(" ")}\``);
      } else if (pods.manual?.[0] !== undefined) {
        // CocoaPods does not run on this OS; the command is for a Mac.
        lines.push(`Install the iOS pods on a Mac: \`${pods.manual[0]}\``);
      }
    }
    lines.push("Build a release binary, so the SDK and its configuration ship in the app.");
  }
  lines.push("Publish a first update: `cmpatch release-react --dry-run`, then `cmpatch release-react`");
  if (!doctorFirst) lines.push("Check the whole setup: `cmpatch doctor`");
  return lines;
}
