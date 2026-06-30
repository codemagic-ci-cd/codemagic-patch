import { createRequire } from "node:module";
import path from "node:path";

import { parseText as parseGradleText } from "gradle-to-js/lib/parser";
import { parse as parsePlist } from "plist";

import { ValidationError, type CommandDeps } from "./commands/shared";

const requireFromCurrentFile = createRequire(__filename);
const xcodeParser = requireFromCurrentFile("xcode") as typeof import("xcode");

type TargetBinaryPlatform = "android" | "ios";

type ResolveTargetBinaryVersionInput = {
  buildConfigurationName?: string;
  explicitTargetBinaryVersion?: string;
  gradleFile?: string;
  platform: TargetBinaryPlatform;
  plistFile?: string;
  plistFilePrefix?: string;
  projectRoot: string;
  xcodeProjectFile?: string;
  xcodeTargetName?: string;
};

type GradleModel = {
  android?: unknown;
};

type GradleAndroidBlock = {
  defaultConfig?: {
    versionName?: unknown;
  };
};

type PlistModel = {
  CFBundleShortVersionString?: unknown;
};

// Mirrors the server-side rule in server/src/plugins/api/binaryVersion.ts:
// binary_version is embedded in delivery object keys and fetch URL path
// segments, so the server restricts it to path-safe characters. The CLI does
// not enforce any format on release; this mirror exists only for doctor
// preflight diagnostics.
const BINARY_VERSION_MAX_LENGTH = 128;
const PATH_SAFE_BINARY_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/;

const IGNORED_IOS_DIRECTORY_NAMES = new Set([
  ".git",
  "build",
  "DerivedData",
  "Pods",
]);

export async function resolveTargetBinaryVersion(
  deps: Pick<CommandDeps, "readDirectory" | "readFile" | "stat">,
  input: ResolveTargetBinaryVersionInput,
): Promise<string> {
  if (input.explicitTargetBinaryVersion !== undefined) {
    return input.explicitTargetBinaryVersion;
  }

  const detected =
    input.platform === "ios"
      ? await detectIosTargetBinaryVersion(deps, input)
      : await detectAndroidTargetBinaryVersion(deps, input);

  return detected.version;
}

async function detectIosTargetBinaryVersion(
  deps: Pick<CommandDeps, "readDirectory" | "readFile" | "stat">,
  input: ResolveTargetBinaryVersionInput,
): Promise<{ sourcePath: string; version: string }> {
  const candidates =
    input.plistFile === undefined
      ? await findIosInfoPlistCandidates(
          deps,
          input.projectRoot,
          input.plistFilePrefix,
        )
      : [resolveProjectPath(input.projectRoot, input.plistFile)];

  if (candidates.length === 0) {
    throw new ValidationError(
      `Could not detect target binary version for ios project at ${input.projectRoot}. Pass --target-binary-version or --plist-file.`,
    );
  }

  let sawUnresolvedPlaceholder = false;

  for (const candidate of candidates) {
    const content = await readUtf8FileOrNull(deps, candidate);
    if (content === null) {
      continue;
    }

    let plistVersion: string | null;
    try {
      plistVersion = parseInfoPlistVersion(content);
    } catch {
      throw new ValidationError(
        `Could not parse Info.plist at ${candidate}. Pass --target-binary-version explicitly.`,
      );
    }
    if (plistVersion === null) {
      continue;
    }

    if (plistVersion === "$(MARKETING_VERSION)") {
      const marketingVersion = await detectIosMarketingVersion(
        deps,
        input,
        candidate,
      );
      if (marketingVersion !== null) {
        return marketingVersion;
      }

      sawUnresolvedPlaceholder = true;
      continue;
    }

    if (containsBuildSettingPlaceholder(plistVersion)) {
      sawUnresolvedPlaceholder = true;
      continue;
    }

    return { sourcePath: candidate, version: plistVersion };
  }

  if (sawUnresolvedPlaceholder) {
    throw new ValidationError(
      `Could not resolve the build setting placeholder in CFBundleShortVersionString from ${formatCandidateList(candidates)}. Pass --target-binary-version explicitly.`,
    );
  }

  throw new ValidationError(
    `Could not read CFBundleShortVersionString from ${formatCandidateList(candidates)}. Pass --target-binary-version explicitly.`,
  );
}

