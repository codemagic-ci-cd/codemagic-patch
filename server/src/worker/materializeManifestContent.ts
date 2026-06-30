import type { DeliveryAdapter } from "../adapters";
import type {
  ManifestContent,
  ManifestContentDraft,
  PreviousPackageInfo,
  PreviousPackageInfoDraft,
} from "./types";

export function materializeManifestContent(
  content: ManifestContentDraft,
  delivery: DeliveryAdapter,
): ManifestContent {
  const base = {
    isMandatory: content.isMandatory,
    releaseNotes: content.releaseNotes,
    rolloutPercentage: content.rolloutPercentage,
    targetPackageHash: content.targetPackageHash,
  };
  const resolved: ManifestContent = content.bundlePublicKey
    ? {
        ...base,
        fullBundleSize: requireFullBundleSize(content.fullBundleSize),
        fullBundleUrl: delivery.resolveUrl(content.bundlePublicKey),
      }
    : base;

  if (content.releaseLabel) {
    resolved.releaseLabel = content.releaseLabel;
  }

  if (content.patchPublicKey) {
    resolved.patchSize = content.patchSize;
    resolved.patchUrl = delivery.resolveUrl(content.patchPublicKey);
  }

  if (content.signature) {
    resolved.signature = content.signature;
  }

  if (content.previousPackageInfo) {
    resolved.previousPackageInfo = materializePreviousPackageInfo(
      content.previousPackageInfo,
      delivery,
    );
  }

  return resolved;
}

function materializePreviousPackageInfo(
  info: PreviousPackageInfoDraft,
  delivery: DeliveryAdapter,
): PreviousPackageInfo {
  const resolved: PreviousPackageInfo = {
    fullBundleUrl: delivery.resolveUrl(info.bundlePublicKey),
    fullBundleSize: requireFullBundleSize(info.fullBundleSize),
    isMandatory: info.isMandatory,
    packageHash: info.packageHash,
    releaseLabel: info.releaseLabel,
    releaseNotes: info.releaseNotes,
    rolloutPercentage: info.rolloutPercentage,
  };

  if (info.patchPublicKey) {
    resolved.patchSize = info.patchSize;
    resolved.patchUrl = delivery.resolveUrl(info.patchPublicKey);
  }

  if (info.signature) {
    resolved.signature = info.signature;
  }

  return resolved;
}

function requireFullBundleSize(size: number | undefined): number {
  if (size === undefined) {
    throw new Error("fullBundleSize is required when fullBundleUrl is present");
  }

  return size;
}
