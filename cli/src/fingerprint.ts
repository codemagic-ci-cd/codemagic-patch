import { resolve } from "node:path";

import { createFingerprintAsync } from "@expo/fingerprint";

import { ValidationError } from "./commands/shared";
import { detectIosDependencyManager } from "./nativeProjectPaths";

export type FingerprintPlatform = "android" | "ios";
export type FingerprintSource = {
  type: string;
  filePath?: string;
};
type NativeFingerprint = {
  hash: string;
  sources: FingerprintSource[];
};
export type NativeFingerprintDetails = {
  fingerprint: string;
  sources: FingerprintSource[];
};
export type ProjectFingerprintComputer = (
  projectRoot: string,
  options: {
    platforms: FingerprintPlatform[];
    silent: true;
    ignorePaths?: string[];
  },
) => Promise<NativeFingerprint>;

/**
 * Files Xcode writes into a React Native SwiftPM-mode app on a developer's
 * machine. None of them reaches a CI clone or the npm tarball, so opening or
 * building the app locally must not change the hash
 * (wiki/discussions/FINGERPRINT_DISCUSSION.md has the measurements):
 * - `Package.resolved`, written when Xcode resolves the Swift packages and
 *   gitignored by React Native's SwiftPM setup;
 * - per-user IDE state (`xcuserdata`), written as soon as the project is
 *   opened, both in the app's `.xcodeproj` and in the `.swiftpm/xcode` folder
 *   of every local package Xcode shows, the SDK's package root in
 *   `node_modules` included. The leading `**\/` also matches a hoisted
 *   package reached through `../`.
 * @expo/fingerprint's own `**\/ios/**\/project.xcworkspace` ignore does not
 * reach files below that directory. A `!` line in `.fingerprintignore` puts a
 * file back: those lines are applied after these.
 */
export const SWIFTPM_FINGERPRINT_IGNORES: readonly string[] = [
  "ios/**/xcshareddata/swiftpm/Package.resolved",
  "iOS/**/xcshareddata/swiftpm/Package.resolved",
  "**/xcuserdata/**/*",
];

export async function computeNativeFingerprint(input: {
  platform: FingerprintPlatform;
  projectRoot: string;
}): Promise<string> {
  const details = await computeNativeFingerprintDetails(input);

  return details.fingerprint;
}

export async function computeNativeFingerprintDetails(input: {
  platform: FingerprintPlatform;
  projectRoot: string;
}): Promise<NativeFingerprintDetails> {
  return createNativeFingerprintDetailsComputer(createFingerprintAsync)(input);
}

export function createNativeFingerprintComputer(
  createFingerprint: ProjectFingerprintComputer,
): (input: {
  platform: FingerprintPlatform;
  projectRoot: string;
}) => Promise<string> {
  const computeDetails = createNativeFingerprintDetailsComputer(createFingerprint);

  return async (input) => {
    const details = await computeDetails(input);

    return details.fingerprint;
  };
}

export function createNativeFingerprintDetailsComputer(
  createFingerprint: ProjectFingerprintComputer,
): (input: {
  platform: FingerprintPlatform;
  projectRoot: string;
}) => Promise<NativeFingerprintDetails> {
  return async (input) => {
    const projectRoot = resolve(input.projectRoot);

    try {
      // CocoaPods projects and Android keep exactly the options, and so the
      // hashes, that earlier releases computed.
      const swiftPM =
        input.platform === "ios" && (await detectIosDependencyManager(projectRoot)) === "swiftpm";
      const fingerprint = await createFingerprint(projectRoot, {
        platforms: [input.platform],
        silent: true,
        ...(swiftPM ? { ignorePaths: [...SWIFTPM_FINGERPRINT_IGNORES] } : {}),
      });

      if (fingerprint.hash.length === 0) {
        throw new Error("fingerprint hash was empty");
      }

      if (!hasNativePlatformSource(fingerprint.sources, input.platform)) {
        throw new Error(
          `no ${input.platform} native project sources were found`,
        );
      }

      return {
        fingerprint: fingerprint.hash,
        sources: fingerprint.sources,
      };
    } catch (error) {
      throw new ValidationError(
        `Could not compute native fingerprint for ${input.platform} project at ${projectRoot}. Run from the React Native project root or pass --project-root. ${formatErrorSuffix(error)}`,
      );
    }
  };
}

function hasNativePlatformSource(
  sources: FingerprintSource[],
  platform: FingerprintPlatform,
): boolean {
  return sources.some((source) => {
    if (typeof source.filePath !== "string") {
      return false;
    }

    const normalizedPath = source.filePath.replaceAll("\\", "/");
    return normalizedPath === platform || normalizedPath.startsWith(`${platform}/`);
  });
}

function formatErrorSuffix(error: unknown): string {
  if (!(error instanceof Error) || error.message.length === 0) {
    return "";
  }

  return `Cause: ${error.message}`;
}
