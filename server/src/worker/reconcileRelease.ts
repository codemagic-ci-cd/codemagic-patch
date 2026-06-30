import { createHash } from "node:crypto";

import type { DeliveryAdapter, StorageAdapter } from "../adapters";
import type { ReleaseJobId } from "../domain";
import type {
  ReleaseArtifactRepository,
  ReleaseFailureInfo,
  ReleaseFinalizeRepository,
  ReconcileContextRepository,
  ReleaseJobRepository,
  ReleaseRepository,
  ReleaseTargetRepository,
} from "../repositories";
import { computeDesiredState, resolveReconcileTargets } from "./computeDesiredState";
import { diffPlan } from "./diffPlan";
import { executeReconcilePlan, WorkerPhaseError } from "./executeReconcilePlan";
import { inspectActualState } from "./inspectActualState";
import { manifestSerializer } from "./manifestSerializer";
import { computePackageHashFromZipBuffer } from "../packageHash";
import { renderDesiredState } from "./renderDesiredState";
import { resolveManifestArtifactSizes } from "./resolveManifestArtifactSizes";
import type {
  BundleSource,
  ManifestSerializer,
  PlanSummary,
  ReconcileContext,
  ReconcileResult,
} from "./types";

export type StagedBundleRetention = "delete" | "keep";

export interface ReconcileReleaseDependencies {
  artifactRepository?: ReleaseArtifactRepository;
  contextRepository: ReconcileContextRepository;
  delivery: DeliveryAdapter;
  finalizeRepository: ReleaseFinalizeRepository;
  jobRepository: ReleaseJobRepository;
  logger?: {
    warn(message: string, context?: Record<string, unknown>): void;
  };
  metrics?: {
    increment(
      name: string,
      value?: number,
      tags?: Record<string, string | number | boolean>,
    ): void | Promise<void>;
  };
  manifestCacheControl?: string;
  releaseRepository?: Pick<ReleaseRepository, "setReleaseTargetPackageHash">;
  /**
   * Whether to delete the staged upload (`_internal/uploads/.../bundle.zip`)
   * after a release reaches a terminal state (`succeeded` or non-retryable
   * `failed`). Defaults to `"delete"`. Set to `"keep"` to retain staged
   * inputs for forensic debugging.
   */
  stagedBundleRetention?: StagedBundleRetention;
  targetRepository: ReleaseTargetRepository;
  serializer?: ManifestSerializer;
  storage: StorageAdapter;
}

class LostClaimError extends Error {
  constructor() {
    super("release job claim was lost");
    this.name = "LostClaimError";
  }
}

