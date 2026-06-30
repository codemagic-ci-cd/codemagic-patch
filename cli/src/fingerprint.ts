import { resolve } from "node:path";

import { createFingerprintAsync } from "@expo/fingerprint";

import { ValidationError } from "./commands/shared";

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
  },
) => Promise<NativeFingerprint>;

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
      const fingerprint = await createFingerprint(projectRoot, {
        platforms: [input.platform],
        silent: true,
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
