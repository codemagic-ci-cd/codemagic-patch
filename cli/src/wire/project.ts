// What `cmpatch wire` learns about a project before it plans anything: how
// packages are installed, whether Expo generates the native projects, which
// native directories exist, and whether the Patch SDK is already there.
// Read-only, and every answer here is what the plan preview shows.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { isRecord } from "../output";
import type { NativePlatform } from "../projectAnalysis";
import { compareVersions } from "../semver";
import { isDirectory, isFile, readJsonFile, readTextFile } from "./fs";
import type { WireProjectSummary } from "./types";

export const SDK_PACKAGE = "@codemagic/react-native-patch";
/** The first SDK release that exports `wrap`. */
export const MIN_WRAP_SDK_VERSION = "0.5.0";
/** What an absent or too-old registry SDK is installed as. */
export const SDK_INSTALL_RANGE = `^${MIN_WRAP_SDK_VERSION}`;

/**
 * Packages that ship their own OTA flow. Being declared is not a conflict —
 * the native and JavaScript transforms decide that from the sources — but the
 * names are what those transforms look for.
 */
export const OTHER_OTA_PACKAGES = [
  "react-native-code-push",
  "@code-push-next/react-native-code-push",
  "@appzung/react-native-code-push",
  "expo-updates",
  "hot-updater",
  "@hot-updater/react-native",
  "react-native-ota-hot-update",
  "react-native-update",
] as const;

export type PackageManagerKind = "bun" | "npm" | "pnpm" | "yarn";

export type PackageManager = {
  kind: PackageManagerKind;
  /** How the kind was decided, for the plan preview. */
  source: string;
  lockfile?: string;
  /** Yarn Plug'n'Play: no node_modules to resolve the SDK from. */
  pnp: boolean;
  /** Nearest ancestor whose workspace globs include this project. */
  workspaceRoot?: string;
};

export type SdkDependency = {
  /** The spec in package.json, when declared directly. */
  declared?: string;
  /** Anything but a registry range or tag (`workspace:`, `file:`, a URL, a path): never replaced. */
  kind: "absent" | "local" | "registry";
  installedVersion?: string;
  installedRoot?: string;
  /** Whether the installed package exports `wrap` (version gate or, for local packages, the source itself). */
  supportsWrap: boolean;
};

export type ExpoConfigFile = {
  file: string;
  data: Record<string, unknown>;
};

export type ProjectShape = {
  root: string;
  name: string;
  packageJson: Record<string, unknown>;
  packageManager: PackageManager;
  framework: "bare" | "expo";
  /** Installed versions only; a declared range says nothing about the template in use. */
  reactNativeVersion?: string;
  expoVersion?: string;
  nativeDirectories: Record<NativePlatform, boolean>;
  /** The static Expo config file the plugin entry lives in, when there is one. */
  expoConfig?: ExpoConfigFile;
  /** `app.config.js` / `app.config.ts` present: the effective config is not static. */
  expoConfigDynamic: boolean;
  /**
   * Expo only. Whether Expo regenerates the native projects (CNG) or the
   * developer maintains them. `unknown` when native directories exist
   * without git evidence either way; the caller has to ask.
   */
  expoNative?: "generated" | "maintained" | "unknown";
  sdk: SdkDependency;
  otherOtaPackages: string[];
};

export async function inspectProject(root: string): Promise<ProjectShape> {
  const packageJson = await readJsonFile(path.join(root, "package.json"));
  if (packageJson === null) {
    throw new Error(`No readable package.json in ${root}`);
  }
  root = await realpath(root);
  const dependencies = dependencyMap(packageJson);
  const framework = Object.hasOwn(dependencies, "expo") ? "expo" : "bare";
  const nativeDirectories = {
    android: await isDirectory(path.join(root, "android")),
    ios:
      (await isDirectory(path.join(root, "ios"))) ||
      (await isDirectory(path.join(root, "iOS"))),
  };
  const workspaceRoot = await findWorkspaceRoot(root);
  const packageManager = await detectPackageManager(
    root,
    packageJson,
    workspaceRoot,
  );
  const reactNativeVersion = await installedVersion(root, "react-native");
  const expoVersion = await installedVersion(root, "expo");
  const expoConfig =
    framework === "expo" ? await readExpoConfig(root) : undefined;

  return {
    root,
    name: typeof packageJson.name === "string" ? packageJson.name : path.basename(root),
    packageJson,
    packageManager,
    framework,
    ...(reactNativeVersion !== undefined ? { reactNativeVersion } : {}),
    ...(expoVersion !== undefined ? { expoVersion } : {}),
    nativeDirectories,
    ...(expoConfig !== undefined ? { expoConfig } : {}),
    expoConfigDynamic:
      (await isFile(path.join(root, "app.config.js"))) ||
      (await isFile(path.join(root, "app.config.ts"))),
    ...(framework === "expo"
      ? {
          expoNative:
            !nativeDirectories.ios && !nativeDirectories.android
              ? "generated"
              : (await gitIgnoresNativeDirectories(root))
                ? "generated"
                : "unknown",
        }
      : {}),
    sdk: await inspectSdk(root, dependencies, packageManager.pnp),
    otherOtaPackages: OTHER_OTA_PACKAGES.filter((name) =>
      Object.hasOwn(dependencies, name),
    ),
  };
}

