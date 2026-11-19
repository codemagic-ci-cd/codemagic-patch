// Guards against a fingerprint.config file that exists but that the engine
// would silently not apply. The pinned engine's loader (`build/Config.js`)
// requires `fingerprint.config.js` or `fingerprint.config.cjs`, treats a
// config that throws as `{}`, keeps only named members (so an ES module's
// `export default { ... }` contributes nothing), and never looks at other file
// names. Each of those would yield a digest for a configuration the project did
// not ask for (its `preset`, `fileHookTransform`, `ignorePaths`, `sourceSkips`
// dropped without a word), so the calculator fails instead.

import { statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { BuildToolsError } from "./errors";

/** The names the pinned engine reads, in its own lookup list. */
export const ENGINE_CONFIG_FILE_NAMES = ["fingerprint.config.js", "fingerprint.config.cjs"] as const;

/** Names a project may plausibly use that the engine never reads. */
const UNREAD_CONFIG_FILE_NAMES = [
  "fingerprint.config.mjs",
  "fingerprint.config.ts",
  "fingerprint.config.mts",
  "fingerprint.config.cts",
  "fingerprint.config.json",
];

/** The option names the engine copies from a loaded config. */
const ENGINE_CONFIG_KEYS = [
  "preset",
  "concurrentIoLimit",
  "hashAlgorithm",
  "ignorePaths",
  "extraSources",
  "sourceSkips",
  "enableReactImportsPatcher",
  "useRNCoreAutolinkingFromExpo",
  "nativeModuleSourceType",
  "configPluginSourceType",
  "debug",
  "fileHookTransform",
];

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function configError(message: string, cause?: unknown): never {
  throw new BuildToolsError(
    "INVALID_PROJECT_CONFIG",
    `${message} (Node.js ${process.version})`,
    cause === undefined ? undefined : { cause },
  );
}

function withMutedConsole<T>(run: () => T): T {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return run();
  } finally {
    Object.assign(console, saved);
  }
}

/**
 * Throws `INVALID_PROJECT_CONFIG` when the app root carries a fingerprint
 * config that the engine would not apply. Returns the config path the engine
 * will read, or null when the project has none.
 */
export function assertProjectConfigApplies(appRoot: string): string | null {
  const present = ENGINE_CONFIG_FILE_NAMES.filter((name) => isFile(path.join(appRoot, name)));

  if (present.length === 0) {
    const unread = UNREAD_CONFIG_FILE_NAMES.find((name) => isFile(path.join(appRoot, name)));
    if (unread !== undefined) {
      configError(
        `${path.join(appRoot, unread)} is not read by the fingerprint engine, which reads only ${ENGINE_CONFIG_FILE_NAMES.join(" or ")}. Rename it so its settings apply.`,
      );
    }
    return null;
  }
  if (present.length > 1) {
    configError(
      `${appRoot} has both ${present.join(" and ")}; the fingerprint engine reads one of them. Keep one.`,
    );
  }

  const configPath = path.join(appRoot, present[0]!);
  let loaded: unknown;
  try {
    // Same module cache as the engine's own require of this path.
    loaded = withMutedConsole(() => createRequire(configPath)(configPath));
  } catch (error) {
    configError(
      `cannot load ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }

  // The engine reads options with `key in loaded`, which works on an object
  // or a function (an `Object.assign(function () {}, { ... })` export applies)
  // and throws on a primitive or null.
  if (loaded === null || (typeof loaded !== "object" && typeof loaded !== "function")) {
    configError(`${configPath} does not export an object`);
  }
  const members = loaded as Record<string, unknown>;
  const hasEngineKey = ENGINE_CONFIG_KEYS.some((key) => key in members);
  if (!hasEngineKey && "default" in members && members.default !== null && typeof members.default === "object") {
    configError(
      `${configPath} uses a default export, which the fingerprint engine ignores. Use module.exports = { ... } or named exports (export const preset = ...).`,
    );
  }
  return configPath;
}
