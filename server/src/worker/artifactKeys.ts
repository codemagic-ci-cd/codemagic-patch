import type { ReleaseId } from "../domain/types";

export function makeBundleInternalKey(releaseId: ReleaseId): string {
  return `_internal/releases/${releaseId}/bundle.tar.zst`;
}

export function makeBundlePublicKey(
  deploymentKey: string,
  binaryVersion: string,
  packageHash: string,
): string {
  return `${deploymentKey}/${binaryVersion}/${packageHash}/bundle.tar.zst`;
}

export function makePatchInternalKey(
  releaseId: ReleaseId,
  binaryVersion: string,
  fromPackageHash: string,
  toPackageHash: string,
): string {
  return `_internal/releases/${releaseId}/patches/${binaryVersion}/${toPackageHash}/from/${fromPackageHash}.zst`;
}

export function makePatchPublicKey(
  deploymentKey: string,
  binaryVersion: string,
  toPackageHash: string,
  fromPackageHash: string,
): string {
  return `${deploymentKey}/${binaryVersion}/${toPackageHash}/patches/${fromPackageHash}.zst`;
}

export function makeManifestPublicKey(
  deploymentKey: string,
  binaryVersion: string,
  currentPackageHash: string,
): string {
  return `${deploymentKey}/${binaryVersion}/${currentPackageHash}/manifest.json`;
}

export function makeFallbackManifestPublicKey(
  deploymentKey: string,
  binaryVersion: string,
): string {
  return `${deploymentKey}/${binaryVersion}/manifest.json`;
}

export function makeDeploymentMetaPublicKey(deploymentKey: string): string {
  return `${deploymentKey}/meta.json`;
}
