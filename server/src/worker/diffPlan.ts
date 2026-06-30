import type {
  ActualState,
  BundlePlan,
  DesiredState,
  ReconcilePlan,
} from "./types";

export function diffPlan(desired: DesiredState, actual: ActualState): ReconcilePlan {
  const bundle = buildBundlePlan(desired, actual);
  const missingPatches = desired.patches.filter(
    (patch) => !actual.existingPatches.get(patch.publicKey)?.publicObject,
  );
  const staleManifests = desired.manifests.filter((manifest) => {
    const existing = actual.existingManifests.get(manifest.publicKey);
    return !existing || existing.contentHash !== manifest.contentHash;
  });
  const needsDeploymentMetaUpdate = desired.deploymentMeta.content
    ? !actual.deploymentMetaExists ||
      actual.deploymentMetaContentHash !== desired.deploymentMeta.contentHash
    : actual.deploymentMetaExists;
  const affectedPurgePaths = new Set(staleManifests.map((manifest) => manifest.publicKey));

  if (needsDeploymentMetaUpdate) {
    affectedPurgePaths.add(desired.deploymentMeta.publicKey);
  }

  return {
    affectedPurgePaths: [...affectedPurgePaths].sort(),
    bundle,
    missingPatches,
    needsDeploymentMetaUpdate,
    staleManifests,
  };
}

function buildBundlePlan(desired: DesiredState, actual: ActualState): BundlePlan | null {
  if (!desired.bundle) {
    return null;
  }

  const missingPublicKeys =
    actual.bundle === null
      ? desired.bundle.publicKeys
      : desired.bundle.publicKeys.filter(
          (bundleKey) => !actual.bundle?.existingPublicKeys.has(bundleKey.key),
        );
  const needsInternalUpload = actual.bundle?.internalKeyExists ?? false ? false : true;

  if (!needsInternalUpload && missingPublicKeys.length === 0) {
    return null;
  }

  return {
    missingPublicKeys,
    needsInternalUpload,
  };
}
