/**
 * Worker pipeline types for the release reconciler.
 *
 * These types model the four-phase reconciliation algorithm:
 *   Phase 1 — Compute Desired State (pure computation)
 *   Phase 2 — Inspect Actual State  (storage reads)
 *   Phase 3 — Diff                  (pure computation)
 *   Phase 4 — Execute               (storage writes + DB transaction)
 *
 * Domain entity types are imported from ../domain/types.ts.
 */

import type {
  Deployment,
  Release,
  ReleaseId,
  ReleaseJob,
  ReleaseTarget,
} from "../domain/types";

// ---------------------------------------------------------------------------
// Manifest content — maps to manifest.json
// ---------------------------------------------------------------------------

/**
 * Fully resolved manifest content for a single
 * {deployment_key}/{binary_version}/{current_package_hash}/manifest.json.
 */
interface ManifestContentBase {
  targetPackageHash: string | null;
  releaseLabel?: string;
  patchUrl?: string;
  patchSize?: number;
  isMandatory: boolean;
  releaseNotes: string | null;
  rolloutPercentage: number;
  signature?: string;
  previousPackageInfo?: PreviousPackageInfo;
}

export type ManifestContent = ManifestContentBase &
  (
    | {
        fullBundleUrl: string;
        fullBundleSize: number;
      }
    | {
        fullBundleUrl?: undefined;
        fullBundleSize?: undefined;
      }
  );

export interface PreviousPackageInfo {
  releaseLabel: string;
  packageHash: string;
  patchUrl?: string;
  patchSize?: number;
  fullBundleUrl: string;
  fullBundleSize: number;
  isMandatory: boolean;
  releaseNotes: string | null;
  rolloutPercentage: number;
  signature?: string;
}

/**
 * Key-only manifest content used inside the worker planning phase.
 *
 * Public URLs are materialized later through DeliveryAdapter so that
 * desired-state computation stays independent from delivery/storage policy.
 */
export interface ManifestContentDraft {
  targetPackageHash: string | null;
  releaseLabel?: string;
  patchPublicKey?: string;
  patchSize?: number;
  bundlePublicKey?: string;
  fullBundleSize?: number;
  isMandatory: boolean;
  releaseNotes: string | null;
  rolloutPercentage: number;
  signature?: string;
  previousPackageInfo?: PreviousPackageInfoDraft;
}

export interface PreviousPackageInfoDraft {
  releaseLabel: string;
  packageHash: string;
  patchPublicKey?: string;
  patchSize?: number;
  bundlePublicKey: string;
  fullBundleSize?: number;
  isMandatory: boolean;
  releaseNotes: string | null;
  rolloutPercentage: number;
  signature?: string;
}

// ---------------------------------------------------------------------------
// Deployment metadata — maps to meta.json
// ---------------------------------------------------------------------------

export interface DeploymentMeta {
  latestBinaryVersion: string;
}

// ---------------------------------------------------------------------------
// Wire-format serialization contract
// ---------------------------------------------------------------------------

/**
 * Client-facing wire-format JSON for manifest.json (snake_case).
 *
 * Internal types (ManifestContent, PreviousPackageInfo) use camelCase
 * per TypeScript convention. This type represents the over-the-wire
 * shape. A `serializeManifest()` function is the single conversion
 * boundary and must be the sole source of `DesiredManifest.contentHash`.
 *
 * This type is intentionally kept as a plain interface — not used for
 * runtime construction — so that the serializer remains the authoritative
 * mapping and hash computation point.
 */
interface ManifestWireFormatBase {
  target_package_hash: string | null;
  release_label?: string;
  patch_url?: string;
  patch_size?: number;
  is_mandatory: boolean;
  release_notes: string | null;
  rollout_percentage: number;
  signature?: string;
  previous_package_info?: PreviousPackageInfoWireFormat;
}

export type ManifestWireFormat = ManifestWireFormatBase &
  (
    | {
        full_bundle_url: string;
        full_bundle_size: number;
      }
    | {
        full_bundle_url?: undefined;
        full_bundle_size?: undefined;
      }
  );

export interface PreviousPackageInfoWireFormat {
  release_label: string;
  package_hash: string;
  patch_url?: string;
  patch_size?: number;
  full_bundle_url: string;
  full_bundle_size: number;
  is_mandatory: boolean;
  release_notes: string | null;
  rollout_percentage: number;
  signature?: string;
}

export interface DeploymentMetaWireFormat {
  latest_binary_version: string;
}

/**
 * Serializer contract for manifest wire format.
 *
 * Implementations must:
 *   1. Convert ManifestContent → ManifestWireFormat (camelCase → snake_case)
 *   2. Produce deterministic JSON (stable key order, no extra whitespace)
 *   3. Compute contentHash as SHA-256 of the serialized JSON bytes
 *
 * This ensures DesiredManifest.contentHash is always derived from
 * the exact bytes that will be uploaded to storage.
 */
