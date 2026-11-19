// The SDK-owned native fingerprint calculator (specs/build-metadata.md §6; why
// the SDK owns it: wiki/discussions/build-time-fingerprint.md).
//
// - The engine is the `@expo/fingerprint` this SDK depends on, resolved from
//   the SDK's own package directory, never from the app or a hoisted copy of
//   another version. Its version must equal the SDK's exact pin.
// - No `preset` is passed: the engine default (`balanced`) applies unless the
//   project's fingerprint.config.js selects another.
// - Bare version normalization runs through `fileHookTransform`, after the
//   project's own hook, and is off under `preset: 'strict'`.
// - The engine's Bare/CNG decisions are followed: a native directory source
//   whose hash is null (excluded as generated) is a valid result.
// - `engine` names the engine, the SDK's own rule set
//   (`codemagic-patch-rules@<n>`: added ignore paths, app-root resolution,
//   sort order) and,
//   when it ran, version normalization (`version-normalization@<m>`).

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type {
  Config as EngineProjectConfig,
  Fingerprint,
  FingerprintSource,
  Options as EngineOptions,
} from "@expo/fingerprint";

import { BuildToolsError } from "./errors";
import { assertProjectConfigApplies } from "./projectConfig";
import { assertSupportedNode } from "./nodeVersion";
import { createVersionNormalizingHook, VERSION_NORMALIZATION_RULES_VERSION } from "./versionNormalization";

export const SDK_PACKAGE_NAME = "@codemagic/react-native-patch";
export const ENGINE_PACKAGE_NAME = "@expo/fingerprint";

/**
 * Version of everything this calculator does to the hash outside version
 * normalization: the ignore paths it adds (`SDK_IGNORE_PATHS`,
 * `SWIFTPM_IGNORE_PATHS` and the condition under which the SwiftPM list
 * applies), resolving the app root to its real path and the locale-independent
 * sort order (`withNodeEnvironment`). Recorded in `engine` as
 * `codemagic-patch-rules@<n>`. Raise it whenever a change to those rules can
 * change the output for any input.
 */
export const SDK_FINGERPRINT_RULES_VERSION = 1;

export type FingerprintPlatform = "ios" | "android";

export type NativeFingerprintResult = {
  /** The engine's digest, lowercase hex; its length follows `hashAlgorithm`. */
  fingerprint: string;
  /**
   * The engine's package name and exact resolved version, then the SDK's own
   * rule-set version (`SDK_FINGERPRINT_RULES_VERSION`), then the normalization
   * rule-set version when normalization was applied, for example
   * `@expo/fingerprint@0.21.9 codemagic-patch-rules@1 version-normalization@1`;
   * under `preset: 'strict'` `@expo/fingerprint@0.21.9 codemagic-patch-rules@1`.
   */
  engine: string;
  platform: FingerprintPlatform;
  /** The resolved app root the engine ran on. */
  appRoot: string;
  /** Whether Bare version normalization was applied (false under `preset: 'strict'`). */
  versionNormalization: boolean;
  /** The engine's sources, unchanged. Diagnostic only. */
  sources: FingerprintSource[];
};

type EngineModule = {
  createFingerprintAsync: (projectRoot: string, options?: EngineOptions) => Promise<Fingerprint>;
};

type EngineConfigModule = {
  loadConfigAsync: (projectRoot: string, silent?: boolean) => Promise<EngineProjectConfig | null>;
};

export type ResolvedEngine = {
  /** `<name>@<version>` as read from the resolved package.json. */
  engine: string;
  version: string;
  packageRoot: string;
  module: EngineModule;
  config: EngineConfigModule;
};

function causeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

/** The directory of this SDK's package.json, found by walking up from this file. */
export function findSdkRoot(fromDirectory: string = __dirname): string {
  let directory = fromDirectory;
  for (;;) {
    const candidate = path.join(directory, "package.json");
    try {
      if (readJson(candidate).name === SDK_PACKAGE_NAME) {
        return directory;
      }
    } catch {
      // Not a package root, or unreadable: keep walking up.
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new BuildToolsError(
        "ENGINE_UNAVAILABLE",
        `cannot find the ${SDK_PACKAGE_NAME} package root above ${fromDirectory}`,
      );
    }
    directory = parent;
  }
}

