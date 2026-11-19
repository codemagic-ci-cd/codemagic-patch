// The wiring plan: what this run would install, edit, run and leave to the
// developer, computed before anything is touched. Discovery supplies the
// observed facts; policy decides between already configured, an edit it can
// make, and a manual instruction with the reason; a destination whose
// current values point elsewhere is a decision the plan carries unresolved
// until the developer (or an explicit flag) settles it.

import path from "node:path";

import type { NativePlatform } from "../projectAnalysis";
import {
  readExpoPluginEntry,
  renderExpoPluginSnippet,
  writeExpoPluginEntry,
  type ExpoPluginUpdates,
} from "./expoConfig";
import { BUILD_STEP_EDIT_NOTE, BUILD_STEP_NAME, BUNDLE_PHASE_NAME, describeSandboxedTargets, inspectBuildStep, type BuildIntegration } from "./buildStep";
import type { DestinationFailure } from "./destination";
import { readTextFile } from "./fs";
import { inspectPlanFacts, type BuildStepFacts, type PlanFacts, type NativeHookFacts } from "./inspect";
import type { JsRegistrationSite } from "./jsRoot";
import {
  ANDROID_STRINGS_FILE,
  compareDestination,
  DESTINATION_KEYS,
  readPlistDestination,
  readStringsDestination,
  stringsDestinationProblem,
  writePlistDestination,
  writeStringsDestination,
  type DestinationValues,
  type PartialDestination,
} from "./nativeConfig";
import type { HookTransform } from "./nativeHooks";
import type { IosDependencyManager } from "../nativeProjectPaths";
import {
  inspectProject,
  MIN_SWIFTPM_SDK_VERSION,
  SDK_INSTALL_RANGE,
  SDK_PACKAGE,
  type PackageManager,
  type ProjectShape,
} from "./project";
import type { WireDestination, WireStep, WireStepState } from "./types";

/** `snapshot` is the file as it was when planned; apply refuses a file that has moved on since. */
export type WriteIntent = { file: string; snapshot: string | null } & (
  | { kind: "plist"; values: DestinationValues }
  | { kind: "strings"; values: DestinationValues }
  | { kind: "expo-plugin"; platform: NativePlatform; values: DestinationValues }
  | { kind: "source"; contents: string }
  /**
   * The build metadata step, computed from the file as it is when written.
   * Without `definition` the text is the one the SDK installed by this run
   * defines, loaded from the project once installed.
   */
  | { kind: "build-step"; platform: NativePlatform; root: string; definition?: BuildIntegration }
);

export type DestinationConflict = {
  carrier: string;
  current: PartialDestination;
  selected: DestinationValues;
  /** The intent that applies the selected destination, should the developer choose it. */
  replacement: WriteIntent;
};

type UnchangedState = Exclude<WireStepState, "changed">;

export type PlannedAction =
  | { kind: "none"; state: UnchangedState }
  | { kind: "edit"; intents: [WriteIntent, ...WriteIntent[]] }
  | { kind: "command"; command: string[]; cwd: string; decision: "ask" | "run" | "skip"; detail: string };

export type PlannedStep = {
  step: Omit<WireStep, "state">;
  action: PlannedAction;
  /** Unresolved until the developer decides or `--replace-destination` does. */
  conflict?: DestinationConflict;
  /** Completed by the planned SDK install itself; nothing of its own to apply. */
  afterInstall?: true;
  /**
   * Set when the developer's finished work is invisible to wire itself — a
   * component wrapped where it is registered — so only doctor confirms it.
   */
  confirmedByDoctorOnly?: true;
};

export type WirePlan = {
  shape: ProjectShape;
  platforms: NativePlatform[];
  destinations: WireDestination[];
  steps: PlannedStep[];
  /** From the plan facts: set when iOS is selected and wire decides the iOS project's mode. */
  iosDependencyManager?: IosDependencyManager;
  /**
   * Set when the installed SDK predates the build metadata step and this run
   * installs no newer one: the plan has no `build-metadata` step, and the
   * optional upgrade that adds it is a next step instead.
   */
  buildMetadataUpgrade?: true;
};

export function hasWork(planned: PlannedStep): boolean {
  return planned.action.kind === "edit" || planned.afterInstall === true ||
    (planned.action.kind === "command" && planned.action.decision === "run");
}

export function plannedIntents(planned: PlannedStep): WriteIntent[] {
  return planned.action.kind === "edit" ? planned.action.intents : [];
}

/** Public dry-run/preview contract; a planned edit is not an execution result. */
export function previewStep(planned: PlannedStep): WireStep {
  const { step, action } = planned;
  const state = hasWork(planned) ? "changed" : action.kind === "none" ? action.state : "skipped";
  return { ...step, state };
}