export async function reconcileRelease(
  jobId: ReleaseJobId,
  dependencies: ReconcileReleaseDependencies,
): Promise<ReconcileResult> {
  const serializer = dependencies.serializer ?? manifestSerializer;
  const claim = await dependencies.jobRepository.claimReleaseJob(jobId);

  if (claim.outcome === "not_claimed") {
    return {
      outcome: "noop",
      reason: claim.reason,
    };
  }

  if (claim.outcome === "dead_lettered") {
    return {
      outcome: "failed",
      reason: claim.job.failureReason ?? "max_total_attempts_exceeded",
      retryable: false,
      stage: claim.job.failureStage ?? "claim",
    };
  }

  const claimGeneration = claim.job.claimGeneration;
  let resolvedContext: ReconcileContext | null = null;

  try {
    const loadedContext = await dependencies.contextRepository.loadReconcileContext(jobId);
    if (!loadedContext) {
      throw new WorkerPhaseError(
        "load_context",
        "context_not_found",
        false,
        `Reconcile context not found for job ${jobId}`,
      );
    }
    resolvedContext = loadedContext;
    const context = await ensureTargetPackageHash(loadedContext, dependencies);
    resolvedContext = context;

    const resolvedTargets = resolveReconcileTargets(context);
    const persistedTargets = await dependencies.targetRepository.persistPendingReleaseTargets(
      jobId,
      claimGeneration,
      resolvedTargets,
      {
        inferredFingerprint: buildInferredFingerprintWrite(context),
      },
    );
    if (persistedTargets.outcome !== "updated") {
      throw new LostClaimError();
    }

    // Surface fingerprint disagreements only on the attempt that owns the claim,
    // so a lost-claim retry does not emit a duplicate operator-review warning.
    const fingerprintDisagreement = detectFingerprintDisagreement(context);
    if (fingerprintDisagreement) {
      await safeWarn(dependencies.logger, "binary version fingerprint disagreement", {
        deploymentId: context.deployment.id,
        releaseId: context.release.id,
        binaryVersion: fingerprintDisagreement.binaryVersion,
        storedFingerprint: fingerprintDisagreement.storedFingerprint,
        releaseFingerprint: fingerprintDisagreement.releaseFingerprint,
      });
    }

    const desiredDraft = await resolveManifestArtifactSizes(
      computeDesiredState(context),
      context,
      dependencies.storage,
    );
    const desired = renderDesiredState(
      desiredDraft,
      serializer,
      dependencies.delivery,
    );
    const actual = await inspectActualState(desired, dependencies.storage, {
      heartbeat: async () => {
        await heartbeatOrThrow(jobId, claimGeneration, dependencies.jobRepository);
      },
    });
    const plan = diffPlan(desired, actual);

    if (isPlanEmpty(plan)) {
      await heartbeatOrThrow(jobId, claimGeneration, dependencies.jobRepository);
      await persistPublishedArtifacts(desired, dependencies);
      await heartbeatOrThrow(jobId, claimGeneration, dependencies.jobRepository);
      await finalizeSuccess(jobId, claimGeneration, dependencies.finalizeRepository);
      await bestEffortCleanupStagedBundle(context.bundleSource, dependencies);
      return {
        outcome: "noop",
        reason: "already_reconciled",
      };
    }

    await executeReconcilePlan({
      actual,
      context,
      desired,
      heartbeat: async () => {
        await heartbeatOrThrow(jobId, claimGeneration, dependencies.jobRepository);
      },
      plan,
      serializer,
      manifestCacheControl: dependencies.manifestCacheControl,
      storage: dependencies.storage,
    });

    await persistPublishedArtifacts(desired, dependencies);
    await heartbeatOrThrow(jobId, claimGeneration, dependencies.jobRepository);
    await finalizeSuccess(jobId, claimGeneration, dependencies.finalizeRepository);
    await bestEffortPurge(
      plan.affectedPurgePaths,
      dependencies.delivery,
      dependencies.logger,
      dependencies.metrics,
    );
    await bestEffortCleanupStagedBundle(context.bundleSource, dependencies);

    return {
      outcome: "succeeded",
      planSummary: summarizePlan(plan),
    };
  } catch (error) {
    if (error instanceof LostClaimError) {
      return {
        outcome: "noop",
        reason: "claim_lost",
      };
    }

    const failure = normalizeFailure(error);

    if (failure.retryable) {
      const requeued = await dependencies.finalizeRepository.requeueRetryableJob(
        jobId,
        claimGeneration,
        failure,
      );

      if (requeued.outcome !== "updated" && requeued.reason === "claim_generation_mismatch") {
        return {
          outcome: "noop",
          reason: "claim_lost",
        };
      }

      // Retryable: leave staged bundle in place so the next attempt can
      // resume from the same upload.

      return {
        outcome: "failed",
        reason: failure.reason,
        retryAttemptCount:
          requeued.outcome === "updated" ? requeued.job.attemptCount : undefined,
        retryable: failure.retryable,
        stage: failure.stage,
      };
    } else {
      const finalized = await dependencies.finalizeRepository.finalizeReleaseFailure(
        jobId,
        claimGeneration,
        failure,
      );

      if (finalized.outcome !== "updated" && finalized.reason === "claim_generation_mismatch") {
        return {
          outcome: "noop",
          reason: "claim_lost",
        };
      }

      await bestEffortCleanupStagedBundle(resolvedContext?.bundleSource ?? null, dependencies);
    }

    return {
      outcome: "failed",
      reason: failure.reason,
      retryable: failure.retryable,
      stage: failure.stage,
    };
  }
}

async function persistPublishedArtifacts(
  desired: ReturnType<typeof renderDesiredState>,
  dependencies: ReconcileReleaseDependencies,
): Promise<void> {
  if (!dependencies.artifactRepository || !desired.bundle) {
    return;
  }

  const artifacts = await Promise.all([
    ...desired.bundle.publicKeys.map(async (bundleKey) => {
      const object = await requireStoredObject(bundleKey.key, dependencies.storage);
      return {
        artifactType: "bundle" as const,
        contentHash: sha256Hex(object),
        fileSize: object.length,
        metadata: {
          binaryVersion: bundleKey.binaryVersion,
        },
        releaseId: desired.bundle!.releaseId,
        storageKey: bundleKey.key,
      };
    }),
    ...desired.patches.map(async (patch) => {
      const object = await requireStoredObject(patch.publicKey, dependencies.storage);
      return {
        artifactType: "patch" as const,
        contentHash: sha256Hex(object),
        fileSize: object.length,
        metadata: {
          binaryVersion: patch.binaryVersion,
          fromPackageHash: patch.fromPackageHash,
          isRolloutFallback: patch.isRolloutFallback,
          toPackageHash: patch.toPackageHash,
        },
        releaseId: patch.releaseId,
        storageKey: patch.publicKey,
      };
    }),
  ]);

  await dependencies.artifactRepository.replaceReleaseArtifacts(
    desired.bundle.releaseId,
    artifacts,
  );
}

