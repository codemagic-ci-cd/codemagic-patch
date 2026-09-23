import path from "node:path";

import { parse as parsePlist } from "plist";

import { ValidationError, type CommandDeps } from "./commands/shared";

import {
  parseXcodeProject,
  resolveXcodeSetting,
  unquoteXcode,
} from "./xcodeProject";

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
  const fail = (detail: string): never => {
    throw new ValidationError(
      `${detail} Pass --target-binary-version or --plist-file explicitly.`,
    );
  };
  const readVersion = async (file: string): Promise<string> => {
    const content = await readUtf8FileOrNull(deps, file);
    if (content === null) return fail(`Could not read Info.plist at ${file}.`);
    let version: string | null;
    try {
      version = parseInfoPlistVersion(content);
    } catch {
      return fail(`Could not parse Info.plist at ${file}.`);
    }
    return (
      version ?? fail(`Could not read CFBundleShortVersionString from ${file}.`)
    );
  };
  const explicitPlist =
    input.plistFile === undefined
      ? undefined
      : resolveProjectPath(input.projectRoot, input.plistFile);
  const explicitVersion =
    explicitPlist === undefined ? undefined : await readVersion(explicitPlist);
  if (
    explicitVersion !== undefined &&
    !containsBuildSettingPlaceholder(explicitVersion)
  ) {
    return { sourcePath: explicitPlist!, version: explicitVersion };
  }
  if (
    explicitVersion !== undefined &&
    !/^\$[({]MARKETING_VERSION[)}]$/.test(explicitVersion)
  ) {
    return fail(
      `Could not resolve the build setting placeholder in ${explicitPlist}.`,
    );
  }
  const projects = await findXcodeProjectCandidates(deps, input);
  if (projects.length === 0) {
    throw new ValidationError(
      `No Xcode project found under ${path.join(input.projectRoot, "ios")}. Pass --xcode-project-file, --plist-file or --target-binary-version explicitly.`,
    );
  }
  const targets = [];
  for (const project of projects) {
    const content = await readUtf8FileOrNull(deps, project);
    if (content === null)
      return fail(`Could not read Xcode project ${project}.`);
    let parsed: ReturnType<typeof parseXcodeProject>;
    try {
      parsed = parseXcodeProject(content);
    } catch {
      return fail(`Could not parse Xcode project ${project}.`);
    }
    const root = path.dirname(path.dirname(project));
    for (const target of parsed.targets) {
      const name = unquoteXcode(target.name);
      if (input.xcodeTargetName !== undefined && name !== input.xcodeTargetName)
        continue;
      const configurations = parsed
        .configurations(target)
        .filter(
          (config) =>
            input.buildConfigurationName === undefined ||
            config.name === input.buildConfigurationName,
        );
      const mapped = configurations.map((config) => {
        const plist = resolveXcodeSetting(
          "INFOPLIST_FILE",
          config.settings,
          root,
        );
        const file =
          plist === undefined ? undefined : path.resolve(root, plist);
        return { ...config, file };
      });
      if (
        explicitPlist !== undefined &&
        !mapped.some((config) => config.file === explicitPlist)
      )
        continue;
      targets.push({ project, root, name, configurations: mapped });
    }
  }
  if (targets.length !== 1) {
    return fail(
      `Could not select one iOS application target${input.xcodeTargetName ? ` named "${input.xcodeTargetName}"` : ""}. Candidates: ${targets.map((t) => `${t.name} (${t.project})`).join(", ") || "none"}. Select --xcode-project-file / --xcode-target-name.`,
    );
  }
  const selected = targets[0];
  let configurations = selected.configurations;
  if (explicitPlist !== undefined)
    configurations = configurations.filter(
      (config) => config.file === explicitPlist,
    );
  if (!configurations.length)
    return fail(
      `No matching build configuration for ${selected.name}. Select --build-configuration-name.`,
    );
  const versions = new Set<string>();
  for (const config of configurations) {
    if (config.file === undefined) {
      return fail(
        `Could not resolve build settings for ${selected.name} (${config.name}); conditional settings, xcconfig values, or generated Info.plist settings require an explicit version.`,
      );
    }
    const file =
      explicitPlist ??
      (input.plistFilePrefix === undefined
        ? config.file
        : path.join(
            path.dirname(config.file),
            `${normalizePlistFilePrefix(input.plistFilePrefix)}Info.plist`,
          ));
    let version = explicitVersion ?? (await readVersion(file));
    if (/^\$\(MARKETING_VERSION\)$|^\$\{MARKETING_VERSION\}$/.test(version)) {
      version =
        resolveXcodeSetting(
          "MARKETING_VERSION",
          config.settings,
          selected.root,
        ) ?? "";
    }
    if (!version || containsBuildSettingPlaceholder(version)) {
      return fail(
        `Could not resolve the build setting placeholder in CFBundleShortVersionString for ${selected.name} (${config.name}); conditional or unresolved settings require --target-binary-version explicitly.`,
      );
    }
    versions.add(version);
  }
  if (versions.size !== 1)
    return fail(
      `Binary versions differ across build configurations for ${selected.name}. Select --build-configuration-name.`,
    );
  return { sourcePath: selected.project, version: [...versions][0] };
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

    const version = await parseGradleVersionName(deps, candidate, content);
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

