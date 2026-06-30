import { createHash } from "node:crypto";

import type {
  DeploymentMeta,
  DeploymentMetaWireFormat,
  ManifestContent,
  ManifestSerializer,
  ManifestWireFormat,
  PreviousPackageInfo,
  PreviousPackageInfoWireFormat,
} from "./types";

export const manifestSerializer: ManifestSerializer = {
  serialize(content: ManifestContent) {
    const wireFormat = toManifestWireFormat(content);
    const json = stableStringify(wireFormat);

    return {
      contentHash: sha256(json),
      json,
    };
  },

  serializeDeploymentMeta(content: DeploymentMeta) {
    const wireFormat = toDeploymentMetaWireFormat(content);
    const json = stableStringify(wireFormat);

    return {
      contentHash: sha256(json),
      json,
    };
  },
};

function toManifestWireFormat(content: ManifestContent): ManifestWireFormat {
  const base = {
    is_mandatory: content.isMandatory,
    patch_size: content.patchSize,
    patch_url: content.patchUrl,
    previous_package_info: content.previousPackageInfo
      ? toPreviousPackageInfoWireFormat(content.previousPackageInfo)
      : undefined,
    release_label: content.releaseLabel,
    release_notes: content.releaseNotes,
    rollout_percentage: content.rolloutPercentage,
    signature: content.signature,
    target_package_hash: content.targetPackageHash,
  };

  return compactObject<ManifestWireFormat>(
    content.fullBundleUrl
      ? {
          ...base,
          full_bundle_size: content.fullBundleSize,
          full_bundle_url: content.fullBundleUrl,
        }
      : base,
  );
}

function toPreviousPackageInfoWireFormat(
  content: PreviousPackageInfo,
): PreviousPackageInfoWireFormat {
  return compactObject<PreviousPackageInfoWireFormat>({
    full_bundle_size: content.fullBundleSize,
    full_bundle_url: content.fullBundleUrl,
    is_mandatory: content.isMandatory,
    package_hash: content.packageHash,
    patch_size: content.patchSize,
    patch_url: content.patchUrl,
    release_label: content.releaseLabel,
    release_notes: content.releaseNotes,
    rollout_percentage: content.rolloutPercentage,
    signature: content.signature,
  });
}

function toDeploymentMetaWireFormat(
  content: DeploymentMeta,
): DeploymentMetaWireFormat {
  return {
    latest_binary_version: content.latestBinaryVersion,
  };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        const child = (value as Record<string, unknown>)[key];
        if (child !== undefined) {
          result[key] = sortValue(child);
        }
        return result;
      }, {});
  }

  return value;
}

function compactObject<T extends object>(value: T): T {
  return Object.entries(value).reduce<Record<string, unknown>>(
    (result, [key, child]) => {
      if (child !== undefined) {
        result[key] = child;
      }
      return result;
    },
    {},
  ) as T;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