async function ensureTargetPackageHash(
  context: ReconcileContext,
  dependencies: ReconcileReleaseDependencies,
): Promise<ReconcileContext> {
  if (context.release.targetPackageHash) {
    return context;
  }

  if (!context.bundleSource || context.bundleSource.kind !== "staged") {
    throw new WorkerPhaseError(
      "compute_hash",
      "bundle_source_missing",
      false,
      "Expected a staged bundle ZIP when target_package_hash is not set",
    );
  }

  if (!dependencies.releaseRepository) {
    throw new WorkerPhaseError(
      "compute_hash",
      "release_repository_missing",
      false,
      "Expected releaseRepository to persist target_package_hash",
    );
  }

  const stagedZip = await dependencies.storage.getBuffer(context.bundleSource.uploadKey);
  if (!stagedZip) {
    throw new WorkerPhaseError(
      "compute_hash",
      "bundle_source_missing",
      false,
      `Bundle source key does not exist: ${context.bundleSource.uploadKey}`,
    );
  }

  let targetPackageHash: string;

  try {
    targetPackageHash = computePackageHashFromZipBuffer(stagedZip);
  } catch (error) {
    throw normalizeBundleParseError(error);
  }

  const updated = await dependencies.releaseRepository.setReleaseTargetPackageHash(
    context.release.id,
    targetPackageHash,
  );

  if (!updated) {
    throw new WorkerPhaseError(
      "compute_hash",
      "target_package_hash_update_failed",
      false,
      `Could not persist target_package_hash for release ${context.release.id}`,
    );
  }

  return {
    ...context,
    release: {
      ...context.release,
      targetPackageHash,
    },
  };
}

function buildInferredFingerprintWrite(context: ReconcileContext):
  | {
      binaryVersion: string;
      fingerprint: string;
      inferredFromReleaseId: ReconcileContext["release"]["id"];
    }
  | undefined {
  if (context.release.fingerprint === null) {
    return undefined;
  }

  const explicitBinaryVersion = context.release.targetBinaryVersion;
  if (context.inferredFingerprints.has(explicitBinaryVersion)) {
    return undefined;
  }

  return {
    binaryVersion: explicitBinaryVersion,
    fingerprint: context.release.fingerprint,
    inferredFromReleaseId: context.release.id,
  };
}

/**
 * Detect a disagreement between this release's fingerprint and the fingerprint
 * already stored for the same binary version. The first OTA release targeting a
 * binary version is authoritative for that version's fingerprint; later releases
 * with a different fingerprint do not overwrite the stored value, but the
 * disagreement is surfaced for operator review (release-worker-tech-spec.md
 * resolve_targets / server-tech-spec.md Inferred Fingerprint).
 *
 * Returns undefined when there is nothing to flag — including a release
 * re-reconciled after it wrote its own fingerprint, whose stored value then
 * equals its release fingerprint, so retries do not raise a false disagreement.
 */
function detectFingerprintDisagreement(context: ReconcileContext):
  | {
      binaryVersion: string;
      storedFingerprint: string;
      releaseFingerprint: string;
    }
  | undefined {
  if (context.release.fingerprint === null) {
    return undefined;
  }

  const binaryVersion = context.release.targetBinaryVersion;
  const storedFingerprint = context.inferredFingerprints.get(binaryVersion);
  if (storedFingerprint === undefined || storedFingerprint === context.release.fingerprint) {
    return undefined;
  }

  return {
    binaryVersion,
    storedFingerprint,
    releaseFingerprint: context.release.fingerprint,
  };
}

async function finalizeSuccess(
  jobId: ReleaseJobId,
  claimGeneration: number,
  finalizeRepository: ReleaseFinalizeRepository,
): Promise<void> {
  const result = await finalizeRepository.finalizeReleaseSuccess(jobId, claimGeneration);

  if (result.outcome !== "updated") {
    throw new WorkerPhaseError(
      "finalize",
      result.reason,
      true,
      `Could not finalize release job ${jobId}: ${result.reason}`,
    );
  }
}