export type PlanInput = {
  shape: ProjectShape;
  /** The platforms this run wires. */
  platforms: NativePlatform[];
  /** Every platform the project is linked for; a root shared with an unselected, conflicted one is still deferred. */
  linkedPlatforms: NativePlatform[];
  destinations: WireDestination[];
  destinationFailures: DestinationFailure[];
  skipJs: boolean;
  /** `process.platform`, for the CocoaPods decision. */
  os: string;
};

export async function buildPlan(input: PlanInput): Promise<WirePlan> {
  return createPlan(input, await inspectPlanFacts(input));
}

/** Policy only: no filesystem, server calls, or changes to the observed facts. */
export function createPlan(input: PlanInput, facts: PlanFacts): WirePlan {
  const { shape, platforms } = input;
  const steps: PlannedStep[] = [];
  const install = planInstall(shape, facts.iosDependencyManager);
  steps.push(install.step);
  // Bundle ownership also matters on linked platforms not selected for edits.
  const conflicted = new Set([...input.linkedPlatforms, ...platforms].filter((platform) => {
    const hook = facts.hooks[platform];
    return hook?.kind === "source" && hook.result.kind === "manual" && hook.result.otaSymbol !== undefined;
  }));
  const { iosRoot } = facts;
  let buildMetadataUpgrade = false;

  for (const platform of platforms) {
    const destination = input.destinations.find((item) => item.platform === platform);
    const failure = input.destinationFailures.find((item) => item.platform === platform);
    const selected =
      destination === undefined
        ? undefined
        : {
            apiUrl: destination.apiUrl,
            deploymentKey: destination.deploymentKey,
            downloadBaseUrl: destination.downloadBaseUrl,
          };
    const hasNativeDirectory = shape.nativeDirectories[platform];

    if (selected === undefined) {
      steps.push(
        planStep("destination", platform, "failed", failure?.reason ?? "no destination", failure === undefined ? undefined : [failure.hint]),
      );
    } else if (shape.expoNative === "generated") {
      steps.push(planExpoDestination(shape, platform, selected, facts.expoConfigText));
    } else if (!hasNativeDirectory) {
      steps.push(
        planStep("destination", platform, "manual", `no ${platform} directory in the project`, [
          `Add the values to the ${platform} app configuration once the native project exists:`,
          ...renderDestinationLines(selected),
        ]),
      );
    } else if (platform === "ios") {
      steps.push(planIosDestination(facts.iosDestination, selected));
    } else {
      steps.push(planAndroidDestination(shape, selected, facts.androidDestination));
    }

    // The native hook does not depend on the destination values, and a
    // failed destination lookup must not hide another OTA system in the
    // host: that conflict also defers the JavaScript root this platform
    // shares, so its observed hook is considered either way.
    if (shape.expoNative !== "generated") {
      steps.push(
        hasNativeDirectory
          ? planNativeHook(platform, facts.hooks[platform]!)
          : planStep("native-hook", platform, "manual", `no ${platform} directory in the project`),
      );
    }
    const buildStep = planBuildStep(shape, platform, facts.buildSteps[platform], hasWork(install.step));
    if (buildStep !== undefined) steps.push(buildStep);
    else buildMetadataUpgrade = true;
  }

  if (expoUpdatesActive(shape)) {
    // Nothing in the native sources names expo-updates; the dependency and
    // the Expo config do. Its bundle ownership defers the same steps a
    // detected symbol would.
    const blockedId = shape.expoNative === "generated" ? "destination" : "native-hook";
    for (const platform of input.linkedPlatforms) conflicted.add(platform);
    for (const planned of steps) {
      if (planned.step.id !== blockedId || (planned.action.kind === "none" && (planned.action.state === "failed" || planned.action.state === "manual"))) continue;
      planned.action = { kind: "none", state: "deferred" };
      planned.step.detail = "expo-updates is active in this project; two update systems cannot own the same bundle";
      delete planned.conflict;
    }
  }

  steps.push(...planJsRoot(shape, platforms, facts, conflicted, input.skipJs, install.supportsWrapAfter));

  const podInstall =
    platforms.includes("ios") &&
    shape.expoNative !== "generated" &&
    facts.iosDependencyManager !== "swiftpm" &&
    facts.pods !== undefined
      ? planPodInstall(shape, iosRoot, hasWork(install.step), input.os, facts.pods)
      : undefined;
  if (podInstall !== undefined) steps.push(podInstall);

  return {
    shape,
    platforms,
    destinations: input.destinations,
    steps,
    ...(buildMetadataUpgrade ? { buildMetadataUpgrade: true as const } : {}),
    ...(facts.iosDependencyManager === undefined ? {} : { iosDependencyManager: facts.iosDependencyManager }),
  };
}

