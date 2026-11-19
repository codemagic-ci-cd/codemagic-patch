// Which calculator computes a project's native fingerprint (specs/build-metadata.md §6.1).
//
// - Adopted path: the project has an SDK whose package.json declares the
//   `./build-tools/fingerprint` export. That entry is loaded in process and
//   its `computeNativeFingerprint` result's `fingerprint` and `engine` are what
//   the CLI reports, verbatim.
//   The SDK owns validation on this path (including Expo CNG projects).
// - Legacy path: the SDK is not installed, or it does not declare the export.
//   The CLI's own calculator (./fingerprint.ts) runs, unchanged.
//
// The choice is made by looking at the installed SDK, never by trying the
// calculator and falling back when it fails: a declared calculator that cannot
// be loaded, has an unsupported contract, throws or returns no usable value is
// a ValidationError.

import { readFileSync } from "node:fs";
import path from "node:path";

import { ValidationError } from "./commands/shared";
import type {
  FingerprintPlatform,
  FingerprintSource,
  NativeFingerprintDetails,
} from "./fingerprint";
import { createProjectRequire } from "./projectRequire";
import { getCliVersion } from "./version";

export const SDK_PACKAGE_NAME = "@codemagic/react-native-patch";
export const SDK_CALCULATOR_EXPORT = "./build-tools/fingerprint";
/** The SDK build-tools contract this CLI knows how to call. */
export const SUPPORTED_BUILD_TOOLS_CONTRACT = 1;

const SDK_CALCULATOR_SPECIFIER = `${SDK_PACKAGE_NAME}/build-tools/fingerprint`;
const REINSTALL = "Reinstall the project's dependencies and try again.";
const REINSTALL_OR_UPDATE =
  "Reinstall the project's dependencies; if that does not help, update cmpatch.";

export type ProjectFingerprintInput = {
  platform: FingerprintPlatform;
  projectRoot: string;
};

type DetailsComputer = (
  input: ProjectFingerprintInput,
) => Promise<NativeFingerprintDetails>;

type InstalledSdk = {
  /** Directory of the SDK's package.json. */
  root: string;
  version: string | undefined;
  declaresCalculator: boolean;
};

export function createProjectFingerprintResolver(options: {
  /** The CLI's own calculator, used when the project's SDK has none. */
  legacy: DetailsComputer;
}): {
  computeFingerprint: (input: ProjectFingerprintInput) => Promise<string>;
  computeFingerprintDetails: DetailsComputer;
} {
  const computeFingerprintDetails: DetailsComputer = async (input) => {
    const projectRoot = path.resolve(input.projectRoot);
    const sdk = findInstalledSdk(projectRoot);

    if (sdk === undefined || !sdk.declaresCalculator) {
      return options.legacy(input);
    }

    return computeWithSdkCalculator(sdk, input.platform, projectRoot);
  };

  return {
    computeFingerprint: async (input) =>
      (await computeFingerprintDetails(input)).fingerprint,
    computeFingerprintDetails,
  };
}