async function bestEffortCleanupStagedBundle(
  bundleSource: BundleSource | null,
  dependencies: Pick<
    ReconcileReleaseDependencies,
    "logger" | "metrics" | "stagedBundleRetention" | "storage"
  >,
): Promise<void> {
  if ((dependencies.stagedBundleRetention ?? "delete") === "keep") {
    return;
  }

  if (!bundleSource || bundleSource.kind !== "staged") {
    return;
  }

  try {
    await dependencies.storage.delete(bundleSource.uploadKey);
  } catch (error) {
    await safeWarn(dependencies.logger, "staged bundle cleanup failed", {
      error: error instanceof Error ? error.message : String(error),
      uploadKey: bundleSource.uploadKey,
    });
    await safeIncrement(dependencies.metrics, "staged_bundle_cleanup_failure_count", 1, {
      kind: "delete_error",
    });
  }
}

async function bestEffortPurge(
  paths: string[],
  delivery: DeliveryAdapter,
  logger?: ReconcileReleaseDependencies["logger"],
  metrics?: ReconcileReleaseDependencies["metrics"],
): Promise<void> {
  if (paths.length === 0) {
    return;
  }

  try {
    const result = await delivery.purge(paths);
    if (result.failures.length === 0) {
      return;
    }

    await safeWarn(logger, "delivery cache purge completed with failures", {
      failedPathCount: result.failures.length,
      failures: result.failures,
      requestedPathCount: result.requested,
      succeededPathCount: result.succeeded,
    });
    await safeIncrement(metrics, "purge_failure_count", result.failures.length, {
      kind: "partial_failure",
    });
  } catch (error) {
    await safeWarn(logger, "delivery cache purge request failed", {
      error: error instanceof Error ? error.message : String(error),
      pathCount: paths.length,
      paths,
    });
    await safeIncrement(metrics, "purge_failure_count", 1, {
      kind: "request_error",
    });
  }
}

async function safeWarn(
  logger: ReconcileReleaseDependencies["logger"] | undefined,
  message: string,
  context: Record<string, unknown>,
): Promise<void> {
  if (!logger) {
    return;
  }

  try {
    logger.warn(message, context);
  } catch {
    // Observability failures must not affect publish correctness.
  }
}

async function safeIncrement(
  metrics: ReconcileReleaseDependencies["metrics"] | undefined,
  name: string,
  value: number,
  tags: Record<string, string | number | boolean>,
): Promise<void> {
  if (!metrics) {
    return;
  }

  try {
    await metrics.increment(name, value, tags);
  } catch {
    // Observability failures must not affect publish correctness.
  }
}

async function requireStoredObject(
  key: string,
  storage: StorageAdapter,
): Promise<Buffer> {
  const object = await storage.getBuffer(key);
  if (!object) {
    throw new WorkerPhaseError(
      "persist_artifacts",
      "published_artifact_missing",
      true,
      `Expected artifact to exist at storage key: ${key}`,
    );
  }

  return object;
}

function isPlanEmpty(plan: Parameters<typeof summarizePlan>[0]): boolean {
  return (
    plan.bundle === null &&
    plan.missingPatches.length === 0 &&
    plan.staleManifests.length === 0 &&
    !plan.needsDeploymentMetaUpdate
  );
}

function summarizePlan(plan: ReturnType<typeof diffPlan>): PlanSummary {
  return {
    bundleInternalUpload: plan.bundle?.needsInternalUpload ?? false,
    bundlePublicCopyCount: plan.bundle?.missingPublicKeys.length ?? 0,
    manifestCount: plan.staleManifests.length,
    needsDeploymentMetaUpdate: plan.needsDeploymentMetaUpdate,
    patchCount: plan.missingPatches.length,
  };
}

function normalizeFailure(error: unknown): ReleaseFailureInfo & { retryable: boolean } {
  if (error instanceof WorkerPhaseError) {
    return {
      reason: error.reason,
      retryable: error.retryable,
      stage: error.stage,
    };
  }

  return {
    reason: error instanceof Error ? error.message : "unexpected_worker_error",
    retryable: true,
    stage: "reconcile",
  };
}

function normalizeBundleParseError(error: unknown): WorkerPhaseError {
  if (error instanceof WorkerPhaseError) {
    return error;
  }

  return new WorkerPhaseError(
    "bundle_parse",
    "invalid_bundle_archive",
    false,
    error instanceof Error ? error.message : "invalid_bundle_archive",
  );
}

function sha256Hex(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function heartbeatOrThrow(
  jobId: ReleaseJobId,
  claimGeneration: number,
  jobRepository: ReleaseJobRepository,
): Promise<void> {
  const heartbeat = await jobRepository.heartbeatReleaseJob(jobId, claimGeneration);
  if (!heartbeat) {
    throw new LostClaimError();
  }
}
