/**
 * Core domain types for the CodemagicPatch control-plane server.
 *
 * These types model persistent control-plane entities and cross API, worker,
 * and adapter boundaries. Transport / ORM representations should map to and
 * from these types at the edge.
 */

// ---------------------------------------------------------------------------
// Branded ID helpers
// ---------------------------------------------------------------------------

/**
 * Prefixed text IDs (e.g. "tm_cuid...", "rel_cuid...").
 * The brand prevents accidental cross-entity assignment at compile time.
 */
type PrefixedId<Prefix extends string> = string & { readonly __brand: Prefix };

export type TeamId = PrefixedId<"tm">;
export type UserId = PrefixedId<"usr">;
export type MembershipId = PrefixedId<"mem">;
export type RoleDefinitionId = PrefixedId<"role">;
export type RoleBindingId = PrefixedId<"rb">;
export type TeamInvitationId = PrefixedId<"inv">;
export type ApiTokenId = PrefixedId<"tok">;
export type OAuthSessionId = PrefixedId<"os">;
export type OAuthAccessTokenId = PrefixedId<"oat">;
export type RefreshTokenId = PrefixedId<"ort">;
export type AppId = PrefixedId<"app">;
export type DeploymentId = PrefixedId<"dpl">;
export type ReleaseId = PrefixedId<"rel">;
export type ReleaseJobId = PrefixedId<"rj">;
export type ReleaseTargetId = PrefixedId<"rt">;
export type ReleaseArtifactId = PrefixedId<"ra">;

// ---------------------------------------------------------------------------
// Enums (matching CHECK constraints in DDL)
// ---------------------------------------------------------------------------

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

export type ReleaseTargetStatus = "pending" | "active";

export type ReleaseTargetResolutionSource = "explicit" | "fingerprint";

export type ArtifactType = "bundle" | "patch" | "sourcemap";

export type UserStatus = "active" | "disabled";

export type TeamInvitationStatus =
  | "pending"
  | "accepted"
  | "revoked"
  | "expired";

export type MetricEventName =
  | "Downloaded"
  | "Installed"
  | "Success"
  | "Failed"
  | "Active";

export type ControlPlaneAction =
  | "team.read"
  | "app.create"
  | "app.manage"
  | "app.read"
  | "release.view"
  | "release.deploy"
  | "iam.manage"
  | "instance.read";

export type AuthorizationResourceScope =
  | {
      /**
       * The whole install rather than one team's resources (host health,
       * running version). Carries no id: there is exactly one instance.
       */
      type: "instance";
    }
  | {
      type: "team";
      teamId: TeamId;
    }
  | {
      type: "app";
      appId: AppId;
      teamId: TeamId;
    }
  | {
      type: "deployment";
      deploymentId: DeploymentId;
      teamId: TeamId;
    }
  | {
      type: "release";
      releaseId: ReleaseId;
      teamId: TeamId;
    };

export type AuthorizationResult =
  | {
      outcome: "authorized";
    }
  | {
      outcome: "account_disabled";
      reason: "team_disabled" | "user_disabled";
    }
  | {
      outcome: "forbidden";
    }
  | {
      outcome: "not_found";
    };

// ---------------------------------------------------------------------------
// Core domain entities
// ---------------------------------------------------------------------------

