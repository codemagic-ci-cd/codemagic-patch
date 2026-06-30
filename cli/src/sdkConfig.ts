import path from "node:path";

import { XMLParser } from "fast-xml-parser";
import { parse as parsePlist } from "plist";

import type { CommandDeps } from "./commands/shared";
import { findIosInfoPlistCandidates } from "./targetBinaryVersion";

// The native client SDK reads these from Info.plist (iOS) and strings.xml
// (Android); the config plugin writes them (see client/plugin/src/withIosConfig.ts
// and withAndroidConfig.ts). We read the same two keys to discover where the
// previous release's bundle lives, for base-bytecode acquisition.
const DOWNLOAD_BASE_URL_KEY = "CodemagicPatchDownloadBaseUrl";
const DEPLOYMENT_KEY_KEY = "CodemagicPatchDeploymentKey";

export type SdkDeliveryConfig = {
  deploymentKey?: string;
  downloadBaseUrl?: string;
};

export type ReadSdkDeliveryConfigInput = {
  platform: "android" | "ios";
  plistFile?: string;
  plistFilePrefix?: string;
  projectRoot: string;
};

/**
 * Read the client SDK's delivery configuration (download base URL + deployment
 * key) from the native project. Every value is best-effort: a missing file,
 * unparseable content, missing key, or a build-time placeholder yields
 * `undefined` for that value so the caller can skip the optimization.
 */
export async function readSdkDeliveryConfig(
  deps: Pick<CommandDeps, "readDirectory" | "readFile" | "stat">,
  input: ReadSdkDeliveryConfigInput,
): Promise<SdkDeliveryConfig> {
  try {
    return input.platform === "ios"
      ? await readIosSdkDeliveryConfig(deps, input)
      : await readAndroidSdkDeliveryConfig(deps, input);
  } catch {
    // Discovery is purely an optimization; never let a malformed native config
    // surface as a release failure.
    return {};
  }
}

async function readIosSdkDeliveryConfig(
  deps: Pick<CommandDeps, "readDirectory" | "readFile" | "stat">,
  input: ReadSdkDeliveryConfigInput,
): Promise<SdkDeliveryConfig> {
  const candidates =
    input.plistFile === undefined
      ? await findIosInfoPlistCandidates(
          deps,
          input.projectRoot,
          input.plistFilePrefix,
        )
      : [resolveProjectPath(input.projectRoot, input.plistFile)];

  // A multi-target project has several Info.plists (app, extensions, tests), and
  // the candidate order is not guaranteed to put the app target first. Prefer a
  // plist that carries BOTH keys (the fully-configured app target) over an
  // earlier-sorting one that happens to carry only one — the caller needs both,
  // so a single-key plist short-circuiting the complete one would lose the
  // optimization. Keep the first single-key partial only as a last resort, and
  // never combine keys across plists (a URL from one target paired with a key
  // from another would be a mismatched, wrong config).
  let firstPartial: SdkDeliveryConfig | undefined;

  for (const candidate of candidates) {
    const content = await readUtf8FileOrNull(deps, candidate);
    if (content === null) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = parsePlist(content) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }

    const config = pickConfig(
      parsed[DOWNLOAD_BASE_URL_KEY],
      parsed[DEPLOYMENT_KEY_KEY],
    );
    if (
      config.downloadBaseUrl !== undefined &&
      config.deploymentKey !== undefined
    ) {
      return config;
    }
    if (
      firstPartial === undefined &&
      (config.downloadBaseUrl !== undefined ||
        config.deploymentKey !== undefined)
    ) {
      firstPartial = config;
    }
  }

  return firstPartial ?? {};
}

async function readAndroidSdkDeliveryConfig(
  deps: Pick<CommandDeps, "readFile" | "stat">,
  input: ReadSdkDeliveryConfigInput,
): Promise<SdkDeliveryConfig> {
  const stringsPath = path.join(
    input.projectRoot,
    "android",
    "app",
    "src",
    "main",
    "res",
    "values",
    "strings.xml",
  );
  const content = await readUtf8FileOrNull(deps, stringsPath);
  if (content === null) {
    return {};
  }

  const strings = parseAndroidStringResources(content);
  return pickConfig(strings[DOWNLOAD_BASE_URL_KEY], strings[DEPLOYMENT_KEY_KEY]);
}

function parseAndroidStringResources(content: string): Record<string, string> {
  // A parser (not a regex) is required because OTA URLs carry query params and
  // strings.xml entity-encodes `&` as `&amp;`, which the parser decodes.
  const parser = new XMLParser({
    attributeNamePrefix: "@_",
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: true,
  });

  let document: unknown;
  try {
    document = parser.parse(content);
  } catch {
    return {};
  }

  if (!isRecord(document) || !isRecord(document.resources)) {
    return {};
  }

  const stringNodes = document.resources.string;
  const nodes = Array.isArray(stringNodes)
    ? stringNodes
    : stringNodes !== undefined
      ? [stringNodes]
      : [];

  const result: Record<string, string> = {};
  for (const node of nodes) {
    if (!isRecord(node)) {
      continue;
    }
    const name = node["@_name"];
    if (typeof name !== "string") {
      continue;
    }
    const value = node["#text"];
    if (typeof value === "string") {
      result[name] = value;
    } else if (typeof value === "number") {
      result[name] = String(value);
    }
  }

  return result;
}

function pickConfig(
  rawDownloadBaseUrl: unknown,
  rawDeploymentKey: unknown,
): SdkDeliveryConfig {
  const downloadBaseUrl = usableValue(rawDownloadBaseUrl);
  const deploymentKey = usableValue(rawDeploymentKey);
  return {
    ...(downloadBaseUrl !== undefined ? { downloadBaseUrl } : {}),
    ...(deploymentKey !== undefined ? { deploymentKey } : {}),
  };
}

function usableValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  // Unresolved iOS build-setting placeholder, e.g. `$(CODEMAGIC_PATCH_URL)`.
  if (trimmed.startsWith("$(") || trimmed.startsWith("${")) {
    return undefined;
  }

  // Unresolved Android resource reference, e.g. `@string/...` or `@null`.
  if (trimmed.startsWith("@")) {
    return undefined;
  }

  return trimmed;
}

function resolveProjectPath(projectRoot: string, inputPath: string): string {
  return path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(projectRoot, inputPath);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