export interface ManifestSerializer {
  serialize(content: ManifestContent): {
    json: string;
    contentHash: string;
  };
  serializeDeploymentMeta(content: DeploymentMeta): {
    json: string;
    contentHash: string;
  };
}

// ---------------------------------------------------------------------------
// Phase 1 output: Desired State Draft
// ---------------------------------------------------------------------------

/** A desired bundle artifact (internal + public keys). */
export interface DesiredBundle {
  releaseId: ReleaseId;
  internalKey: string;
  publicKeys: DesiredBundlePublicKey[];
}

export interface DesiredBundlePublicKey {
  binaryVersion: string;
  key: string;
}

/** A desired diff patch artifact. */
export interface DesiredPatch {
  releaseId: ReleaseId;
  binaryVersion: string;
  fromPackageHash: string;
  toPackageHash: string;
  /** Public storage key for this patch. */
  publicKey: string;
  /** Internal storage key for caching. */
  internalKey: string;
  /** Whether this is a rollout-fallback patch to R_previous. */
  isRolloutFallback: boolean;
}

/** A desired manifest draft, before public URLs and content hashing. */
export interface DesiredManifestDraft {
  binaryVersion: string;
  currentPackageHash: string | null;
  kind: "fallback" | "primary";
  /** Public storage key for either the primary or fallback manifest path. */
  publicKey: string;
  /** Key-only manifest content. Public URLs are resolved later. */
  content: ManifestContentDraft;
}

export interface DesiredDeploymentMetaDraft {
  publicKey: string;
  content: DeploymentMeta | null;
}

/**
 * Complete desired state draft from Phase 1.
 * Represents everything that should exist before delivery-specific
 * URL materialization and manifest hashing.
 */
export interface DesiredStateDraft {
  bundle: DesiredBundle | null;
  patches: DesiredPatch[];
  manifests: DesiredManifestDraft[];
  deploymentMeta: DesiredDeploymentMetaDraft;
}

// ---------------------------------------------------------------------------
// Rendered desired state — ready for diffing and execution
// ---------------------------------------------------------------------------

/** A rendered desired manifest file. */
export interface DesiredManifest {
  binaryVersion: string;
  currentPackageHash: string | null;
  kind: "fallback" | "primary";
  /** Public storage key for either the primary or fallback manifest path. */
  publicKey: string;
  /** Fully materialized manifest content ready for serialization. */
  content: ManifestContent;
  /** SHA-256 of deterministic JSON serialization, for staleness comparison. */
  contentHash: string;
}

/**
 * Desired state for deployment meta.json.
 * `content` is null when the file should be absent (last release disabled).
 */
export interface DesiredDeploymentMeta {
  publicKey: string;
  content: DeploymentMeta | null;
  /** Null when the desired state is file absence. */
  contentHash: string | null;
}

/**
 * Complete rendered desired state used for diffing and execution.
 */
export interface DesiredState {
  bundle: DesiredBundle | null;
  patches: DesiredPatch[];
  manifests: DesiredManifest[];
  deploymentMeta: DesiredDeploymentMeta;
}

// ---------------------------------------------------------------------------
// Phase 2 output: Actual State
// ---------------------------------------------------------------------------

/** Describes a storage object that was found to exist. */
export interface ExistingObject {
  key: string;
  contentHash: string | null;
  size: number | null;
}

/**
 * Actual bundle state observed from storage.
 *
 * Tracks the internal key and each per-binary-version public key
 * independently, so that a retry after partial copy can resume
 * without re-uploading the internal blob or skipping missing copies.
 */
export interface ActualBundleState {
  /** Whether the canonical internal key exists. */
  internalKeyExists: boolean;
  /**
   * Public keys that already exist, keyed by storage key.
   * Missing keys from DesiredBundle.publicKeys need to be copied.
   */
  existingPublicKeys: Set<string>;
}

/**
 * Actual patch state observed from storage.
 *
 * Internal and public patch objects are tracked independently so retries
 * can distinguish "public promotion missing" from "patch artifact missing".
 */
export interface ExistingPatchState {
  publicKey: string;
  internalKey: string;
  publicObject: ExistingObject | null;
  internalObject: ExistingObject | null;
}

/**
 * Actual state observed from storage.
 * Describes which desired artifacts already exist and their content hashes.
 */
export interface ActualState {
  bundle: ActualBundleState | null;
  existingPatches: Map<string, ExistingPatchState>;
  /**
   * Existing manifests keyed by public storage key.
   * The worker reads `metadata.content_hash` (round-tripped via
   * StorageAdapter) to compare against DesiredManifest.contentHash.
   */
  existingManifests: Map<string, ExistingObject>;
  deploymentMetaExists: boolean;
  deploymentMetaContentHash: string | null;
}