export function summarizeProject(
  shape: ProjectShape,
  platforms: NativePlatform[],
): WireProjectSummary {
  return {
    root: shape.root,
    packageManager: shape.packageManager.kind,
    framework: shape.framework,
    ...(shape.expoNative === "generated" || shape.expoNative === "maintained"
      ? { expoNative: shape.expoNative }
      : {}),
    ...(shape.reactNativeVersion !== undefined
      ? { reactNativeVersion: shape.reactNativeVersion }
      : {}),
    ...(shape.expoVersion !== undefined ? { expoVersion: shape.expoVersion } : {}),
    platforms,
    sdk: shape.sdk,
  };
}

async function installedVersion(
  root: string,
  name: string,
): Promise<string | undefined> {
  const resolved = resolvePackageRoot(root, name);
  const installed =
    resolved === undefined
      ? null
      : await readJsonFile(path.join(resolved, "package.json"));
  return typeof installed?.version === "string" ? installed.version : undefined;
}

async function inspectSdk(
  root: string,
  dependencies: Record<string, string>,
  pnp: boolean,
): Promise<SdkDependency> {
  const declared = dependencies[SDK_PACKAGE];
  const kind: SdkDependency["kind"] =
    declared === undefined
      ? "absent"
      : isRegistrySpec(declared)
        ? "registry"
        : "local";
  const installedRoot = pnp ? undefined : resolvePackageRoot(root, SDK_PACKAGE);
  const version =
    installedRoot === undefined
      ? undefined
      : await installedVersion(root, SDK_PACKAGE);
  const supportsWrap =
    version !== undefined && compareVersions(version, MIN_WRAP_SDK_VERSION) >= 0
      ? true
      : kind === "local" && installedRoot !== undefined
        ? (await isFile(path.join(installedRoot, "src", "wrap.ts"))) ||
          (await isFile(path.join(installedRoot, "dist", "wrap.js")))
        : false;

  return {
    ...(declared !== undefined ? { declared } : {}),
    kind,
    ...(version !== undefined ? { installedVersion: version } : {}),
    ...(installedRoot !== undefined ? { installedRoot } : {}),
    supportsWrap,
  };
}

/** A version range or a dist-tag, optionally behind an `npm:` alias. */
function isRegistrySpec(spec: string): boolean {
  const target = spec.startsWith("npm:")
    ? spec.slice("npm:".length).replace(/^@?[^@]+@/, "")
    : spec;
  return /^[\s^~<>=v]*\d[\w.\s*^~<>=|+-]*$/.test(target) || /^[xX*]$/.test(target) || /^[A-Za-z][\w.-]*$/.test(target);
}

function resolvePackageRoot(root: string, name: string): string | undefined {
  try {
    return path.dirname(
      createRequire(path.join(root, "package.json")).resolve(
        `${name}/package.json`,
      ),
    );
  } catch {
    return undefined;
  }
}

const LOCKFILES: Array<[string, PackageManagerKind]> = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

