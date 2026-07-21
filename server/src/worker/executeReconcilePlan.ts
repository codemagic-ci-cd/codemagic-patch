import { Buffer } from "node:buffer";

import type { StorageAdapter } from "../adapters";
import { makeBundleInternalKey } from "./artifactKeys";
import {
  readBundleTreeFromCanonicalArchiveBuffer,
  readBundleTreeFromZipBuffer,
  type BundleTree,
} from "./bundleTree";
import {
  DEFAULT_ARTIFACT_CACHE_CONTROL,
  DEFAULT_MANIFEST_CACHE_CONTROL,
} from "./cachePolicy";
import { hdiffPatchDiffEngine, type DiffEngine } from "./diffEngine";
import { manifestSerializer } from "./manifestSerializer";
import { materializeCanonicalBundleArchive } from "./materializeBundleArchive";
import type {
  ActualState,
  BundleSource,
  DesiredState,
  ManifestSerializer,
  ReconcileContext,
  ReconcilePlan,
} from "./types";

export class WorkerPhaseError extends Error {
  readonly stage: string;
  readonly reason: string;
  readonly retryable: boolean;

  constructor(stage: string, reason: string, retryable: boolean, message?: string) {
    super(message ?? `${stage}: ${reason}`);
    this.name = "WorkerPhaseError";
    this.stage = stage;
    this.reason = reason;
    this.retryable = retryable;
  }
}

export interface ExecuteReconcilePlanOptions {
  actual: ActualState;
  context: ReconcileContext;
  desired: DesiredState;
  diffEngine?: DiffEngine;
  heartbeat?: () => Promise<void>;
  manifestCacheControl?: string;
  plan: ReconcilePlan;
  serializer?: ManifestSerializer;
  storage: StorageAdapter;
}

export async function executeReconcilePlan(
  options: ExecuteReconcilePlanOptions,
): Promise<void> {
  const serializer = options.serializer ?? manifestSerializer;
  const diffEngine = options.diffEngine ?? hdiffPatchDiffEngine;
  const manifestCacheControl =
    options.manifestCacheControl ?? DEFAULT_MANIFEST_CACHE_CONTROL;

  await options.heartbeat?.();
  await ensureBundle(options);
  await options.heartbeat?.();
  await ensurePatches(options, diffEngine);
  await options.heartbeat?.();
  await ensureManifests(
    options.desired,
    options.plan,
    options.storage,
    serializer,
    manifestCacheControl,
    options.heartbeat,
  );
  await options.heartbeat?.();
  await ensureDeploymentMeta(
    options.desired,
    options.plan,
    options.storage,
    serializer,
    manifestCacheControl,
  );
  await options.heartbeat?.();
}

async function ensureBundle(options: ExecuteReconcilePlanOptions): Promise<void> {
  if (!options.plan.bundle || !options.desired.bundle) {
    return;
  }

  const { bundle } = options.desired;
  if (options.plan.bundle.needsInternalUpload) {
    const canonicalBundleArchive = await readCanonicalBundleArchive(
      options.context,
      options.storage,
    );

    await options.storage.put(bundle.internalKey, canonicalBundleArchive, {
      cacheControl: DEFAULT_ARTIFACT_CACHE_CONTROL,
      contentType: "application/zstd",
    });
  }

  await Promise.all(
    options.plan.bundle.missingPublicKeys.map((bundleKey) =>
      options.storage.copy(bundle.internalKey, bundleKey.key),
    ),
  );
}

async function ensurePatches(
  options: ExecuteReconcilePlanOptions,
  diffEngine: DiffEngine,
): Promise<void> {
  for (const patch of options.plan.missingPatches) {
    await options.heartbeat?.();
    const existing = options.actual.existingPatches.get(patch.publicKey);

    if (!existing?.internalObject) {
      const sourceTree = await readPatchTreeForPackageHash(
        options.context,
        options.storage,
        patch.binaryVersion,
        patch.fromPackageHash,
      );
      const targetTree = await readPatchTreeForPackageHash(
        options.context,
        options.storage,
        patch.binaryVersion,
        patch.toPackageHash,
      );
      const patchBuffer = await diffEngine.createPatch({
        source: sourceTree,
        target: targetTree,
      });

      if (!patchBuffer) {
        throw new WorkerPhaseError(
          "ensure_patches",
          "patch_generation_failed",
          false,
          `Diff engine produced no patch for ${patch.binaryVersion}:${patch.fromPackageHash}->${patch.toPackageHash}`,
        );
      }

      await options.storage.put(patch.internalKey, patchBuffer, {
        cacheControl: DEFAULT_ARTIFACT_CACHE_CONTROL,
        // The patch artifact is a self-contained HDiffPatch directory-diff
        // container (internal zstd codec), not a standalone zstd frame. Label
        // it as opaque binary.
        contentType: "application/octet-stream",

      });
    }

    if (!existing?.publicObject) {
      await options.storage.copy(patch.internalKey, patch.publicKey);
    }

    await options.heartbeat?.();
  }
}