// ---------------------------------------------------------------------------
// Phase 3 output: Reconcile Plan
// ---------------------------------------------------------------------------

/**
 * Minimal set of operations needed to converge actual → desired.
 * An empty plan (all fields are false / empty) means desired === actual.
 */
/**
 * Bundle work needed, broken down by internal upload and public copies.
 */
export interface BundlePlan {
  /** True if the internal bundle.tar.zst needs to be created. */
  needsInternalUpload: boolean;
  /** Public keys that still need to be copied from the internal key. */
  missingPublicKeys: DesiredBundlePublicKey[];
}

export interface ReconcilePlan {
  bundle: BundlePlan | null;
  missingPatches: DesiredPatch[];
  staleManifests: DesiredManifest[];
  needsDeploymentMetaUpdate: boolean;
  /**
   * Delivery paths requiring purge, derived from stale manifests
   * and deployment meta changes.
   */
  affectedPurgePaths: string[];
}

// ---------------------------------------------------------------------------
// Reconcile context — input to the reconciler
// ---------------------------------------------------------------------------

/**
 * All context the reconciler loads once at the start of Phase 1.
 * Assembled by the `loadContext` step from DB queries.
 */
export interface ReconcileContext {
  job: ReleaseJob;
  release: Release;
  deployment: Deployment;
  /**
   * Source bundle descriptor for this release. Null only when no bundle
   * should exist after reconciliation.
   */
  bundleSource: BundleSource | null;
  /**
   * Previously published releases in this deployment, ordered by
   * creation time descending. Used for R_previous resolution and
   * known-hash-set computation.
   */
  publishedReleases: Release[];
  /**
   * Active release targets for published releases in this deployment,
   * grouped by binary version.
   */
  activeTargetsByBinaryVersion: Map<string, ReleaseTarget[]>;
  /**
   * Historical release targets for releases that were successfully
   * published into this deployment, including currently disabled
   * historical releases. Used for known-hash construction.
   */
  historicalTargetsByBinaryVersion: Map<string, ReleaseTarget[]>;
  /**
   * Previous active generation of release_target rows for this release
   * (if any). Used to detect withdrawn binary versions.
   */
  previousActiveTargets: ReleaseTarget[];
  /**
   * Known fingerprints for binary versions in this deployment,
   * keyed by binary version.
   */
  inferredFingerprints: Map<string, string>;
  /** App-level settings relevant to the worker. */
  appSettings: {
    requireCodeSigning: boolean;
  };
  /**
   * Configured patch window: only hashes from the N most recent
   * releases receive diff patches to R_latest.
   * null = unlimited (generate patches for all known hashes).
   */
  patchWindow: number | null;
}

// ---------------------------------------------------------------------------
// Resolved target set — output of resolve_targets step
// ---------------------------------------------------------------------------

export interface ResolvedTarget {
  binaryVersion: string;
  resolutionSource: "explicit" | "fingerprint";
  fingerprint: string | null;
}

/**
 * For each binary version, the set of known current_package_hash values
 * that may exist on devices. Determines which manifests to generate.
 */
export interface KnownHashSet {
  binaryVersion: string;
  /** All known hashes (binary baseline + published releases + self). */
  hashes: string[];
  /** Subset of hashes eligible for diff patch generation (within patch window). */
  patchEligibleHashes: string[];
}

// ---------------------------------------------------------------------------
// Withdrawn binary version handling
// ---------------------------------------------------------------------------

/**
 * A binary version that was previously targeted by this release but has
 * been removed from the target set. Its manifests must be retargeted.
 */
export interface WithdrawnBinaryVersion {
  binaryVersion: string;
  /** The release to retarget manifests to, or null if no predecessor. */
  retargetToRelease: Release | null;
}

// ---------------------------------------------------------------------------
// Worker execution result
// ---------------------------------------------------------------------------

export type ReconcileResult =
  | { outcome: "succeeded"; planSummary: PlanSummary }
  | { outcome: "noop"; reason: string }
  | {
      outcome: "failed";
      stage: string;
      reason: string;
      retryable: boolean;
      retryAttemptCount?: number;
    };

export interface PlanSummary {
  bundleInternalUpload: boolean;
  bundlePublicCopyCount: number;
  patchCount: number;
  manifestCount: number;
  needsDeploymentMetaUpdate: boolean;
}

// ---------------------------------------------------------------------------
// Source bundle descriptor
// ---------------------------------------------------------------------------

/**
 * Describes where the reconciler should read the source bundle from.
 * - "staged": fresh upload at _internal/uploads/releases/{id}/bundle.zip
 * - "existing": reuse from a source release (promote/rollback)
 */
export type BundleSource =
  | { kind: "staged"; uploadKey: string }
  | { kind: "existing"; sourceReleaseId: ReleaseId; internalKey: string };