function planStep(
  id: WireStep["id"],
  platform: NativePlatform | undefined,
  action: UnchangedState | PlannedAction,
  detail: string,
  manual?: string[],
  files?: string[],
): PlannedStep {
  return {
    step: {
      id,
      ...(platform !== undefined ? { platform } : {}),
      title: stepTitle(id, platform),
      detail,
      ...(files !== undefined ? { files } : {}),
      ...(manual !== undefined ? { manual } : {}),
    },
    action: typeof action === "string" ? { kind: "none", state: action } : action,
  };
}

export function stepTitle(id: WireStep["id"], platform?: NativePlatform): string {
  const prefix = platform === undefined ? "" : `${platform}: `;
  switch (id) {
    case "sdk-install":
      return "SDK package";
    case "destination":
      return `${prefix}deployment key and URLs`;
    case "native-hook":
      return `${prefix}native bundle selection`;
    case "js-root":
      return `${prefix}Patch.wrap at the JavaScript root`;
    case "pod-install":
      return "CocoaPods";
    case "build-metadata":
      return `${prefix}build metadata step`;
  }
}

// --- SDK package -----------------------------------------------------------

function planInstall(shape: ProjectShape, iosDependencyManager?: IosDependencyManager): {
  step: PlannedStep;
  /** Whether Patch.wrap can be generated once this run's install step has succeeded. */
  supportsWrapAfter: boolean;
} {
  const { sdk, packageManager } = shape;
  // React Native's SwiftPM mode links the SDK through its Package.swift; an
  // installed SDK without one (before MIN_SWIFTPM_SDK_VERSION) cannot be linked.
  const swiftPM = iosDependencyManager === "swiftpm";
  if (swiftPM && sdk.kind === "local" && sdk.installedRoot !== undefined && !sdk.supportsSwiftPM) {
    return {
      step: planStep(
        "sdk-install",
        undefined,
        "manual",
        `${sdk.declared} is kept as declared; it has no Package.swift, so React Native's SwiftPM mode cannot link it`,
        [`Point ${sdk.declared} at an SDK with Package.swift (${MIN_SWIFTPM_SDK_VERSION} or later),`, "then run `cmpatch wire` again."],
      ),
      supportsWrapAfter: sdk.supportsWrap,
    };
  }
  if (sdk.kind === "local") {
    return {
      step: planStep(
        "sdk-install",
        undefined,
        "already-configured",
        `${sdk.declared} is kept as declared${sdk.supportsWrap ? "" : "; it does not export wrap, so the JavaScript root is left to you"}`,
      ),
      supportsWrapAfter: sdk.supportsWrap,
    };
  }
  // A version that only resolves from a parent directory (a hoisted workspace
  // install) is not the app's own dependency: autolinking reads the app's
  // package.json, so the app must declare the SDK itself.
  // An SDK that predates the build metadata step is not upgraded for it:
  // the upgrade changes native code and the project's fingerprint, and the
  // step is optional (the plan's `buildMetadataUpgrade`).
  if (sdk.kind === "registry" && sdk.installedVersion !== undefined && sdk.supportsWrap && (!swiftPM || sdk.supportsSwiftPM)) {
    return {
      step: planStep("sdk-install", undefined, "already-configured", `${SDK_PACKAGE}@${sdk.installedVersion} is installed`),
      supportsWrapAfter: true,
    };
  }
  const command = installCommand(packageManager, shape.root);
  const detail =
    sdk.kind === "absent"
      ? sdk.installedVersion === undefined
        ? `install ${SDK_PACKAGE}@${SDK_INSTALL_RANGE}`
        : `install ${SDK_PACKAGE}@${SDK_INSTALL_RANGE} (${sdk.installedVersion} resolves from a parent directory but the app does not declare it)`
      : sdk.installedVersion === undefined
        ? `install ${SDK_PACKAGE}@${SDK_INSTALL_RANGE} (declared as ${sdk.declared} but not installed)`
        : swiftPM && !sdk.supportsSwiftPM
          ? `upgrade ${SDK_PACKAGE} from ${sdk.installedVersion} to ${SDK_INSTALL_RANGE} for React Native's SwiftPM mode`
          : `upgrade ${SDK_PACKAGE} from ${sdk.installedVersion} to ${SDK_INSTALL_RANGE} for Patch.wrap`;
  if (packageManager.pnp) {
    return {
      step: planStep("sdk-install", undefined, "manual", `${detail} (Yarn Plug'n'Play installs are not run by wire)`, [
        `Run: ${command.command.join(" ")}`,
        "then run `cmpatch wire` again.",
      ]),
      supportsWrapAfter: false,
    };
  }
  return {
    step: planStep("sdk-install", undefined, { kind: "command", ...command, detail, decision: "run" }, `${detail} with ${packageManager.kind}`),
    supportsWrapAfter: true,
  };
}