/**
 * Resolves `@expo/fingerprint` as a dependency of the SDK package (a
 * `createRequire` rooted at the SDK's package.json), loads it and checks that
 * its version is the SDK's exact pin. A different version (an override or a
 * broken install) is an error, not a silent engine change.
 */
export function resolveEngine(sdkRoot: string = findSdkRoot()): ResolvedEngine {
  const sdkPackageJson = path.join(sdkRoot, "package.json");
  let pinned: unknown;
  try {
    pinned = (readJson(sdkPackageJson).dependencies as Record<string, unknown> | undefined)?.[
      ENGINE_PACKAGE_NAME
    ];
  } catch (error) {
    throw new BuildToolsError(
      "ENGINE_UNAVAILABLE",
      `cannot read ${sdkPackageJson}: ${causeMessage(error)}`,
      { cause: error },
    );
  }
  if (typeof pinned !== "string" || pinned.length === 0) {
    throw new BuildToolsError(
      "ENGINE_UNAVAILABLE",
      `${sdkPackageJson} declares no ${ENGINE_PACKAGE_NAME} dependency`,
    );
  }

  const sdkRequire = createRequire(sdkPackageJson);
  let enginePackageJson: string;
  let version: unknown;
  let module: EngineModule;
  let config: EngineConfigModule;
  try {
    enginePackageJson = sdkRequire.resolve(`${ENGINE_PACKAGE_NAME}/package.json`);
    version = readJson(enginePackageJson).version;
    const packageRoot = path.dirname(enginePackageJson);
    module = sdkRequire(sdkRequire.resolve(ENGINE_PACKAGE_NAME)) as EngineModule;
    // The engine's own config loader, so the project's fingerprint.config.js
    // is read exactly as the engine reads it. Internal to the engine; safe
    // because the engine version is pinned exactly and checked below.
    config = sdkRequire(path.join(packageRoot, "build", "Config.js")) as EngineConfigModule;
  } catch (error) {
    throw new BuildToolsError(
      "ENGINE_UNAVAILABLE",
      `cannot load ${ENGINE_PACKAGE_NAME} from ${sdkRoot}: ${causeMessage(error)}. Reinstall dependencies so ${SDK_PACKAGE_NAME} gets its ${ENGINE_PACKAGE_NAME} ${pinned}.`,
      { cause: error },
    );
  }

  if (version !== pinned) {
    throw new BuildToolsError(
      "ENGINE_VERSION_MISMATCH",
      `${SDK_PACKAGE_NAME} requires ${ENGINE_PACKAGE_NAME} ${pinned}, but ${String(version)} was resolved at ${enginePackageJson}. Remove any override or resolution of ${ENGINE_PACKAGE_NAME} that applies to ${SDK_PACKAGE_NAME} and reinstall.`,
    );
  }
  if (typeof module.createFingerprintAsync !== "function" || typeof config.loadConfigAsync !== "function") {
    throw new BuildToolsError(
      "ENGINE_UNAVAILABLE",
      `${ENGINE_PACKAGE_NAME} ${version} at ${enginePackageJson} does not have the expected API`,
    );
  }

  return {
    engine: `${ENGINE_PACKAGE_NAME}@${version}`,
    version,
    packageRoot: path.dirname(enginePackageJson),
    module,
    config,
  };
}

function assertPlatform(platform: unknown): asserts platform is FingerprintPlatform {
  if (platform !== "ios" && platform !== "android") {
    throw new BuildToolsError(
      "INVALID_ARGUMENT",
      `platform must be "ios" or "android", got ${JSON.stringify(platform)}`,
    );
  }
}

/**
 * The app root must be an existing directory with a package.json. Returned as
 * its real path: the engine resolves config plugins and modules through real
 * paths and records them relative to the root, so a root spelled through a
 * symlink gives another digest. The native builds pass the real path.
 */