export interface UserAccount {
  id: UserId;
  email: string;
  displayName: string | null;
  status: UserStatus;
  oauthProvider: string | null;
  oauthSubject: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Team {
  id: TeamId;
  name: string;
  status: "active" | "disabled";
  createdAt: Date;
  updatedAt: Date;
}

export interface RoleDefinition {
  id: RoleDefinitionId;
  teamId: TeamId | null;
  key: string;
  displayName: string;
  isSystem: boolean;
  createdAt: Date;
}

export interface RoleBinding {
  id: RoleBindingId;
  principalType: "user";
  principalId: UserId;
  roleDefinitionId: RoleDefinitionId;
  scopeType: "team" | "app";
  scopeId: string;
  createdAt: Date;
  createdBy: UserId | null;
}

export interface TeamInvitation {
  id: TeamInvitationId;
  teamId: TeamId;
  // Exactly one target: an email claim, or a GitHub OAuth identity
  // (`oauthProvider`/`oauthSubject`, resolved from `githubHandle` at invite
  // time). Enforced by chk_team_invitation_target.
  email: string | null;
  githubHandle: string | null;
  oauthProvider: string | null;
  oauthSubject: string | null;
  roleDefinitionId: RoleDefinitionId;
  status: TeamInvitationStatus;
  createdBy: UserId;
  createdAt: Date;
  expiresAt: Date;
  acceptedBy: UserId | null;
  acceptedAt: Date | null;
  roleBindingId: RoleBindingId | null;
  revokedBy: UserId | null;
  revokedAt: Date | null;
}

export interface App {
  id: AppId;
  teamId: TeamId;
  name: string;
  requireCodeSigning: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Deployment {
  id: DeploymentId;
  appId: AppId;
  teamId: TeamId;
  name: string;
  /** Immutable key used in download paths and client SDK. */
  deploymentKey: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Release {
  id: ReleaseId;
  teamId: TeamId;
  appId: AppId;
  deploymentId: DeploymentId;
  /** Sequential label, e.g. "v1", "v2". */
  releaseLabel: string;
  /** Exact binary version target, e.g. "1.0.0" or "2024.06". Matched as an opaque string. */
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
  rollbackOf: ReleaseId | null;
  /** Signed JWT string, opaque to server. */
  signature: string | null;
  signatureHashAlgorithm: string | null;
  // Worker processing metadata
  processingStartedAt: Date | null;
  processingFinishedAt: Date | null;
  processingAttemptCount: number;
  failureStage: string | null;
  failureReason: string | null;
  createdBy: UserId | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReleaseJob {
  id: ReleaseJobId;
  releaseId: ReleaseId;
  deploymentId: DeploymentId;
  triggerType: ReleaseJobTriggerType;
  status: ReleaseJobStatus;
  attemptCount: number;
  /** Fencing token — incremented on each claim. */
  claimGeneration: number;
  maxTotalAttempts: number;
  leaseExpiresAt: Date | null;
  lastHeartbeatAt: Date | null;
  failureStage: string | null;
  failureReason: string | null;
  requestedBy: UserId | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReleaseTarget {
  id: ReleaseTargetId;
  releaseId: ReleaseId;
  binaryVersion: string;
  resolutionSource: ReleaseTargetResolutionSource;
  fingerprint: string | null;
  /** Monotonically increasing per release. */
  reconcileGeneration: number;
  status: ReleaseTargetStatus;
  /** The reconcile job that created this generation. */
  jobId: ReleaseJobId;
  createdAt: Date;
}

export interface ReleaseArtifact {
  id: ReleaseArtifactId;
  releaseId: ReleaseId;
  artifactType: ArtifactType;
  /** Public or internal storage key. */
  storageKey: string;
  fileSize: number | null;
  /** Content hash for dedup. */
  contentHash: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface BinaryVersionFingerprint {
  id: string;
  deploymentId: DeploymentId;
  binaryVersion: string;
  fingerprint: string;
  inferredFromReleaseId: ReleaseId | null;
  createdAt: Date;
}

export interface MetricEvent {
  id: string;
  eventId: string;
  eventName: MetricEventName;
  emittedAt: Date;
  teamId: TeamId;
  appId: AppId;
  deploymentId: DeploymentId;
  deploymentKey: string;
  binaryVersion: string | null;
  runningPackageHash: string | null;
  targetPackageHash: string | null;
  deviceId: string;
  sdkVersion: string | null;
  platform: string | null;
  attributes: Record<string, unknown> | null;
  /**
   * Decoded `attributes.payload` (PROTOCOL.md §Metric Event `Failed` Payload).
   * Null when the event carried no payload or the payload could not be
   * decoded — the raw string stays in `attributes` either way.
   */
  failurePayload: Record<string, unknown> | null;
  createdAt: Date;
}

export interface ReleaseMetrics {
  active: number;
  downloaded: number;
  failed: number;
  /**
   * Failed-event counts keyed by the client-reported `attributes.reason`
   * (client/specs/metrics/Spec.md §`Failed` Event Reason Values). Events
   * missing a reason land in the `"unknown"` bucket, so values sum to
   * `failed`.
   */
  failureReasons: Record<string, number>;
  /**
   * How many of each reason's failures carried a decodable `payload`
   * (PROTOCOL.md §Metric Event `Failed` Payload), keyed the same way. The
   * dashboard needs it to decide whether a reason row is worth opening: a
   * reason no device ever sent detail for has nothing behind it, and offering
   * a drill-down into an empty dialog is a dead end. Reasons with no detail
   * at all are absent rather than zero.
   */
  failureReasonDetailCounts: Record<string, number>;
  installed: number;
  success: number;
}

/**
 * Failures sharing one `payload.code` under a reason. `code` is null for
 * failures reported without a decodable payload: the pre-payload SDK versions
 * and the malformed-blob cases both land in that bucket.
 *
 * The bucket's detail is not inlined. Its value distributions and its raw
 * events are fetched only when a reader opens it, so a code nobody looks at
 * costs nothing beyond this row.
 */
export interface FailureCodeBreakdown {
  code: string | null;
  count: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

/**
 * Every distinct code under one reason, highest count first.
 *
 * Not paged. The value space is the enumerable set of HTTP statuses plus two
 * sentinels (PROTOCOL.md §Metric Event `Failed` Payload), so the result is
 * small and bounded by the contract rather than by the data — the same shape
 * as the reason counts this drills into, which are also returned whole.
 */
export interface FailureCodeBreakdownList {
  codes: FailureCodeBreakdown[];
}

/** One value and its occurrence count inside a code bucket. */
export interface FailureDistributionEntry {
  count: number;
  value: string;
}

/**
 * A code bucket's top values, aggregated over the whole bucket.
 *
 * Deliberately not derived from the event page a reader has scrolled to: that
 * would describe the newest N events and would shift under them as they
 * scrolled, which is the opposite of what a distribution is for.
 */
export interface FailureDistribution {
  /** Top `payload.android_previous_process_exit` values; empty off Android. */
  exitReasons: FailureDistributionEntry[];
  /** Top `payload.message` values. */
  messages: FailureDistributionEntry[];
  /** Events in the bucket, so shares account for the values below the cut. */
  total: number;
}

/** One raw `Failed` event inside a code bucket. */
export interface FailureEventSample {
  androidPreviousProcessExit: string | null;
  deviceId: string;
  emittedAt: Date;
  id: string;
  message: string | null;
}

/**
 * One keyset page of a code bucket's events, newest first.
 */
export interface FailureEventPage {
  events: FailureEventSample[];
  /** Null once the last page has been served. */
  nextCursor: string | null;
}

export interface AuditEvent {
  id: string;
  timestamp: Date;
  teamId: TeamId;
  actorType: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  result: "success" | "failure";
}

export interface ApiTokenMetadata {
  id: ApiTokenId;
  userId: UserId;
  displayName: string;
  maskedPrefix: string;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface OAuthSession {
  id: OAuthSessionId;
  userId: UserId;
  provider: string;
  subject: string;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface OAuthAccessTokenMetadata {
  id: OAuthAccessTokenId;
  sessionId: OAuthSessionId;
  userId: UserId;
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface RefreshTokenMetadata {
  id: RefreshTokenId;
  sessionId: OAuthSessionId;
  userId: UserId;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}