function installCommand(manager: PackageManager, root: string): { command: string[]; cwd: string } {
  const spec = `${SDK_PACKAGE}@${SDK_INSTALL_RANGE}`;
  switch (manager.kind) {
    case "yarn":
      return { command: ["yarn", "add", spec], cwd: root };
    case "pnpm":
      return { command: ["pnpm", "add", spec], cwd: root };
    case "bun":
      return { command: ["bun", "add", spec], cwd: root };
    case "npm":
      return manager.workspaceRoot === undefined
        ? { command: ["npm", "install", spec], cwd: root }
        : {
            command: ["npm", "install", spec, "-w", path.relative(manager.workspaceRoot, root)],
            cwd: manager.workspaceRoot,
          };
  }
}

// --- Destinations ----------------------------------------------------------

function renderDestinationLines(values: DestinationValues): string[] {
  return [
    `${DESTINATION_KEYS.deploymentKey} = ${values.deploymentKey}`,
    `${DESTINATION_KEYS.apiUrl} = ${values.apiUrl}`,
    `${DESTINATION_KEYS.downloadBaseUrl} = ${values.downloadBaseUrl}`,
  ];
}

function destinationStep(
  platform: NativePlatform,
  carrier: string,
  current: PartialDestination,
  selected: DestinationValues,
  replacement: WriteIntent,
): PlannedStep {
  const comparison = compareDestination(current, selected);
  switch (comparison.kind) {
    case "complete":
      return planStep("destination", platform, "already-configured", `${path.basename(carrier)} already carries the selected destination`, undefined, [carrier]);
    case "fill":
      return planStep("destination", platform, { kind: "edit", intents: [replacement] }, `${comparison.missing.map((f) => DESTINATION_KEYS[f]).join(", ")} → ${path.basename(carrier)}`, undefined, [carrier]);
    case "unresolved":
      return planStep(
        "destination",
        platform,
        "manual",
        `${DESTINATION_KEYS[comparison.field]} is a build-time value (${comparison.value}) that wire cannot compare`,
        [`Set the build-time value for ${DESTINATION_KEYS[comparison.field]} to ${selected[comparison.field]}, or replace it with the literal.`],
        [carrier],
      );
    case "conflict":
      return {
        ...planStep(
          "destination",
          platform,
          "deferred",
          `${path.basename(carrier)} points at another destination (${comparison.differing.map((f) => DESTINATION_KEYS[f]).join(", ")} ${comparison.differing.length === 1 ? "differs" : "differ"})`,
          undefined,
          [carrier],
        ),
        conflict: { carrier, current, selected, replacement },
      };
  }
}

function planIosDestination(facts: PlanFacts["iosDestination"], selected: DestinationValues): PlannedStep {
  const { target, text } = facts!;
  if (target.kind === "unresolved") {
    return planStep("destination", "ios", "manual", target.reason, [
      "Add to the application target's Info.plist:",
      ...renderDestinationLines(selected),
    ]);
  }
  const current = text === null ? null : readPlistDestination(text);
  if (current === null) {
    return planStep("destination", "ios", "manual", `${target.plist} could not be parsed`, [
      "Add to the application target's Info.plist:",
      ...renderDestinationLines(selected),
    ]);
  }
  return destinationStep("ios", target.plist, current, selected, {
    kind: "plist",
    file: target.plist,
    snapshot: text,
    values: selected,
  });
}

function planAndroidDestination(shape: ProjectShape, selected: DestinationValues, facts: PlanFacts["androidDestination"]): PlannedStep {
  const { overrides, text } = facts!;
  const file = path.join(shape.root, ANDROID_STRINGS_FILE);
  if (overrides.length > 0) {
    return planStep(
      "destination",
      "android",
      "manual",
      "the destination resources are also defined outside main/values/strings.xml",
      [
        "Reconcile these sources, then add or verify the values:",
        ...overrides.map((source) => `  ${path.relative(shape.root, source)}`),
        ...renderDestinationLines(selected),
      ],
      overrides,
    );
  }
  const current = text === null ? {} : readStringsDestination(text);
  if (current === null) {
    return planStep("destination", "android", "manual", `${file} ${stringsDestinationProblem(text!)}`, [
      "Add to android/app/src/main/res/values/strings.xml:",
      ...renderDestinationLines(selected),
    ]);
  }
  return destinationStep("android", file, current, selected, {
    kind: "strings",
    file,
    snapshot: text,
    values: selected,
  });
}