async function findXcodeProjectCandidates(
  deps: Pick<CommandDeps, "readDirectory" | "stat">,
  input: ResolveTargetBinaryVersionInput,
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
  // Use directory entries to avoid counting ios and iOS twice on macOS.
  const roots = await deps.readDirectory(input.projectRoot);
  for (const entry of roots) {
    if (entry.isDirectory() && entry.name.toLowerCase() === "ios") {
      await collectXcodeProjectFiles(
        deps,
        path.join(input.projectRoot, entry.name),
        candidates,
        0,
      );
    }
  }

  return [...new Set(candidates)].sort();
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

function androidVersionError(reason: string): ValidationError {
  return new ValidationError(
    `${reason} Pass --target-binary-version <version> explicitly.`,
  );
}

async function parseGradleVersionName(
  deps: Pick<CommandDeps, "readFile" | "stat">,
  gradleFile: string,
  content: string,
): Promise<string | null> {
  // Only interpret direct static declarations. Keep strings intact and check
  // every scope, including conditional blocks that could override the version.
  const tokens = (
    content.match(
      /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:[\w$]+|`[^`\r\n]+`)(?:\.(?:[\w$]+|`[^`\r\n]+`))*|\n|[^\s]/gu,
    ) ?? []
  ).filter((token) => !token.startsWith("//") && !token.startsWith("/*"));
  const scopes: string[] = [];
  let statement: string[] = [];
  const values = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "{") {
      scopes.push(statement.join(""));
      statement = [];
    } else if (token === "}") {
      scopes.pop();
      statement = [];
    } else if (token === "\n" || token === ";") {
      statement = [];
    } else if (isGradleVersionWrite(tokens, index)) {
      if (
        scopes.join("/") !== "android/defaultConfig" ||
        statement.length > 0 ||
        (token !== "versionName" && token !== "versionNameSuffix") ||
        values.has(token)
      ) {
        const scope = scopes.length
          ? `the ${scopes.join(".")} block`
          : "the top-level script";
        throw androidVersionError(
          `Android ${token} is written in ${scope}; only one direct versionName/versionNameSuffix declaration in android.defaultConfig is supported.`,
        );
      }
      const expression: string[] = [];
      while (
        index + 1 < tokens.length &&
        !["\n", ";", "}"].includes(tokens[index + 1])
      ) {
        expression.push(tokens[++index]);
      }
      if (expression[0] === "=") expression.shift();
      if (expression.length !== 1) {
        throw androidVersionError(`Android ${token} is not a static value.`);
      }
      const raw = expression[0];
      const literal = /^(?:"[^"\\$]*"|'[^'\\]*')$/u.test(raw);
      let value: string | null;
      if (literal) {
        value = raw.slice(1, -1);
      } else if (
        token === "versionName" &&
        /^(?:project\.)?[A-Za-z_][A-Za-z0-9_]*$/u.test(raw)
      ) {
        value = await readGradleProperty(
          deps,
          gradleFile,
          raw.replace(/^project\./u, ""),
        );
      } else {
        throw androidVersionError(
          `Android ${token} is not a supported static value.`,
        );
      }
      if (value === null) {
        throw androidVersionError(
          `Android ${token} "${raw}" is an unresolved Gradle variable.`,
        );
      }
      values.set(token, value);
    } else {
      statement.push(token);
    }
  }
  const version = values.get("versionName");
  return version?.trim()
    ? version + (values.get("versionNameSuffix") ?? "")
    : null;
}