async function detectPackageManager(
  root: string,
  packageJson: Record<string, unknown>,
  workspaceRoot: string | undefined,
): Promise<PackageManager> {
  const roots = workspaceRoot === undefined ? [root] : [root, workspaceRoot];
  const declared = [
    packageJson.packageManager,
    workspaceRoot === undefined
      ? undefined
      : (await readJsonFile(path.join(workspaceRoot, "package.json")))
          ?.packageManager,
  ].find((value): value is string => typeof value === "string");
  const base = {
    pnp: await isYarnPnp(roots),
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
  };
  const declaredKind = declared?.split("@")[0];
  if (
    declaredKind === "npm" ||
    declaredKind === "yarn" ||
    declaredKind === "pnpm" ||
    declaredKind === "bun"
  ) {
    return {
      ...base,
      kind: declaredKind,
      source: `packageManager field (${declared})`,
    };
  }
  for (const dir of roots) {
    for (const [lockfile, kind] of LOCKFILES) {
      if (await isFile(path.join(dir, lockfile))) {
        return {
          ...base,
          kind,
          lockfile: path.join(dir, lockfile),
          source: `${lockfile} in ${dir === root ? "the project" : "the workspace root"}`,
        };
      }
    }
  }
  return { ...base, kind: "npm", source: "default (no lockfile found)" };
}

async function isYarnPnp(roots: string[]): Promise<boolean> {
  for (const dir of roots) {
    if (
      (await isFile(path.join(dir, ".pnp.cjs"))) ||
      (await isFile(path.join(dir, ".pnp.js")))
    ) {
      return true;
    }
    const yarnrc = await readTextFile(path.join(dir, ".yarnrc.yml"));
    if (yarnrc !== null && /^\s*nodeLinker:\s*pnp\b/m.test(yarnrc)) {
      return true;
    }
  }
  return false;
}

/**
 * The nearest ancestor whose workspace globs include this project. npm has
 * to be run from there with `-w`; the other package managers find it on
 * their own. An ancestor declaring unrelated workspaces is not this
 * project's root, so membership is checked rather than assumed.
 */
async function findWorkspaceRoot(root: string): Promise<string | undefined> {
  let dir = path.dirname(root);
  for (let depth = 0; depth < 8 && dir !== path.dirname(dir); depth += 1) {
    const relative = path.relative(dir, root).split(path.sep).join("/");
    if ((await workspaceGlobs(dir)).some((glob) => globMatches(glob, relative))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return undefined;
}

async function workspaceGlobs(dir: string): Promise<string[]> {
  const packageJson = await readJsonFile(path.join(dir, "package.json"));
  const declared = isRecord(packageJson?.workspaces)
    ? packageJson.workspaces.packages
    : packageJson?.workspaces;
  if (Array.isArray(declared)) {
    return declared.filter((entry): entry is string => typeof entry === "string");
  }
  const pnpm = await readTextFile(path.join(dir, "pnpm-workspace.yaml"));
  return pnpm === null
    ? []
    : [...pnpm.matchAll(/^\s*-\s*['"]?([^'"\n#]+?)['"]?\s*$/gm)].map(
        (match) => match[1]!,
      );
}

/** `apps/*` and `packages/**` — the shapes workspace globs take. */
function globMatches(glob: string, relative: string): boolean {
  const pattern = glob
    .replace(/^\.\//, "")
    .replace(/\/$/, "")
    .split("/")
    .map((segment) =>
      segment === "**"
        ? ".*"
        : segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"),
    )
    .join("/");
  return new RegExp(`^${pattern}$`).test(relative);
}

/** `app.config.json` takes precedence over `app.json`, as in Expo's config resolution. */
async function readExpoConfig(root: string): Promise<ExpoConfigFile | undefined> {
  for (const name of ["app.config.json", "app.json"]) {
    const data = await readJsonFile(path.join(root, name));
    if (data !== null) {
      return { file: path.join(root, name), data };
    }
  }
  return undefined;
}

/** Only untracked native directories that Git actually ignores imply CNG. */
async function gitIgnoresNativeDirectories(root: string): Promise<boolean> {
  const git = (args: string[]) => promisify(execFile)("git", args, {
    cwd: root, encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024,
  });
  try {
    const tracked = await git(["ls-files", "-z", "--", "ios", "android"]);
    if (tracked.stdout.length > 0) return false;
    const ignored = await git(["check-ignore", "--", "ios", "android"]);
    const directories = new Set(ignored.stdout.trim().split(/\r?\n/));
    return directories.has("ios") && directories.has("android");
  } catch {
    return false;
  }
}

export function dependencyMap(
  packageJson: Record<string, unknown>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const section of ["dependencies", "devDependencies"]) {
    const entries = packageJson[section];
    if (!isRecord(entries)) continue;
    for (const [name, spec] of Object.entries(entries)) {
      if (typeof spec === "string") result[name] = spec;
    }
  }
  return result;
}