function planExpoDestination(
  shape: ProjectShape,
  platform: NativePlatform,
  selected: DestinationValues,
  snapshot: string | null,
): PlannedStep {
  const snippet = [
    `Add this entry to the "plugins" array of your Expo config:`,
    ...renderExpoPluginSnippet({ [platform]: selected }),
  ];
  if (shape.expoConfigDynamic) {
    return planStep("destination", platform, "manual", "the Expo config is dynamic (app.config.js/ts); wire only edits static config", snippet);
  }
  if (shape.expoConfig === undefined) {
    return planStep("destination", platform, "manual", "no app.json or app.config.json was found", snippet);
  }
  const entry = readExpoPluginEntry(shape.expoConfig.data);
  if (entry.kind === "duplicate") {
    return planStep("destination", platform, "manual", "the Patch plugin is listed more than once in the Expo config", [
      "Keep one entry and put the platform blocks there:",
      ...renderExpoPluginSnippet({ [platform]: selected }),
    ], [shape.expoConfig.file]);
  }
  const current = entry.kind === "present" ? (entry.blocks[platform] ?? {}) : {};
  return destinationStep(platform, shape.expoConfig.file, current, selected, {
    kind: "expo-plugin",
    file: shape.expoConfig.file,
    snapshot,
    platform,
    values: selected,
  });
}

/** `expo-updates` declared and not switched off in the Expo config. */
function expoUpdatesActive(shape: ProjectShape): boolean {
  if (!shape.otherOtaPackages.includes("expo-updates")) return false;
  const section = shape.expoConfig?.data;
  const expo = section !== undefined && typeof section.expo === "object" && section.expo !== null ? (section.expo as Record<string, unknown>) : section;
  const updates = expo?.updates;
  return !(typeof updates === "object" && updates !== null && (updates as Record<string, unknown>).enabled === false);
}

// --- Native hooks ----------------------------------------------------------

function hookStep(
  platform: NativePlatform,
  file: string,
  snapshot: string,
  result: HookTransform,
  manual: string[],
): PlannedStep {
  switch (result.kind) {
    case "already-configured":
      return planStep("native-hook", platform, "already-configured", `${path.basename(file)} already selects the Patch bundle`, undefined, [file]);
    case "changed":
      return planStep("native-hook", platform, { kind: "edit", intents: [{ kind: "source", file, snapshot, contents: result.contents }] }, `${path.basename(file)} → prefer the Patch bundle, embedded bundle as fallback`, undefined, [file]);
    case "manual":
      return planStep("native-hook", platform, result.otaSymbol === undefined ? "manual" : "deferred", result.reason, manual, [file]);
  }
}

const IOS_HOOK_MANUAL = [
  "Where the app delegate (the scene delegate from React Native 0.88) returns the release bundle, prefer the Patch bundle:",
  "  Swift:       CodemagicPatch.bundleURL() ?? Bundle.main.url(forResource: \"main\", withExtension: \"jsbundle\")",
  "  Objective-C: [CodemagicPatch bundleURL] ?: [[NSBundle mainBundle] URLForResource:@\"main\" withExtension:@\"jsbundle\"]",
  "and import CodemagicPatchClient (Swift) or forward-declare the class (Objective-C).",
];
const ANDROID_HOOK_MANUAL = [
  "In MainApplication, hand the Patch bundle to React Native:",
  "  ReactNativeHost:   override fun getJSBundleFile(): String? = CodemagicPatch.getJSBundleFile(applicationContext)",
  "  getDefaultReactHost: jsBundleFilePath = CodemagicPatch.getJSBundleFile(applicationContext),",
  "and import io.codemagic.patch.CodemagicPatch.",
];

function planNativeHook(platform: NativePlatform, facts: NativeHookFacts): PlannedStep {
  const manual = platform === "ios" ? IOS_HOOK_MANUAL : ANDROID_HOOK_MANUAL;
  if (facts.kind === "unresolved") {
    return planStep("native-hook", platform, "manual", facts.reason, manual);
  }
  return hookStep(platform, facts.file, facts.text, facts.result, manual);
}

// --- Build metadata step ---------------------------------------------------