async function ensureManifests(
  desired: DesiredState,
  plan: ReconcilePlan,
  storage: StorageAdapter,
  serializer: ManifestSerializer,
  manifestCacheControl: string,
  heartbeat?: () => Promise<void>,
): Promise<void> {
  for (const manifest of plan.staleManifests) {
    await heartbeat?.();
    const { json, contentHash } = serializer.serialize(manifest.content);
    await storage.put(manifest.publicKey, Buffer.from(json, "utf8"), {
      cacheControl: manifestCacheControl,
      contentType: "application/json",
      metadata: {
        content_hash: contentHash,
      },
    });
  }
}

async function ensureDeploymentMeta(
  desired: DesiredState,
  plan: ReconcilePlan,
  storage: StorageAdapter,
  serializer: ManifestSerializer,
  manifestCacheControl: string,
): Promise<void> {
  if (!plan.needsDeploymentMetaUpdate) {
    return;
  }

  if (!desired.deploymentMeta.content) {
    await storage.delete(desired.deploymentMeta.publicKey);
    return;
  }

  const { json, contentHash } = serializer.serializeDeploymentMeta(
    desired.deploymentMeta.content,
  );

  await storage.put(desired.deploymentMeta.publicKey, Buffer.from(json, "utf8"), {
    cacheControl: manifestCacheControl,
    contentType: "application/json",
    metadata: {
      content_hash: contentHash,
    },
  });
}

async function readSourceBundleBuffer(
  context: ReconcileContext,
  storage: StorageAdapter,
): Promise<Buffer> {
  if (!context.bundleSource) {
    throw new WorkerPhaseError(
      "ensure_bundle",
      "bundle_source_missing",
      false,
      "Expected bundle source to exist for desired bundle upload",
    );
  }

  const sourceKey =
    context.bundleSource.kind === "staged"
      ? context.bundleSource.uploadKey
      : context.bundleSource.internalKey;
  const sourceBuffer = await storage.getBuffer(sourceKey);

  if (!sourceBuffer) {
    throw new WorkerPhaseError(
      "ensure_bundle",
      "bundle_source_missing",
      false,
      `Bundle source key does not exist: ${sourceKey}`,
    );
  }

  return sourceBuffer;
}

async function readPatchTreeForPackageHash(
  context: ReconcileContext,
  storage: StorageAdapter,
  binaryVersion: string,
  packageHash: string,
): Promise<BundleTree> {
  if (context.release.targetPackageHash === packageHash && context.bundleSource) {
    return readBundleTreeFromSource(context.bundleSource, storage);
  }

  const historicalReleaseIds = new Set(
    (context.historicalTargetsByBinaryVersion.get(binaryVersion) ?? []).map(
      (target) => target.releaseId,
    ),
  );
  const historicalRelease = context.publishedReleases.find(
    (release) =>
      release.targetPackageHash === packageHash && historicalReleaseIds.has(release.id),
  );

  if (historicalRelease) {
    return readBundleTreeFromSource(
      {
        kind: "existing",
        internalKey: makeBundleInternalKey(historicalRelease.id),
        sourceReleaseId: historicalRelease.id,
      },
      storage,
    );
  }

  throw new WorkerPhaseError(
    "ensure_patches",
    "patch_source_missing",
    false,
    `Could not resolve patch tree for ${binaryVersion}:${packageHash}`,
  );
}

async function readBundleTreeFromSource(
  source: BundleSource,
  storage: StorageAdapter,
): Promise<BundleTree> {
  if (source.kind === "staged") {
    const zipBuffer = await requireStorageBuffer(
      storage,
      source.uploadKey,
      "ensure_patches",
      "bundle_source_missing",
    );

    return normalizeBundleParseOperation(() => readBundleTreeFromZipBuffer(zipBuffer));
  }

  const bundleArchive = await requireStorageBuffer(
    storage,
    source.internalKey,
    "ensure_patches",
    "bundle_source_missing",
  );

  return normalizeBundleParseOperation(() =>
    readBundleTreeFromCanonicalArchiveBuffer(bundleArchive),
  );
}

async function requireStorageBuffer(
  storage: StorageAdapter,
  storageKey: string,
  stage: string,
  reason: string,
): Promise<Buffer> {
  const buffer = await storage.getBuffer(storageKey);
  if (!buffer) {
    throw new WorkerPhaseError(
      stage,
      reason,
      false,
      `Storage key does not exist: ${storageKey}`,
    );
  }

  return buffer;
}

async function readCanonicalBundleArchive(
  context: ReconcileContext,
  storage: StorageAdapter,
): Promise<Buffer> {
  if (context.bundleSource?.kind === "existing") {
    return requireStorageBuffer(
      storage,
      context.bundleSource.internalKey,
      "ensure_bundle",
      "bundle_source_missing",
    );
  }

  const sourceBuffer = await readSourceBundleBuffer(context, storage);
  return normalizeBundleParseOperation(() =>
    materializeCanonicalBundleArchive(sourceBuffer),
  );
}

function normalizeBundleParseOperation<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof WorkerPhaseError) {
      throw error;
    }

    throw new WorkerPhaseError(
      "bundle_parse",
      "invalid_bundle_archive",
      false,
      error instanceof Error ? error.message : "invalid_bundle_archive",
    );
  }
}