function resolveAppRoot(appRoot: unknown): string {
  if (typeof appRoot !== "string" || appRoot.length === 0) {
    throw new BuildToolsError("INVALID_ARGUMENT", "an explicit app root is required");
  }
  const resolved = path.resolve(appRoot);
  let isDirectory = false;
  try {
    isDirectory = statSync(resolved).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    throw new BuildToolsError("INVALID_APP_ROOT", `app root is not a directory: ${resolved}`);
  }
  try {
    if (!statSync(path.join(resolved, "package.json")).isFile()) {
      throw new Error("not a file");
    }
  } catch {
    throw new BuildToolsError(
      "INVALID_APP_ROOT",
      `app root has no package.json: ${resolved}. Pass the React Native app's root directory, not its ios/ or android/ directory or a monorepo root.`,
    );
  }
  return realpathSync.native(resolved);
}

// Files a build, an IDE or a release tool writes into the native directories
// of one machine and that a clean checkout never has; the engine's default
// ignore list does not cover them, and a native directory is hashed whatever
// .gitignore says. Without them a binary built on one machine records a
// fingerprint that a checkout elsewhere cannot reproduce.
// - android/.kotlin: the Kotlin daemon keeps sessions/*.salive only while it
//   compiles (and writes errors/ on a daemon failure), so a write step
//   running during a Kotlin compile would hash a file no later computation
//   sees.
// - local.properties, .idea, *.iml, xcuserdata, DerivedData: what React
//   Native's template .gitignore lists as local to Android Studio and Xcode.
// - android/*/build, .gradle and .cxx: Gradle's output for buildSrc and for
//   every module, where the engine only knows android/ itself and android/app.
// - Keystores: CI writes the upload keystore into android/app before a build.
// - *.ipa and *.dSYM.zip: fastlane writes them into the directory it runs in.
// A change to this list, SWIFTPM_IGNORE_PATHS or isSwiftPMProject raises
// SDK_FINGERPRINT_RULES_VERSION.
const SDK_IGNORE_PATHS = [
  "**/android/.kotlin/**/*",
  "**/android/local.properties",
  "**/android/.idea/**/*",
  "**/android/**/*.iml",
  "**/android/*/build/**/*",
  "**/android/*/.gradle/**/*",
  "**/android/*/.cxx/**/*",
  "**/android/**/*.keystore",
  "**/android/**/*.jks",
  "**/xcuserdata/**/*",
  "**/DerivedData/**/*",
  "**/ios/**/*.ipa",
  "**/ios/**/*.dSYM.zip",
];

/**
 * The `Package.resolved` Xcode writes into a React Native SwiftPM-mode app
 * (`npx react-native spm add`) on a developer's machine: React Native's
 * SwiftPM setup gitignores it, so a CI clone never has it. Applied to iOS in
 * that mode only; a CocoaPods project that commits a `Package.resolved` keeps
 * it in the hash. cmpatch's own calculator has the same rule
 * (`SWIFTPM_FINGERPRINT_IGNORES` in cli/src/fingerprint.ts). A `!` line in
 * `.fingerprintignore` puts a file back.
 */
const SWIFTPM_IGNORE_PATHS = [
  "ios/**/xcshareddata/swiftpm/Package.resolved",
  "iOS/**/xcshareddata/swiftpm/Package.resolved",
];

/** The marker `npx react-native spm add` writes into the converted `.xcodeproj`. */
const SWIFTPM_MODE_MARKER = ".spm-injected.json";

/** Whether any `<iosRoot>/*.xcodeproj` of the app carries React Native's SwiftPM-mode marker. */
function isSwiftPMProject(appRoot: string): boolean {
  for (const name of ["ios", "iOS"]) {
    let entries: string[];
    try {
      if (!statSync(path.join(appRoot, name)).isDirectory()) continue;
      entries = readdirSync(path.join(appRoot, name));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".xcodeproj")) continue;
      try {
        statSync(path.join(appRoot, name, entry, SWIFTPM_MODE_MARKER));
        return true;
      } catch {
        // no marker in this project
      }
    }
    return false;
  }
  return false;
}

/**
 * The engine reported a source for the platform's native directory. Its hash
 * may be null: the engine excludes generated native directories of a CNG
 * project, and that is a valid result.
 */