function planBuildStep(
  shape: ProjectShape,
  platform: NativePlatform,
  facts: BuildStepFacts | undefined,
  installPlanned: boolean,
): PlannedStep | undefined {
  const lookup = shape.buildIntegration;
  // An SDK without the step gets no row: an optional upgrade is a next step, not work left.
  if (!installPlanned && lookup.kind === "unavailable" && lookup.predates === true) return undefined;
  const sdk = `${SDK_PACKAGE}@${shape.sdk.installedVersion ?? shape.sdk.declared ?? "?"}`;
  // Generated native projects get the step from the SDK's config plugin at prebuild.
  if (shape.expoNative === "generated") {
    if (installPlanned) {
      return {
        ...planStep("build-metadata", platform, "deferred", `the config plugin of ${SDK_PACKAGE}@${SDK_INSTALL_RANGE}, installed by this run, adds it at the next \`npx expo prebuild\``),
        afterInstall: true,
      };
    }
    if (lookup.kind !== "available") {
      return planStep("build-metadata", platform, "manual", lookup.reason, ["Once that is resolved, run `npx expo prebuild` again; the SDK's config plugin adds the step."]);
    }
    // Native directories from an earlier prebuild lack the step until the next one.
    const observed = facts?.kind === "source" ? facts.finding?.kind : undefined;
    if (facts?.kind === "source" && (observed === "absent" || observed === "outdated")) {
      const planned = planStep(
        "build-metadata",
        platform,
        "already-configured",
        `${path.basename(facts.file)} ${observed === "absent" ? "does not run the step yet" : "runs an older step"}; the config plugin of ${sdk} ${observed === "absent" ? "adds" : "updates"} it at the next \`npx expo prebuild\``,
      );
      return { ...planned, step: { ...planned.step, observed } };
    }
    return planStep("build-metadata", platform, "already-configured", `the config plugin of ${sdk} adds it at \`npx expo prebuild\``);
  }
  if (!shape.nativeDirectories[platform]) {
    return planStep("build-metadata", platform, "manual", `no ${platform} directory in the project`);
  }
  if (facts === undefined || facts.kind === "unresolved") {
    return planStep("build-metadata", platform, "manual", facts?.reason ?? `the ${platform} project could not be inspected`, [
      platform === "ios"
        ? `Add the "${BUILD_STEP_NAME}" run-script phase yourself to each app target that has a "${BUNDLE_PHASE_NAME}" phase, directly after that phase.`
        : "Add the build metadata line to the app module's build script yourself, as its last line.",
    ]);
  }
  const { file, text, sandboxed } = facts;
  const name = path.basename(file);
  if (sandboxed.length > 0) {
    return planStep(
      "build-metadata",
      platform,
      "manual",
      `ENABLE_USER_SCRIPT_SANDBOXING = YES ${describeSandboxedTargets(sandboxed)} makes the build metadata phase fail${facts.finding?.kind === "current" ? "" : "; wire adds the phase once the setting is NO"}`,
      [`Set ENABLE_USER_SCRIPT_SANDBOXING (User Script Sandboxing) to NO for ${sandboxed.length === 1 ? "the app target" : "those targets"} in Xcode, then run \`cmpatch wire\` again.`],
      [file],
    );
  }
  const where = { platform, file };
  // The text comes from the SDK this run installs, so it is computed from that SDK once installed.
  if (installPlanned) {
    return planStep(
      "build-metadata",
      platform,
      { kind: "edit", intents: [{ kind: "build-step", snapshot: text, ...where, root: shape.root }] },
      `${name} → add or update the build metadata step from ${SDK_PACKAGE}@${SDK_INSTALL_RANGE}, installed by this run`,
      undefined,
      [file],
    );
  }
  // Left here: an SDK that is not installed, or whose definition this cmpatch cannot read.
  if (lookup.kind === "unavailable") {
    return planStep("build-metadata", platform, "manual", lookup.reason, ["Once that is resolved, run `cmpatch wire` again."], [file]);
  }
  const finding = facts.finding!;
  const step = (...args: Parameters<typeof planStep>): PlannedStep => {
    const planned = planStep(...args);
    return { ...planned, step: { ...planned.step, observed: finding.kind } };
  };
  switch (finding.kind) {
    case "conflict":
      return step("build-metadata", platform, "manual", finding.reason, finding.manual.length > 0 ? finding.manual : undefined, [file]);
    case "current":
      return step("build-metadata", platform, "already-configured", `${name} already runs the build metadata step of ${sdk}`, undefined, [file]);
    case "absent":
    case "outdated":
      return step(
        "build-metadata",
        platform,
        { kind: "edit", intents: [{ kind: "build-step", snapshot: text, ...where, root: shape.root, definition: lookup.definition }] },
        `${name} → ${finding.kind === "outdated" ? "update the build metadata step in place to the text" : "add the build metadata step"} of ${sdk}${(finding.targets?.length ?? 0) > 1 ? ` (targets ${finding.targets!.join(", ")})` : ""}. ${BUILD_STEP_EDIT_NOTE}`,
        undefined,
        [file],
      );
  }
}

// --- JavaScript root -------------------------------------------------------

const JS_ROOT_MOUNT_NOTES = [
  "Mounting the wrapped root acknowledges the running bundle as healthy and starts an update check.",
  "Apps that must finish an asynchronous bootstrap first should call sync() or notifyAppReady() themselves at that point instead.",
];

/** For a root whose default export is the place to wrap. */
const JS_ROOT_MANUAL = [
  "Export the root component through the SDK wrapper:",
  "  import * as Patch from \"@codemagic/react-native-patch\";",
  "  export default Patch.wrap(App);",
  ...JS_ROOT_MOUNT_NOTES,
];

/**
 * For an entry whose registration call is the place to wrap: changing a
 * default export there would leave `AppRegistry` mounting the bare
 * component. The resolver cannot follow a locally wrapped registration
 * either, so the step stays manual after the edit; doctor's
 * `sdk-update-flow` check is what confirms it.
 */