async function detectAndroidTargetBinaryVersion(
  deps: Pick<CommandDeps, "readFile" | "stat">,
  input: ResolveTargetBinaryVersionInput,
): Promise<{ sourcePath: string; version: string }> {
  const candidates = androidGradleCandidates(input);

  for (const candidate of candidates) {
    const content = await readUtf8FileOrNull(deps, candidate);
    if (content === null) {
      continue;
    }

    const version = await parseGradleVersionName(
      deps,
      input.projectRoot,
      content,
    );
    if (version !== null) {
      return { sourcePath: candidate, version };
    }
  }

  throw new ValidationError(
    `Could not detect target binary version for android project at ${input.projectRoot}. Pass --target-binary-version or --gradle-file.`,
  );
}

export async function findIosInfoPlistCandidates(
  deps: Pick<CommandDeps, "readDirectory" | "stat">,
  projectRoot: string,
  plistFilePrefix: string | undefined,
): Promise<string[]> {
  const expectedFilename = `${normalizePlistFilePrefix(plistFilePrefix)}Info.plist`;
  const candidates: string[] = [];

  for (const iosRootName of ["ios", "iOS"]) {
    await collectMatchingFiles(
      deps,
      path.join(projectRoot, iosRootName),
      expectedFilename,
      candidates,
      0,
    );
  }

  return [...new Set(candidates)].sort((left, right) => {
    const leftScore = iosCandidateScore(left);
    const rightScore = iosCandidateScore(right);

    return leftScore - rightScore || left.localeCompare(right);
  });
}

function normalizePlistFilePrefix(plistFilePrefix: string | undefined): string {
  if (plistFilePrefix === undefined) {
    return "";
  }

  return /.+[^-.]$/.test(plistFilePrefix)
    ? `${plistFilePrefix}-`
    : plistFilePrefix;
}

async function collectMatchingFiles(
  deps: Pick<CommandDeps, "readDirectory" | "stat">,
  directory: string,
  filename: string,
  candidates: string[],
  depth: number,
): Promise<void> {
  if (depth > 4) {
    return;
  }

  let entries: Awaited<ReturnType<typeof deps.readDirectory>>;
  try {
    entries = await deps.readDirectory(directory);
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === filename) {
      candidates.push(entryPath);
      continue;
    }

    if (
      entry.isDirectory() &&
      !IGNORED_IOS_DIRECTORY_NAMES.has(entry.name) &&
      !entry.name.endsWith(".xcodeproj") &&
      !entry.name.endsWith(".xcworkspace")
    ) {
      await collectMatchingFiles(
        deps,
        entryPath,
        filename,
        candidates,
        depth + 1,
      );
    }
  }
}

function parseInfoPlistVersion(content: string): string | null {
  const parsed = parsePlist(content) as PlistModel;
  const version = parsed.CFBundleShortVersionString;
  if (typeof version !== "string") {
    return null;
  }

  const trimmed = version.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function detectIosMarketingVersion(
  deps: Pick<CommandDeps, "readDirectory" | "readFile" | "stat">,
  input: ResolveTargetBinaryVersionInput,
  plistPath: string,
): Promise<{ sourcePath: string; version: string } | null> {
  const candidates = await findXcodeProjectCandidates(deps, input, plistPath);

  for (const candidate of candidates) {
    const version = readXcodeMarketingVersion(candidate, input);
    if (version !== null) {
      return {
        sourcePath: candidate,
        version,
      };
    }
  }

  return null;
}

async function findXcodeProjectCandidates(
  deps: Pick<CommandDeps, "readDirectory" | "stat">,
  input: ResolveTargetBinaryVersionInput,
  plistPath: string,
): Promise<string[]> {
  if (input.xcodeProjectFile !== undefined) {
    const resolved = resolveProjectPath(
      input.projectRoot,
      input.xcodeProjectFile,
    );
    return [
      resolved.endsWith("project.pbxproj")
        ? resolved
        : path.join(resolved, "project.pbxproj"),
    ];
  }

  const candidates: string[] = [];
  for (const iosRootName of ["ios", "iOS"]) {
    await collectXcodeProjectFiles(
      deps,
      path.join(input.projectRoot, iosRootName),
      candidates,
      0,
    );
  }

  return [...new Set(candidates)].sort((left, right) => {
    const leftScore = xcodeCandidateScore(left, plistPath);
    const rightScore = xcodeCandidateScore(right, plistPath);

    return leftScore - rightScore || left.localeCompare(right);
  });
}

async function collectXcodeProjectFiles(
  deps: Pick<CommandDeps, "readDirectory" | "stat">,
  directory: string,
  candidates: string[],
  depth: number,
): Promise<void> {
  if (depth > 3) {
    return;
  }

  let entries: Awaited<ReturnType<typeof deps.readDirectory>>;
  try {
    entries = await deps.readDirectory(directory);
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isFile() && entry.name === "project.pbxproj") {
      candidates.push(entryPath);
      continue;
    }

    if (
      entry.isDirectory() &&
      !IGNORED_IOS_DIRECTORY_NAMES.has(entry.name) &&
      !entry.name.endsWith(".xcworkspace")
    ) {
      await collectXcodeProjectFiles(deps, entryPath, candidates, depth + 1);
    }
  }
}

