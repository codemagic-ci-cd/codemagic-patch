// Collect file discovery and source analysis once; planning consumes these
// facts without reading files or depending on destination lookup success.
import path from "node:path";

import { discoverIosTargets } from "../doctor/iosTargets";
import { readDoctorSource } from "../doctor/discovery";
import { detectIosDependencyManager, findIosRoot, type IosDependencyManager } from "../nativeProjectPaths";
import type { NativePlatform } from "../projectAnalysis";
import { inspectBuildStep, xcodeSandboxedTargets, type BuildStepFinding, type SandboxedTarget } from "./buildStep";
import { isFile, readTextFile } from "./fs";
import {
  inspectGraphCalls, resolveJsRoot, transformJsRoot,
  type GraphCalls, type JsRootResolution, type RootTransform,
} from "./jsRoot";
import {
  ANDROID_STRINGS_FILE, findAndroidResourceOverrides, locateIosAppTarget,
  type IosAppTarget,
} from "./nativeConfig";
import {
  locateAndroidMainApplication, locateIosAppDelegate,
  transformAndroidMainApplication, transformIosAppDelegate,
  type HookTransform,
} from "./nativeHooks";
import type { ProjectShape } from "./project";

export type NativeHookFacts =
  | { kind: "unresolved"; reason: string }
  | { kind: "source"; file: string; text: string; result: HookTransform };

export type BuildStepFacts =
  | { kind: "unresolved"; reason: string }
  | {
      kind: "source";
      file: string;
      text: string;
      /** iOS: the application targets the phase goes into that set ENABLE_USER_SCRIPT_SANDBOXING = YES. */
      sandboxed: SandboxedTarget[];
      /** Only when the installed SDK defines the step: there is nothing to compare against otherwise. */
      finding?: BuildStepFinding;
    };

export type JsRootFacts = {
  platforms: NativePlatform[];
  via: string;
  text: string | null;
  result: RootTransform;
  graph: GraphCalls;
};

export type PlanFacts = {
  iosRoot: string;
  iosDestination?: { target: IosAppTarget; text: string | null };
  androidDestination?: { overrides: string[]; text: string | null };
  expoConfigText: string | null;
  hooks: Partial<Record<NativePlatform, NativeHookFacts>>;
  buildSteps: Partial<Record<NativePlatform, BuildStepFacts>>;
  // Unresolved selected platforms must survive even if another root resolves.
  unresolvedJsRoots: Array<{ platform: NativePlatform; resolution: Extract<JsRootResolution, { kind: "unresolved" }> }>;
  jsRoots: Map<string, JsRootFacts>;
  pods?: { lock: string | null; bundler: boolean };
  /**
   * How the selected iOS project gets its dependencies. Unset when iOS is not
   * selected, there is no iOS project, or Expo prebuild owns the native
   * projects (prebuild then decides the mode itself).
   */
  iosDependencyManager?: IosDependencyManager;
};

export async function inspectPlanFacts(input: {
  shape: ProjectShape;
  platforms: NativePlatform[];
  linkedPlatforms: NativePlatform[];
}): Promise<PlanFacts> {
  const { shape, platforms, linkedPlatforms } = input;
  const iosRoot = await findIosRoot(shape.root);
  const facts: PlanFacts = {
    iosRoot,
    expoConfigText: shape.expoConfig === undefined ? null : await readTextFile(shape.expoConfig.file),
    hooks: {},
    buildSteps: {},
    unresolvedJsRoots: [],
    jsRoots: new Map(),
  };
  if (shape.expoNative !== "generated") {
    for (const platform of new Set([...platforms, ...linkedPlatforms])) {
      if (!shape.nativeDirectories[platform]) continue;
      if (platform === "ios") {
        const target = await locateIosAppTarget(iosRoot);
        if (platforms.includes(platform)) {
          facts.iosDestination = { target, text: target.kind === "resolved" ? await readTextFile(target.plist) : null };
        }
        const host = target.kind === "unresolved"
          ? target
          : await locateIosAppDelegate(target.sources, path.dirname(target.plist));
        facts.hooks.ios = await inspectHook(host, transformIosAppDelegate);
      } else {
        if (platforms.includes(platform)) {
          facts.androidDestination = {
            overrides: await findAndroidResourceOverrides(shape.root),
            text: await readTextFile(path.join(shape.root, ANDROID_STRINGS_FILE)),
          };
        }
        facts.hooks.android = await inspectHook(await locateAndroidMainApplication(shape.root), transformAndroidMainApplication);
      }
    }
    // React Native's SwiftPM mode (`npx react-native spm add`) keeps ios/Podfile
    // and Podfile.lock but must never see `pod install` again, so the marker
    // decides before any CocoaPods fact is collected.
    if (platforms.includes("ios")) {
      const manager = await detectIosDependencyManager(shape.root);
      if (manager !== undefined) facts.iosDependencyManager = manager;
    }
    if (platforms.includes("ios") && facts.iosDependencyManager !== "swiftpm" && await isFile(path.join(iosRoot, "Podfile"))) {
      facts.pods = {
        lock: await readTextFile(path.join(iosRoot, "Podfile.lock")),
        bundler: await isFile(path.join(shape.root, "Gemfile")),
      };
    }
  }

  // Generated projects too: wire edits nothing there, but says what an existing one still lacks.
  for (const platform of platforms) {
    if (!shape.nativeDirectories[platform]) continue;
    facts.buildSteps[platform] = await inspectBuildStepFacts(shape, platform, iosRoot);
  }

  for (const platform of linkedPlatforms) {
    const resolution = await resolveJsRoot(shape.root, shape.packageJson.main, platform);
    if (resolution.kind === "unresolved") {
      facts.unresolvedJsRoots.push({ platform, resolution });
      continue;
    }
    const existing = facts.jsRoots.get(resolution.file);
    if (existing !== undefined) {
      existing.platforms.push(platform);
      continue;
    }
    const text = await readTextFile(resolution.file);
    facts.jsRoots.set(resolution.file, {
      platforms: [platform],
      via: resolution.via,
      text,
      result: text === null ? { kind: "manual", reason: `${resolution.file} could not be read` } : transformJsRoot(text, resolution.file),
      graph: { startup: [], wrap: [], limited: false },
    });
  }
  for (const root of facts.jsRoots.values()) {
    if (!root.platforms.some((platform) => platforms.includes(platform))) continue;
    if (root.result.kind === "already-configured" || root.result.kind === "existing-integration") continue;
    root.graph = await inspectGraphCalls(shape.root, shape.packageJson.main, root.platforms);
  }
  return facts;
}