/** The SDK as installed for `projectRoot`, or undefined when it is not installed. */
function findInstalledSdk(projectRoot: string): InstalledSdk | undefined {
  let packageJsonPath: string;
  try {
    packageJsonPath = createProjectRequire(projectRoot).resolve(
      `${SDK_PACKAGE_NAME}/package.json`,
    );
  } catch (error) {
    if (errorCode(error) === "MODULE_NOT_FOUND") {
      return undefined;
    }
    throw new ValidationError(
      `Could not resolve ${SDK_PACKAGE_NAME} from ${projectRoot}: ${causeMessage(error)}. ${REINSTALL}`,
    );
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch (error) {
    throw new ValidationError(
      `Could not read ${packageJsonPath}: ${causeMessage(error)}. ${REINSTALL}`,
    );
  }

  const record = isObject(manifest) ? manifest : {};
  const exportsField = record.exports;

  return {
    declaresCalculator:
      isObject(exportsField) && Object.hasOwn(exportsField, SDK_CALCULATOR_EXPORT),
    root: path.dirname(packageJsonPath),
    version: typeof record.version === "string" ? record.version : undefined,
  };
}

async function computeWithSdkCalculator(
  sdk: InstalledSdk,
  platform: FingerprintPlatform,
  projectRoot: string,
): Promise<NativeFingerprintDetails> {
  const calculator = `The fingerprint calculator of ${SDK_PACKAGE_NAME} ${sdk.version ?? "(unknown version)"} at ${sdk.root}`;

  let entry: Record<string, unknown>;
  try {
    const projectRequire = createProjectRequire(projectRoot);
    const loaded: unknown = projectRequire(
      projectRequire.resolve(SDK_CALCULATOR_SPECIFIER),
    );
    entry = isObject(loaded) ? loaded : {};
  } catch (error) {
    const code = thrownErrorCode(error);
    throw new ValidationError(
      `${calculator} could not be loaded${code === undefined ? "" : ` (${code})`}: ${causeMessage(error)}. The package declares ${SDK_CALCULATOR_EXPORT}, so its install is incomplete or damaged. ${REINSTALL}`,
    );
  }

  const contract = entry.BUILD_TOOLS_CONTRACT_VERSION;
  if (contract === undefined) {
    throw new ValidationError(
      `${calculator} does not report a build-tools contract version. ${REINSTALL_OR_UPDATE}`,
    );
  }
  if (contract !== SUPPORTED_BUILD_TOOLS_CONTRACT) {
    throw new ValidationError(
      `${calculator} uses build-tools contract ${formatValue(contract)}, but cmpatch ${getCliVersion()} supports contract ${SUPPORTED_BUILD_TOOLS_CONTRACT}. Update cmpatch and try again.`,
    );
  }

  const compute = entry.computeNativeFingerprint;
  if (typeof compute !== "function") {
    throw new ValidationError(
      `${calculator} does not provide computeNativeFingerprint. ${REINSTALL_OR_UPDATE}`,
    );
  }

  let result: unknown;
  try {
    result = await compute({ appRoot: projectRoot, platform });
  } catch (error) {
    const code = thrownErrorCode(error);
    throw new ValidationError(
      `${calculator} could not compute the ${platform} fingerprint of ${projectRoot}${code === undefined ? "" : ` (${code})`}: ${causeMessage(error)}`,
    );
  }

  const fingerprint = isObject(result) ? result.fingerprint : undefined;
  if (typeof fingerprint !== "string" || !/^[0-9a-f]+$/.test(fingerprint)) {
    throw new ValidationError(
      `${calculator} returned no usable ${platform} fingerprint for ${projectRoot}. ${REINSTALL_OR_UPDATE}`,
    );
  }

  const engine = isObject(result) ? result.engine : undefined;
  if (typeof engine !== "string" || engine.length === 0) {
    throw new ValidationError(
      `${calculator} returned no usable ${platform} fingerprint engine for ${projectRoot}. ${REINSTALL_OR_UPDATE}`,
    );
  }

  return {
    fingerprint,
    engine,
    sources: toSources(isObject(result) ? result.sources : undefined),
  };
}

/** The engine's sources in the shape `fingerprint --verbose` lists. */
function toSources(value: unknown): FingerprintSource[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isObject).map((source) => ({
    type: typeof source.type === "string" ? source.type : String(source.type),
    ...(typeof source.filePath === "string" ? { filePath: source.filePath } : {}),
  }));
}

/**
 * The string `code` the calculator's error carries: a BuildToolsError's own
 * code, or a system error's (`EACCES`). Read by shape, not instanceof, since
 * the error comes from the project's copy of the SDK, another module realm.
 */
function thrownErrorCode(error: unknown): string | undefined {
  const code = errorCode(error);
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

function errorCode(error: unknown): unknown {
  return isObject(error) ? error.code : undefined;
}

/** First line only: Node appends a "Require stack" of file paths to resolution errors. */
function causeMessage(error: unknown): string {
  const message = isObject(error) && typeof error.message === "string" ? error.message : String(error);
  const firstLine = message.split("\n")[0]?.trim() ?? "";
  return firstLine.length > 0 ? firstLine : "unknown error";
}

/** A short rendering of a value the SDK reported, whatever its type. */
function formatValue(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