function hasNativeDirectorySource(sources: FingerprintSource[], platform: FingerprintPlatform): boolean {
  return sources.some((source) => {
    if (!("filePath" in source) || typeof source.filePath !== "string") {
      return false;
    }
    const filePath = source.filePath.replaceAll("\\", "/");
    return filePath === platform || filePath.startsWith(`${platform}/`);
  });
}

/**
 * Computes the native fingerprint for an explicit app root and platform with
 * the SDK's pinned engine. Throws `BuildToolsError`; never falls back to
 * another engine or returns an empty digest.
 */
export async function computeNativeFingerprint(input: {
  appRoot: string;
  platform: FingerprintPlatform;
}): Promise<NativeFingerprintResult> {
  return withNodeEnvironment(() => computeFingerprint(input));
}

// What the engine takes from the process, pinned for the length of one
// computation and restored before the next call is released:
// - It spawns node/npx by name, even when this process was started through an
//   absolute NODE_BINARY. PATH keeps all its children on this Node.
// - It orders sources and directory entries with `localeCompare`, so the
//   digest follows the locale Node.js was started in (LC_ALL, LANG): a build
//   under et_EE and a release under en_US would disagree. The comparison is
//   the en-US one, which is also what Node.js uses under the C locale.
let pendingCalculation: Promise<unknown> = Promise.resolve();
const SORT_COLLATOR = new Intl.Collator("en-US");

function withNodeEnvironment<T>(compute: () => Promise<T>): Promise<T> {
  const calculation = pendingCalculation.then(async () => {
    const localeCompare = String.prototype.localeCompare;
    // Only the form the engine calls; a call that names its own locale keeps it.
    String.prototype.localeCompare = function (this: string, ...args: Parameters<string["localeCompare"]>): number {
      const [that, locales, options] = args;
      return locales === undefined && options === undefined
        ? SORT_COLLATOR.compare(String(this), that)
        : localeCompare.apply(this, args);
    };
    const pathKey = process.platform === "win32"
      ? Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "Path"
      : "PATH";
    const previous = process.env[pathKey];
    // POSIX child_process normally searches /usr/bin:/bin when PATH is absent;
    // keep that default so npm can still start its shell.
    const inherited = previous ?? (process.platform === "win32" ? "" : "/usr/bin:/bin");
    process.env[pathKey] = [path.dirname(process.execPath), inherited].filter(Boolean).join(path.delimiter);
    try {
      return await compute();
    } finally {
      String.prototype.localeCompare = localeCompare;
      if (previous === undefined) delete process.env[pathKey];
      else process.env[pathKey] = previous;
    }
  });
  pendingCalculation = calculation.catch(() => {});
  return calculation;
}