function readXcodeMarketingVersion(
  pbxprojPath: string,
  input: Pick<
    ResolveTargetBinaryVersionInput,
    "buildConfigurationName" | "xcodeTargetName"
  >,
): string | null {
  let marketingVersion: unknown;

  try {
    const project = xcodeParser.project(pbxprojPath).parseSync();
    marketingVersion = project.getBuildProperty(
      "MARKETING_VERSION",
      input.buildConfigurationName,
      input.xcodeTargetName,
    );
  } catch {
    return null;
  }

  if (typeof marketingVersion !== "string") {
    return null;
  }

  const version = trimWrappingQuotes(marketingVersion.trim());
  if (version.length === 0 || containsBuildSettingPlaceholder(version)) {
    return null;
  }

  return version;
}

async function parseGradleVersionName(
  deps: Pick<CommandDeps, "readFile" | "stat">,
  projectRoot: string,
  content: string,
): Promise<string | null> {
  const parsed = (await parseGradleText(content)) as GradleModel;
  const versionName = extractGradleVersionName(parsed);

  if (versionName === null) {
    return null;
  }

  const appVersion = trimWrappingQuotes(versionName).trim();
  if (appVersion.length === 0) {
    return null;
  }

  if (/^\d/u.test(appVersion)) {
    return appVersion;
  }

  const propertyName = appVersion.replace(/^project\./u, "");
  const resolved = await readGradleProperty(deps, projectRoot, propertyName);
  if (resolved !== null) {
    return resolved.trim().length > 0 ? resolved : null;
  }

  // gradle.properties didn't define it. If the token is a Gradle variable
  // expression (dotted member access like `rootProject.ext.versionName`, or a
  // `$`-interpolation), DO NOT fall back to the literal text: it would become
  // the targetBinaryVersion verbatim and match zero installed devices, with a
  // success-looking publish. Fail loudly so the user passes an explicit
  // version. A bare literal token (e.g. "latest", "beta1") is preserved here
  // and validated later by assertExplicitBinaryVersion at release time.
  if (isUnresolvedGradleVariable(appVersion)) {
    throw new ValidationError(
      `Android versionName "${appVersion}" is an unresolved Gradle variable ` +
        "(not defined in gradle.properties). Pass --target-binary-version <version> explicitly.",
    );
  }

  return appVersion.trim().length > 0 ? appVersion : null;
}

// A dotted identifier path (rootProject.ext.versionName, project.VERSION_NAME):
// every dot-separated segment is a Java/Kotlin identifier. This deliberately
// excludes letter-prefixed literal versions like `v1.2.3`, whose numeric
// segments don't start with an identifier character.
const GRADLE_DOTTED_IDENTIFIER =
  /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/u;

function isUnresolvedGradleVariable(value: string): boolean {
  return value.includes("$") || GRADLE_DOTTED_IDENTIFIER.test(value);
}

function extractGradleVersionName(parsed: GradleModel): string | null {
  const androidBlocks = Array.isArray(parsed.android)
    ? parsed.android
    : [parsed.android];

  for (const androidBlock of androidBlocks) {
    if (!isGradleAndroidBlock(androidBlock)) {
      continue;
    }

    const versionName = androidBlock.defaultConfig?.versionName;
    if (typeof versionName === "string") {
      return versionName;
    }
  }

  return null;
}

function isGradleAndroidBlock(value: unknown): value is GradleAndroidBlock {
  return typeof value === "object" && value !== null;
}