// Gradle properties whose writes change the versionName devices report,
// including AGP's per-output override. Only the first two are supported as
// direct android.defaultConfig declarations; every other write is rejected.
const GRADLE_VERSION_PROPERTY_PATTERN =
  /(?:^|\.)(versionName(?:Suffix|Override)?|setVersionName(?:Suffix|Override)?)(?:\.(.*))?$/u;

function isGradleVersionWrite(tokens: string[], index: number): boolean {
  // Escaped Kotlin identifiers name the same properties; detect their writes
  // even though only ordinary direct declarations are supported above.
  const member = GRADLE_VERSION_PROPERTY_PATTERN.exec(
    tokens[index].replace(/`/gu, ""),
  );
  if (member === null) return false;

  const next = tokens[index + 1];
  const following = tokens[index + 2];
  if (next === "as" || next === "is") return false;
  // Calls on the value (e.g. versionName.toString()) only read it; a
  // Property.set(...) call changes it and must still be rejected.
  if (member[2] !== undefined) return member[2] === "set" && next === "(";
  if (next === "=" && following !== "=") return true;
  if (["+", "-", "*", "/", "%"].includes(next) && following === "=")
    return true;
  if (
    (["+", "-"].includes(next) && following === next) ||
    (["+", "-"].includes(tokens[index - 1]) &&
      tokens[index - 2] === tokens[index - 1])
  )
    return true;

  // Both Groovy command syntax and parenthesized setter calls are writes.
  // Delimiters/operators following a property reference are reads instead.
  return next === "(" || /^(?:["']|[A-Za-z_$0-9])/u.test(next ?? "");
}

async function readGradleProperty(
  deps: Pick<CommandDeps, "readFile" | "stat">,
  gradleFile: string,
  propertyName: string,
): Promise<string | null> {
  const moduleDirectory = path.dirname(gradleFile);
  let root = moduleDirectory;
  while (
    (await readUtf8FileOrNull(deps, path.join(root, "settings.gradle"))) ===
      null &&
    (await readUtf8FileOrNull(deps, path.join(root, "settings.gradle.kts"))) ===
      null
  ) {
    const parent = path.dirname(root);
    if (parent === root) {
      throw androidVersionError(
        "Could not locate the Gradle settings file for Android version properties.",
      );
    }
    root = parent;
  }
  for (const directory of new Set([moduleDirectory, root])) {
    const content = await readUtf8FileOrNull(
      deps,
      path.join(directory, "gradle.properties"),
    );
    if (content === null) continue;
    const value = parseGradlePropertiesValue(content, propertyName);
    if (value !== null) return value;
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

function iosCandidateScore(candidate: string): number {
  const normalized = candidate.replaceAll("\\", "/").toLowerCase();
  return normalized.includes("test") ? 1 : 0;
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

  if (
    value.split(".").some((segment) => WILDCARD_VERSION_SEGMENTS.has(segment))
  ) {
    throw new ValidationError(message);
  }
}
