// Whether each native project runs the build metadata step the installed SDK
// defines (client/specs/build-integration/Spec.md). An SDK at 0.8.0 or later
// already moves release-time fingerprints onto its own engine, while a project
// that was never wired again builds without the record. Wire's own inspection
// decides here, so a warning is one `cmpatch wire` acts on.

import path from "node:path";

import { findIosRoot } from "../nativeProjectPaths";
import { BUILD_STEP_EDIT_NOTE, describeSandboxedTargets } from "../wire/buildStep";
import { inspectBuildStepFacts } from "../wire/inspect";
import { inspectProject, SDK_PACKAGE, type ProjectShape } from "../wire/project";
import type { DiscoveryFinding, Platform } from "./discovery";

const ID = "sdk-build-metadata";

export async function inspectBuildMetadataSteps(
  root: string,
  platforms: Platform[],
): Promise<Partial<Record<Platform, DiscoveryFinding>>> {
  let shape: ProjectShape;
  try {
    shape = await inspectProject(root);
  } catch {
    // No readable package.json; the project-package check reports it.
    return {};
  }
  const lookup = shape.buildIntegration;
  // Nothing to check without an SDK, or with one that predates the step: the
  // upgrade is optional, and sdk-dependency reports a missing SDK.
  if (shape.sdk.installedRoot === undefined || (lookup.kind === "unavailable" && lookup.predates === true)) {
    return {};
  }
  const sdk = `${SDK_PACKAGE}${shape.sdk.installedVersion === undefined ? "" : `@${shape.sdk.installedVersion}`}`;
  const remedy = shape.expoNative === "generated"
    ? "Run `npx expo prebuild` again; the SDK's config plugin adds the step."
    : `Run \`cmpatch wire\`; it adds or updates the step. ${BUILD_STEP_EDIT_NOTE}`;
  const iosRoot = await findIosRoot(shape.root);
  const findings: Partial<Record<Platform, DiscoveryFinding>> = {};
  for (const platform of platforms) {
    if (!shape.nativeDirectories[platform]) continue;
    if (lookup.kind === "unavailable") {
      findings[platform] = { id: ID, status: "skip", reason: "unresolved", detail: `The build metadata step was not checked: ${lookup.reason}.`, sources: [] };
      continue;
    }
    const facts = await inspectBuildStepFacts(shape, platform, iosRoot);
    if (facts.kind === "unresolved") {
      findings[platform] = { id: ID, status: "skip", reason: "unresolved", detail: `The build metadata step was not checked: ${facts.reason}.`, sources: [] };
      continue;
    }
    const name = path.basename(facts.file);
    const finding = facts.finding!;
    const report = (status: "pass" | "warn", detail: string, reason?: string, advice?: string[]): void => {
      findings[platform] = { id: ID, status, detail, sources: [facts.file], ...(reason ? { reason } : {}), ...(advice ? { advice } : {}) };
    };
    if (facts.sandboxed.length > 0) {
      report(
        "warn",
        `ENABLE_USER_SCRIPT_SANDBOXING = YES ${describeSandboxedTargets(facts.sandboxed)} makes the build metadata phase fail.`,
        "user_script_sandboxing",
        [
          `Set ENABLE_USER_SCRIPT_SANDBOXING (User Script Sandboxing) to NO for ${facts.sandboxed.length === 1 ? "the app target" : "those targets"} in Xcode.`,
          ...(finding.kind === "current" ? [] : [remedy]),
        ],
      );
      continue;
    }
    switch (finding.kind) {
      case "current":
        report("pass", `${name} runs the build metadata step of ${sdk}; no build was run to confirm it.`);
        break;
      case "absent":
        report(
          "warn",
          `${sdk} defines the build metadata step, but ${name} does not run it, so builds record no CodemagicPatchBuild.json.`,
          "build_metadata_step_missing",
          [remedy],
        );
        break;
      case "outdated":
        report("warn", `The build metadata step in ${name} differs from the one ${sdk} defines.`, "build_metadata_step_outdated", [remedy]);
        break;
      case "conflict":
        report(
          "warn",
          `${finding.reason[0]!.toUpperCase()}${finding.reason.slice(1)}.`,
          "build_metadata_step_conflict",
          finding.manual.length > 0 ? finding.manual : [remedy],
        );
        break;
    }
  }
  return findings;
}