async function readGradleProperty(
  deps: Pick<CommandDeps, "readFile" | "stat">,
  projectRoot: string,
  propertyName: string,
): Promise<string | null> {
  const candidates = [
    path.join(projectRoot, "android", "app", "gradle.properties"),
    path.join(projectRoot, "android", "gradle.properties"),
  ];

  for (const candidate of candidates) {
    const content = await readUtf8FileOrNull(deps, candidate);
    if (content === null) {
      continue;
    }

    const value = parseGradlePropertiesValue(content, propertyName);
    if (value !== null) {
      return value;
    }
  }

  return null;
}

function parseGradlePropertiesValue(
  content: string,
  propertyName: string,
): string | null {
  for (const line of content.split(/\r?\n/u)) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0 || trimmedLine.startsWith("#")) {
      continue;
    }

    const equalsIndex = trimmedLine.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }

    const key = trimmedLine.slice(0, equalsIndex).trim();
    if (key === propertyName) {
      return trimmedLine.slice(equalsIndex + 1).trim();
    }
  }

  return null;
}

function androidGradleCandidates(
  input: ResolveTargetBinaryVersionInput,
): string[] {
  if (input.gradleFile === undefined) {
    return [
      path.join(input.projectRoot, "android", "app", "build.gradle"),
      path.join(input.projectRoot, "android", "app", "build.gradle.kts"),
    ];
  }

  const resolved = resolveProjectPath(input.projectRoot, input.gradleFile);
  return [
    resolved,
    path.join(resolved, "build.gradle"),
    path.join(resolved, "build.gradle.kts"),
  ];
}

function trimWrappingQuotes(value: string): string {
  return value.replace(/^["']|["']$/gu, "");
}

async function readUtf8FileOrNull(
  deps: Pick<CommandDeps, "readFile" | "stat">,
  filePath: string,
): Promise<string | null> {
  try {
    const stats = await deps.stat(filePath);
    if (!stats.isFile()) {
      return null;
    }

    return (await deps.readFile(filePath)).toString("utf8");
  } catch {
    return null;
  }
}

function resolveProjectPath(projectRoot: string, inputPath: string): string {
  return path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(projectRoot, inputPath);
}

function formatCandidateList(candidates: string[]): string {
  return candidates.length === 1
    ? candidates[0]
    : `any of: ${candidates.join(", ")}`;
}

function iosCandidateScore(candidate: string): number {
  const normalized = candidate.replaceAll("\\", "/").toLowerCase();
  return normalized.includes("test") ? 1 : 0;
}

function xcodeCandidateScore(candidate: string, plistPath: string): number {
  const xcodeProjectName = path.basename(path.dirname(candidate), ".xcodeproj");
  const plistDirectoryName = path.basename(path.dirname(plistPath));

  return xcodeProjectName === plistDirectoryName ? 0 : 1;
}

function containsBuildSettingPlaceholder(value: string): boolean {
  return value.includes("$(") || value.includes("${");
}

export function isPathSafeBinaryVersion(value: string): boolean {
  return (
    value.length <= BINARY_VERSION_MAX_LENGTH &&
    PATH_SAFE_BINARY_VERSION_PATTERN.test(value)
  );
}

// Wildcard/dynamic-version segments that are path-safe but match no exact
// version: npm-style `x`/`X`, Gradle's dynamic `+`, and `*`.
const WILDCARD_VERSION_SEGMENTS = new Set(["x", "X", "*", "+"]);

/**
 * Reject range/wildcard target-binary-version tokens at release time. The
 * server matches binary versions exactly, so a value like `1.2.x`, `1.1.*`,
 * `1.2.+`, `>=1.2.0`, or a tag like `latest` matches no installed app version
 * and the update silently reaches 0 devices. `isPathSafeBinaryVersion` already
 * rejects `*`, comparison operators, and whitespace (they fall outside the
 * path-safe charset), but `1.2.x`/`1.2.+` (path-safe) and digit-less tags need
 * extra guards.
 */
export function assertExplicitBinaryVersion(value: string): void {
  const message =
    "--target-binary-version must be an exact version like 1.2.0, " +
    `not a range or wildcard (got "${value}").`;

  if (!isPathSafeBinaryVersion(value)) {
    throw new ValidationError(message);
  }

  // A real binary version always carries a digit; reject digit-less tags
  // ("latest") and unresolved identifiers that would match zero devices.
  if (!/[0-9]/u.test(value)) {
    throw new ValidationError(message);
  }

  if (value.split(".").some((segment) => WILDCARD_VERSION_SEGMENTS.has(segment))) {
    throw new ValidationError(message);
  }
}