function jsRegistrationManual(root: string, site: JsRegistrationSite): string[] {
  const component = site.component ?? "App";
  const wrapped = `Wrapped${component}`;
  const registration =
    site.api === "registerRootComponent"
      ? `registerRootComponent(${wrapped});`
      : `AppRegistry.registerComponent(${JSON.stringify(site.appName ?? "<name>")}, () => ${wrapped});`;
  return [
    `Wrap the component where it is registered, in ${path.relative(root, site.file)}:`,
    "  import * as Patch from \"@codemagic/react-native-patch\";",
    `  const ${wrapped} = Patch.wrap(${component});`,
    `  ${registration}`,
    ...JS_ROOT_MOUNT_NOTES,
    "Then confirm it with `cmpatch doctor`: `cmpatch wire` cannot see a wrapped registration, so it keeps listing this step.",
  ];
}

function planJsRoot(
  shape: ProjectShape,
  platforms: NativePlatform[],
  facts: PlanFacts,
  conflicted: Set<NativePlatform>,
  skipJs: boolean,
  supportsWrap: boolean,
): PlannedStep[] {
  const roots = facts.jsRoots;
  const steps: PlannedStep[] = [];
  // One entry file usually serves both platforms: the same instruction is
  // one step, not one per platform.
  const unresolved = new Map<string, { platforms: NativePlatform[]; reason: string; manual: string[]; file?: string; atRegistration: boolean }>();
  for (const { platform, resolution } of facts.unresolvedJsRoots) {
    if (!platforms.includes(platform)) continue;
    const manual = resolution.registration === undefined
      ? JS_ROOT_MANUAL
      : jsRegistrationManual(shape.root, resolution.registration);
    const key = JSON.stringify([resolution.reason, manual]);
    const existing = unresolved.get(key);
    if (existing !== undefined) existing.platforms.push(platform);
    else unresolved.set(key, {
      platforms: [platform],
      reason: resolution.reason,
      manual,
      file: resolution.registration?.file,
      atRegistration: resolution.registration !== undefined,
    });
  }
  for (const { platforms: covered, reason, manual, file, atRegistration } of unresolved.values()) {
    const step = planStep(
      "js-root",
      covered.length === 1 ? covered[0] : undefined,
      skipJs ? "skipped" : "manual",
      reason,
      manual,
      file === undefined ? undefined : [file],
    );
    steps.push(atRegistration && !skipJs ? { ...step, confirmedByDoctorOnly: true } : step);
  }
  for (const [file, { platforms: covered, via, text, result, graph }] of roots) {
    if (!covered.some((platform) => platforms.includes(platform))) continue;
    const label = roots.size > 1 ? ` (${covered.join(", ")})` : "";
    const step = (action: UnchangedState | PlannedAction, detail: string, manual?: string[]) =>
      planStep("js-root", covered.length === 1 ? covered[0] : undefined, action, `${path.relative(shape.root, file)}${label}: ${detail}`, manual, [file]);
    if (result.kind === "already-configured") {
      steps.push(step("already-configured", "already exported through Patch.wrap"));
      continue;
    }
    if (result.kind === "existing-integration") {
      steps.push(
        step("manual", `keeps its own ${result.detail} startup integration; verify it confirms readiness and checks for updates on every start`),
      );
      continue;
    }
    // The root module is not the only place the developer may have wired
    // the SDK: a startup call after their own bootstrap lives wherever the
    // entry imports it, and wrapping the root would pre-empt it.
    const [startup] = graph.startup;
    if (startup !== undefined) {
      steps.push(
        step("manual", `keeps its own ${startup.method}() startup integration in ${path.relative(shape.root, startup.file)}; verify it confirms readiness and checks for updates on every start`),
      );
      continue;
    }
    const [wrapped] = graph.wrap;
    if (wrapped !== undefined) {
      steps.push(
        step("manual", `Patch.wrap is already applied in ${path.relative(shape.root, wrapped.file)}; keep one wrapped root and verify it mounts on every start`),
      );
      continue;
    }
    if (skipJs) {
      steps.push(step("skipped", "JavaScript wiring skipped (--skip-js); no startup integration was verified"));
      continue;
    }
    const blocked = covered.find((platform) => conflicted.has(platform));
    if (blocked !== undefined) {
      steps.push(step("deferred", `the ${blocked} native integration is deferred by another OTA system, and this root serves ${blocked} too`, JS_ROOT_MANUAL));
      continue;
    }
    if (!supportsWrap) {
      steps.push(step("manual", "the installed SDK does not export wrap; upgrade it to 0.5.0 or later first", JS_ROOT_MANUAL));
      continue;
    }
    if (result.kind === "manual") {
      steps.push(step("manual", result.reason, result.exportExpression === undefined ? JS_ROOT_MANUAL : [
        "Preserve the existing wrapper when exporting the root through the SDK:",
        '  import * as Patch from "@codemagic/react-native-patch";',
        `  export default Patch.wrap(${result.exportExpression});`,
        ...JS_ROOT_MOUNT_NOTES,
      ]));
      continue;
    }
    if (graph.limited) {
      steps.push(step("manual", "startup discovery was incomplete; verify existing readiness handling before adding Patch.wrap", JS_ROOT_MANUAL));
      continue;
    }
    steps.push(step({ kind: "edit", intents: [{ kind: "source", file, snapshot: text, contents: result.contents }] }, `export default Patch.wrap(...) (root found via ${via})`));
  }
  return steps;
}

