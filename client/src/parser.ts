import type {
  ManifestResponse,
  MetaResponse,
  PreviousPackageInfo,
} from "./types";
import { compareBinaryVersionPrecedence } from "./version";

const PACKAGE_HASH_PATTERN = /^[a-f0-9]{64}$/;

export interface StoreUpdateMetadata {
  isStoreUpdateAvailable: boolean;
  latestBinaryVersion: string | null;
}

function isValidPackageHash(value: unknown): value is string {
  return typeof value === "string" && PACKAGE_HASH_PATTERN.test(value);
}

function parseJsonObjectOrNull(
  json: string | null,
): Record<string, unknown> | null {
  if (json === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isMetaResponse(value: unknown): value is MetaResponse {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { latest_binary_version?: unknown })
      .latest_binary_version === "string"
  );
}

function isValidPreviousPackageInfo(
  value: unknown,
): value is PreviousPackageInfo {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const obj = value as Record<string, unknown>;

  return (
    isValidPackageHash(obj.package_hash) &&
    typeof obj.release_label === "string" &&
    typeof obj.full_bundle_url === "string" &&
    typeof obj.full_bundle_size === "number" &&
    typeof obj.is_mandatory === "boolean" &&
    typeof obj.rollout_percentage === "number"
  );
}

export function parseManifestJson(
  manifestJson: string | null,
): ManifestResponse | null {
  if (manifestJson === null) {
    return null;
  }

  try {
    return parseManifest(JSON.parse(manifestJson) as unknown);
  } catch {
    return null;
  }
}

/**
 * Parse and validate a raw manifest response.
 * Returns null if the input is malformed or fails schema validation.
 */
export function parseManifest(raw: unknown): ManifestResponse | null {
  if (raw === null || raw === undefined || typeof raw !== "object") {
    return null;
  }

  const obj = raw as Record<string, unknown>;

  if (!("target_package_hash" in obj)) {
    return null;
  }

  const targetHash = obj.target_package_hash;

  if (targetHash !== null && !isValidPackageHash(targetHash)) {
    return null;
  }

  if (targetHash !== null) {
    if (
      typeof obj.full_bundle_url !== "string" ||
      typeof obj.full_bundle_size !== "number"
    ) {
      return null;
    }

    if (typeof obj.release_label !== "string") {
      return null;
    }

    if (typeof obj.is_mandatory !== "boolean") {
      return null;
    }

    if (typeof obj.rollout_percentage !== "number") {
      return null;
    }
  }

  if (
    obj.previous_package_info !== undefined &&
    !isValidPreviousPackageInfo(obj.previous_package_info)
  ) {
    return null;
  }

  return raw as ManifestResponse;
}

export function parseStoreUpdateMetadata(
  metaJson: string | null,
  binaryVersion: string | null,
): StoreUpdateMetadata {
  const meta = parseJsonObjectOrNull(metaJson);

  if (!isMetaResponse(meta) || binaryVersion === null) {
    return {
      isStoreUpdateAvailable: false,
      latestBinaryVersion: null,
    };
  }

  // Surface the hint only when the deployment's binary version is strictly
  // higher than the client's. Opaque tokens that cannot be ordered
  // (comparison is null) never trigger a hint. The token is still reported so
  // callers can read what the server selected.
  const comparison = compareBinaryVersionPrecedence(
    meta.latest_binary_version,
    binaryVersion,
  );

  return {
    isStoreUpdateAvailable: comparison !== null && comparison > 0,
    latestBinaryVersion: meta.latest_binary_version,
  };
}
