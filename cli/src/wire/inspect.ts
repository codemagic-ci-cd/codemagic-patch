// Collect file discovery and source analysis once; planning consumes these
// facts without reading files or depending on destination lookup success.
import path from "node:path";

import { findIosRoot } from "../nativeProjectPaths";
import type { NativePlatform } from "../projectAnalysis";
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
  // Unresolved selected platforms must survive even if another root resolves.
  unresolvedJsRoots: Array<{ platform: NativePlatform; resolution: Extract<JsRootResolution, { kind: "unresolved" }> }>;
  jsRoots: Map<string, JsRootFacts>;
  pods?: { lock: string | null; bundler: boolean };
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
    if (platforms.includes("ios") && await isFile(path.join(iosRoot, "Podfile"))) {
      facts.pods = {
        lock: await readTextFile(path.join(iosRoot, "Podfile.lock")),
        bundler: await isFile(path.join(shape.root, "Gemfile")),
      };
    }
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