// --- CocoaPods -------------------------------------------------------------

function planPodInstall(
  shape: ProjectShape,
  iosRoot: string,
  installPlanned: boolean,
  os: string,
  { lock, bundler }: NonNullable<PlanFacts["pods"]>,
): PlannedStep {
  // The lock names the pod's version, and the lock is a fingerprint input: one
  // left behind by an SDK upgrade builds, and then changes the fingerprint on
  // whichever machine runs `pod install` next.
  const locked = lock === null ? undefined : /^\s*- CodemagicPatchClient \(([^)]+)\)/m.exec(lock)?.[1];
  const installed = shape.sdk.installedVersion;
  const stale = locked !== undefined && installed !== undefined && locked !== installed;
  if (!installPlanned && !stale && lock !== null && lock.includes("CodemagicPatchClient")) {
    return planStep("pod-install", "ios", "already-configured", "Podfile.lock already integrates CodemagicPatchClient");
  }
  const command = bundler ? ["bundle", "exec", "pod", "install"] : ["pod", "install"];
  const manual = [`cd ${path.relative(shape.root, iosRoot) || "ios"} && ${command.join(" ")}`];
  if (os !== "darwin") {
    return planStep("pod-install", "ios", "skipped", `CocoaPods is not available on ${os}; run it on macOS`, manual);
  }
  const why = stale && !installPlanned ? ` (Podfile.lock has CodemagicPatchClient ${locked}, the installed SDK is ${installed})` : "";
  const detail = `\`${command.join(" ")}\` in ${path.relative(shape.root, iosRoot) || "ios"}${why}`;
  return planStep("pod-install", "ios", { kind: "command", command, cwd: iosRoot, decision: "ask", detail }, detail, manual);
}

// --- Materialising writes --------------------------------------------------

export type PlannedWrite = { file: string; before: string | null; after: string };

/**
 * The file contents the plan's intents produce, one write per file, read
 * from the project as it is now. Intents for the same file compose in
 * order, which is how both platforms' plugin blocks land in one app.json.
 * A file whose edit cannot be produced is reported, not thrown, so the
 * other files still get theirs.
 */
export async function materializeWrites(
  steps: PlannedStep[],
): Promise<{ writes: PlannedWrite[]; failures: Map<string, string> }> {
  const writes = new Map<string, PlannedWrite>();
  const failures = new Map<string, string>();
  for (const planned of steps) {
    for (const intent of plannedIntents(planned)) {
      if (failures.has(intent.file)) continue;
      const existing = writes.get(intent.file);
      const before = existing === undefined ? await readTextFile(intent.file) : existing.before;
      const base = existing === undefined ? before : existing.after;
      try {
        writes.set(intent.file, { file: intent.file, before, after: await applyIntent(intent, base) });
      } catch (error) {
        writes.delete(intent.file);
        failures.set(intent.file, error instanceof Error ? error.message : String(error));
      }
    }
  }
  return { writes: [...writes.values()], failures };
}

async function applyIntent(intent: WriteIntent, text: string | null): Promise<string> {
  switch (intent.kind) {
    case "plist":
      if (text === null) throw new Error(`${intent.file} does not exist`);
      return writePlistDestination(text, intent.values);
    case "strings":
      return writeStringsDestination(text, intent.values);
    case "expo-plugin":
      if (text === null) throw new Error(`${intent.file} does not exist`);
      return writeExpoPluginEntry(text, { [intent.platform]: intent.values } as ExpoPluginUpdates);
    case "source":
      return intent.contents;
    case "build-step": {
      if (text === null) throw new Error(`${intent.file} does not exist`);
      const finding = inspectBuildStep(intent, text, await buildStepDefinition(intent));
      if (finding.kind === "conflict") throw new Error(finding.reason);
      return finding.kind === "current" ? text : finding.contents;
    }
  }
}

/** The definition the intent was planned with, or the one of the SDK this run installed. */
export async function buildStepDefinition(intent: Extract<WriteIntent, { kind: "build-step" }>): Promise<BuildIntegration> {
  if (intent.definition !== undefined) return intent.definition;
  const lookup = (await inspectProject(intent.root)).buildIntegration;
  if (lookup.kind === "unavailable") throw new Error(`${lookup.reason}; the step's text comes from the SDK this run installs`);
  return lookup.definition;
}