async function inspectHook<Language extends string>(
  host: { kind: "unresolved"; reason: string } | { kind: "resolved"; file: string; language: Language },
  transform: (text: string, language: Language) => HookTransform,
): Promise<NativeHookFacts> {
  if (host.kind === "unresolved") return host;
  const text = await readTextFile(host.file);
  return text === null
    ? { kind: "unresolved", reason: `${host.file} could not be read` }
    : { kind: "source", file: host.file, text, result: transform(text, host.language) };
}

/** The build file that carries the step for `platform`, and what it carries now. `cmpatch doctor` reports from the same facts. */
export async function inspectBuildStepFacts(
  shape: Pick<ProjectShape, "root" | "buildIntegration">,
  platform: NativePlatform,
  iosRoot: string,
): Promise<BuildStepFacts> {
  const located = platform === "ios" ? await locateXcodeStep(iosRoot) : await locateGradleStep(shape.root);
  if (located.kind === "source" && shape.buildIntegration.kind === "available") {
    located.finding = inspectBuildStep({ platform, ...located }, located.text, shape.buildIntegration.definition);
  }
  return located;
}

/**
 * The project file that holds the application targets. Which of them get the
 * phase is decided from the file itself: every one that has a bundle phase.
 */
async function locateXcodeStep(iosRoot: string): Promise<BuildStepFacts> {
  const targets = await discoverIosTargets(iosRoot, readDoctorSource);
  if (!targets.present) return { kind: "unresolved", reason: `No .xcodeproj found in ${iosRoot}` };
  if (targets.limited) return { kind: "unresolved", reason: "The Xcode project could not be read completely" };
  const files = [...new Set(targets.targets.map((target) => target.project))];
  if (files.length !== 1) {
    return {
      kind: "unresolved",
      reason: files.length === 0
        ? "No application target was found in the Xcode project"
        : `Application targets in several Xcode projects: ${files.map((file) => path.basename(path.dirname(file))).join(", ")}`,
    };
  }
  const file = files[0]!;
  const text = await readTextFile(file);
  return text === null
    ? { kind: "unresolved", reason: `${file} could not be read` }
    : { kind: "source", file, text, sandboxed: xcodeSandboxedTargets(text) };
}

async function locateGradleStep(root: string): Promise<BuildStepFacts> {
  const groovy = path.join(root, "android", "app", "build.gradle");
  const kotlin = `${groovy}.kts`;
  const present = [await isFile(groovy), await isFile(kotlin)];
  if (present[0] && present[1]) {
    return { kind: "unresolved", reason: "android/app has both build.gradle and build.gradle.kts" };
  }
  if (!present[0] && !present[1]) return { kind: "unresolved", reason: "android/app has no build.gradle or build.gradle.kts" };
  const file = present[0] ? groovy : kotlin;
  const text = await readTextFile(file);
  return text === null
    ? { kind: "unresolved", reason: `${file} could not be read` }
    : { kind: "source", file, text, sandboxed: [] };
}