async function computeFingerprint(input: {
  appRoot: string;
  platform: FingerprintPlatform;
}): Promise<NativeFingerprintResult> {
  assertSupportedNode();
  assertPlatform(input.platform);
  const platform = input.platform;
  const appRoot = resolveAppRoot(input.appRoot);
  const engine = resolveEngine();
  // Fail on a config file the engine would silently drop, rather than hash
  // without the settings the project asked for.
  const configPath = assertProjectConfigApplies(appRoot);

  let projectConfig: EngineProjectConfig | null;
  try {
    projectConfig = await engine.config.loadConfigAsync(appRoot, true);
  } catch (error) {
    throw new BuildToolsError(
      "INVALID_PROJECT_CONFIG",
      `cannot load ${configPath ?? "fingerprint.config.js"} in ${appRoot}: ${causeMessage(error)}`,
      { cause: error },
    );
  }
  const projectHook = projectConfig?.fileHookTransform;
  if (projectHook !== undefined && projectHook !== null && typeof projectHook !== "function") {
    throw new BuildToolsError(
      "INVALID_PROJECT_CONFIG",
      `fileHookTransform in ${configPath ?? `${appRoot}/fingerprint.config.js`} is not a function`,
    );
  }

  const versionNormalization = projectConfig?.preset !== "strict";
  const options: EngineOptions = {
    platforms: [platform],
    silent: true,
    // The engine adds these to its defaults and the project's own ignorePaths
    // and .fingerprintignore.
    ignorePaths: platform === "ios" && isSwiftPMProject(appRoot) ? [...SDK_IGNORE_PATHS, ...SWIFTPM_IGNORE_PATHS] : SDK_IGNORE_PATHS,
    // An explicit fileHookTransform replaces the project's own, so the
    // normalizing hook runs the project's hook first.
    ...(versionNormalization ? { fileHookTransform: createVersionNormalizingHook(projectHook ?? undefined) } : {}),
  };

  let result: Fingerprint;
  try {
    result = await engine.module.createFingerprintAsync(appRoot, options);
  } catch (error) {
    throw new BuildToolsError(
      "CALCULATOR_FAILED",
      `${engine.engine} failed for ${platform} at ${appRoot}: ${causeMessage(error)}`,
      { cause: error },
    );
  }

  if (typeof result?.hash !== "string" || !/^[0-9a-f]+$/.test(result.hash)) {
    throw new BuildToolsError(
      "CALCULATOR_FAILED",
      `${engine.engine} returned no usable digest for ${platform} at ${appRoot}`,
    );
  }
  const sources = Array.isArray(result.sources) ? result.sources : [];
  // Both RN CLI and Expo autolinking emit this contents source on success,
  // including when there are no linked dependencies. The engine otherwise
  // swallows a failed child process and returns a deceptively usable hash.
  const hasAutolinking = sources.some((source) => source.type === "contents" &&
    (source.id === "rncoreAutolinkingConfig" || source.id === `rncoreAutolinkingConfig:${platform}`));
  if (!hasAutolinking && resolvesFromApp(appRoot, "react-native/package.json")) {
    throw new BuildToolsError(
      "CALCULATOR_FAILED",
      `React Native autolinking could not be collected for ${platform} at ${appRoot} with Node.js ${process.execPath}. Check the project's React Native or Expo autolinking command and installed dependencies; no partial fingerprint was accepted.`,
    );
  }
  // The engine reads the Expo config wherever `expo/config` resolves, and
  // likewise only prints a line when that fails (a throwing app.config.js, an
  // Expo env loader the running Node.js cannot run) and hashes without it.
  const hasExpoConfig = sources.some((source) => source.type === "contents" && source.id === "expoConfig");
  if (!hasExpoConfig && resolvesFromApp(appRoot, "expo/config") && !skipsExpoConfig(projectConfig)) {
    throw new BuildToolsError(
      "CALCULATOR_FAILED",
      `the Expo config could not be loaded for ${platform} at ${appRoot} with Node.js ${process.versions.node} (${process.execPath}). The line "Cannot get Expo config from an Expo project" in this output has the cause; no partial fingerprint was accepted.`,
    );
  }
  if (!hasNativeDirectorySource(sources, platform)) {
    throw new BuildToolsError(
      "CALCULATOR_FAILED",
      `no ${platform} native project sources were found at ${appRoot}. The app root must hold the native project in its ${platform} directory; a native project outside the React Native app's directory is not supported. For an Expo CNG project, run prebuild first.`,
    );
  }

  return {
    fingerprint: result.hash,
    engine: versionNormalization
      ? `${engine.engine} codemagic-patch-rules@${SDK_FINGERPRINT_RULES_VERSION} version-normalization@${VERSION_NORMALIZATION_RULES_VERSION}`
      : `${engine.engine} codemagic-patch-rules@${SDK_FINGERPRINT_RULES_VERSION}`,
    platform,
    appRoot,
    versionNormalization,
    sources,
  };
}

function resolvesFromApp(appRoot: string, request: string): boolean {
  try {
    createRequire(path.join(appRoot, "package.json")).resolve(request);
    return true;
  } catch {
    return false;
  }
}

/** `SourceSkips.ExpoConfigAll` of the pinned engine: the project leaves the Expo config out of the hash. */
const EXPO_CONFIG_ALL = 256;

function skipsExpoConfig(config: EngineProjectConfig | null): boolean {
  const skips: unknown = config?.sourceSkips;
  return Array.isArray(skips) ? skips.includes("ExpoConfigAll") : typeof skips === "number" && (skips & EXPO_CONFIG_ALL) !== 0;
}
