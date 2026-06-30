import type { StorageAdapter } from "../adapters";
import { WorkerPhaseError } from "./executeReconcilePlan";
import { materializeCanonicalBundleArchive } from "./materializeBundleArchive";
import type {
  BundleSource,
  DesiredStateDraft,
  ManifestContentDraft,
  ReconcileContext,
} from "./types";

export async function resolveManifestArtifactSizes(
  desired: DesiredStateDraft,
  context: Pick<ReconcileContext, "bundleSource">,
  storage: StorageAdapter,
): Promise<DesiredStateDraft> {
  const currentBundleSize = await resolveCurrentBundleSize(
    desired,
    context.bundleSource,
    storage,
  );
  const bundleSizes = new Map<string, number>();

  if (currentBundleSize !== null && desired.bundle) {
    for (const bundleKey of desired.bundle.publicKeys) {
      bundleSizes.set(bundleKey.key, currentBundleSize);
    }
  }

  return {
    ...desired,
    manifests: await Promise.all(
      desired.manifests.map(async (manifest) => ({
        ...manifest,
        content: await resolveManifestContentSizes(
          manifest.content,
          bundleSizes,
          storage,
        ),
      })),
    ),
  };
}

async function resolveManifestContentSizes(
  content: ManifestContentDraft,
  bundleSizes: Map<string, number>,
  storage: StorageAdapter,
): Promise<ManifestContentDraft> {
  const resolved: ManifestContentDraft = { ...content };

  if (resolved.bundlePublicKey && resolved.fullBundleSize === undefined) {
    resolved.fullBundleSize = await resolvePublicBundleSize(
      resolved.bundlePublicKey,
      bundleSizes,
      storage,
    );
  }

  if (resolved.previousPackageInfo) {
    const previous = { ...resolved.previousPackageInfo };
    if (previous.fullBundleSize === undefined) {
      previous.fullBundleSize = await resolvePublicBundleSize(
        previous.bundlePublicKey,
        bundleSizes,
        storage,
      );
    }
    resolved.previousPackageInfo = previous;
  }

  return resolved;
}

async function resolvePublicBundleSize(
  publicKey: string,
  bundleSizes: Map<string, number>,
  storage: StorageAdapter,
): Promise<number> {
  const cached = bundleSizes.get(publicKey);
  if (cached !== undefined) {
    return cached;
  }

  const object = await storage.head(publicKey);
  if (object?.size !== undefined) {
    bundleSizes.set(publicKey, object.size);
    return object.size;
  }

  throw new WorkerPhaseError(
    "resolve_manifest_sizes",
    "published_artifact_missing",
    true,
    `Could not resolve full_bundle_size because bundle object does not exist: ${publicKey}`,
  );
}

async function resolveCurrentBundleSize(
  desired: DesiredStateDraft,
  bundleSource: BundleSource | null,
  storage: StorageAdapter,
): Promise<number | null> {
  if (!desired.bundle || !bundleSource) {
    return null;
  }

  if (bundleSource.kind === "existing") {
    const object = await storage.head(bundleSource.internalKey);
    if (object?.size !== undefined) {
      return object.size;
    }

    throw new WorkerPhaseError(
      "resolve_manifest_sizes",
      "bundle_source_missing",
      false,
      `Could not resolve full_bundle_size because bundle source does not exist: ${bundleSource.internalKey}`,
    );
  }

  const stagedZip = await storage.getBuffer(bundleSource.uploadKey);
  if (!stagedZip) {
    throw new WorkerPhaseError(
      "resolve_manifest_sizes",
      "bundle_source_missing",
      false,
      `Could not resolve full_bundle_size because staged bundle does not exist: ${bundleSource.uploadKey}`,
    );
  }

  try {
    return materializeCanonicalBundleArchive(stagedZip).length;
  } catch (error) {
    throw new WorkerPhaseError(
      "bundle_parse",
      "invalid_bundle_archive",
      false,
      error instanceof Error ? error.message : "invalid_bundle_archive",
    );
  }
}
