// The result contract of the SDK wiring operation shared by `cmpatch wire`
// and `cmpatch init`.

import type { NativePlatform } from "../projectAnalysis";
import type { PackageManagerKind, SdkDependency } from "./project";

export type WireOutcome = "complete" | "incomplete" | "failed";
export type WireExitCode = 0 | 1 | 2;

export const WIRE_EXIT_CODES: Record<WireOutcome, WireExitCode> = {
  complete: 0,
  failed: 1,
  incomplete: 2,
};

/** `failed > incomplete > complete`. */
export function aggregateOutcome(outcomes: readonly WireOutcome[]): WireOutcome {
  if (outcomes.includes("failed")) return "failed";
  if (outcomes.includes("incomplete")) return "incomplete";
  return "complete";
}

export type WireStepId =
  | "sdk-install"
  /** Deployment key, API URL and download URL for one platform, as a group. */
  | "destination"
  /** AppDelegate / MainApplication bundle selection for one platform. */
  | "native-hook"
  /** `Patch.wrap(App)` at the JavaScript root. */
  | "js-root"
  | "pod-install";

export type WireStepState =
  /** This run installed or edited something. */
  | "changed"
  /** Read back as correct; nothing to do. */
  | "already-configured"
  /** Not editable automatically; `manual` carries what to do. */
  | "manual"
  /** Blocked by a prerequisite that did not complete, or by an unresolved conflict. */
  | "deferred"
  /** The developer chose to keep a conflicting existing configuration group. */
  | "preserved"
  /** Deliberately not requested for this run, and not verified either. */
  | "skipped"
  /** The developer chose not to apply the plan. */
  | "declined"
  | "failed";

export function stepOutcome(state: WireStepState): WireOutcome {
  switch (state) {
    case "changed":
    case "already-configured":
      return "complete";
    case "failed":
      return "failed";
    default:
      return "incomplete";
  }
}

export type WireStep = {
  id: WireStepId;
  platform?: NativePlatform;
  title: string;
  state: WireStepState;
  detail: string;
  files?: string[];
  /** Instructions and snippets for the work this run could not do, or how to fix a failure. */
  manual?: string[];
  /** The last lines a failed command printed, as it printed them. */
  output?: string[];
};

/** Appended to the detail of every step the failed SDK install kept back. */
export const SDK_INSTALL_FAILED_NOTE = "the SDK install failed";

/** Whether the step was only kept back because the SDK install failed, not for a reason of its own. */
export function isBlockedByInstall(step: WireStep): boolean {
  return step.state === "deferred" && step.detail.endsWith(`: ${SDK_INSTALL_FAILED_NOTE})`);
}

export type WireDestination = {
  platform: NativePlatform;
  app: { id: string; name: string };
  deployment: { id: string; name: string };
  deploymentKey: string;
  apiUrl: string;
  downloadBaseUrl: string;
};

export type WireProjectSummary = {
  root: string;
  packageManager: PackageManagerKind;
  framework: "bare" | "expo";
  expoNative?: "generated" | "maintained";
  reactNativeVersion?: string;
  expoVersion?: string;
  platforms: NativePlatform[];
  sdk: SdkDependency;
};

export type WireResult = {
  command: "wire";
  result: WireOutcome;
  exitCode: WireExitCode;
  dryRun: boolean;
  project: WireProjectSummary;
  destinations: WireDestination[];
  steps: WireStep[];
  /** Why none of the planned changes were applied: declined, or blocked by a precondition. */
  notApplied?: string;
  /** What the developer does after this run: rebuild, prebuild, first OTA. Commands are in backticks. */
  nextSteps: string[];
};
