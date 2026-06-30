// Wire-shape DTOs derived from server/src/domain/types.ts @ 25b9477
// Server `Date` fields serialize to ISO strings on the wire.

export type ReleaseStatus =
  | "uploaded"
  | "processing"
  | "published"
  | "failed"
  | "disabled";

export type ReleaseJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "dead_letter";

export type ReleaseJobTriggerType =
  | "release_created"
  | "release_promoted"
  | "release_rolled_back"
  | "release_patched"
  | "release_disabled"
  | "release_enabled";

export interface Release {
  id: string;
  teamId: string;
  appId: string;
  deploymentId: string;
  /** Sequential label, e.g. "v1", "v2". */
  releaseLabel: string;
  /** Exact binary version target, e.g. "1.0.0". Matched as an opaque string. */
  targetBinaryVersion: string;
  /** Native project fingerprint at release time; null while fingerprint support is deferred. */
  fingerprint: string | null;
  /** Computed by worker; null until computed. */
  targetPackageHash: string | null;
  rolloutPercentage: number;
  isMandatory: boolean;
  releaseNotes: string | null;
  status: ReleaseStatus;
  /** If this release is a rollback, points to the source release. */
  rollbackOf: string | null;
  /** Signed JWT string, opaque to the server. */
  signature: string | null;
  signatureHashAlgorithm: string | null;
  processingStartedAt: string | null;
  processingFinishedAt: string | null;
  processingAttemptCount: number;
  failureStage: string | null;
  failureReason: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReleaseJob {
  id: string;
  releaseId: string;
  deploymentId: string;
  triggerType: ReleaseJobTriggerType;
  status: ReleaseJobStatus;
  attemptCount: number;
  /** Fencing token — incremented on each worker claim. */
  claimGeneration: number;
  maxTotalAttempts: number;
  leaseExpiresAt: string | null;
  lastHeartbeatAt: string | null;
  failureStage: string | null;
  failureReason: string | null;
  requestedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const TERMINAL_JOB_STATUSES: ReadonlySet<ReleaseJobStatus> = new Set([
  "succeeded",
  "failed",
  "dead_letter",
]);

/** True when the worker job will make no further progress (polling must stop). */
export function isTerminalJobStatus(status: ReleaseJobStatus): boolean {
  return TERMINAL_JOB_STATUSES.has(status);
}

/** Disable is offered for published releases only. */
export function canDisable(release: Release): boolean {
  return release.status === "published";
}

/** Enable is offered for disabled releases only. */
export function canEnable(release: Release): boolean {
  return release.status === "disabled";
}

/** Rollout may only increase, and only while published below 100%. */
export function canPatchRollout(release: Release): boolean {
  return release.status === "published" && release.rolloutPercentage < 100;
}

/** Rollback needs a previous published release to land on. */
export function canRollback(publishedReleaseCount: number): boolean {
  return publishedReleaseCount >= 2;
}
