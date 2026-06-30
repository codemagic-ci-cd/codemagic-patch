// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

export interface RemotePackage {
  packageHash: string;
  label: string;
  deploymentKey: string;
  releaseNotes: string | null;
  isMandatory: boolean;
  fullBundleUrl: string | null;
  patchUrl: string | null;
  fullBundleSize: number;
  patchSize: number | null;
  previouslyFailed: boolean;
}

export interface LocalPackage extends RemotePackage {
  installedAt: string;
  source: "patch" | "full_bundle";
}

export interface UpdateCheckBase {
  isStoreUpdateAvailable: boolean;
  latestBinaryVersion: string | null;
}

export type UpdateCheckResult =
  | (UpdateCheckBase & {
      action: "up-to-date";
      remotePackage?: undefined;
    })
  | (UpdateCheckBase & {
      action: "ota-update";
      remotePackage: RemotePackage;
    })
  | (UpdateCheckBase & {
      action: "embedded-revert";
      remotePackage?: undefined;
    });

export type EmbeddedRevertUpdate = Extract<
  UpdateCheckResult,
  { action: "embedded-revert" }
>;

export type InstallTarget = LocalPackage | EmbeddedRevertUpdate;

export type InstallMode =
  | "IMMEDIATE"
  | "ON_NEXT_RESTART"
  | "ON_NEXT_RESUME"
  | "ON_NEXT_SUSPEND";

export interface SyncOptions {
  installMode?: InstallMode;
  mandatoryInstallMode?: InstallMode;
  /** Minimum background duration in milliseconds for ON_NEXT_RESUME and ON_NEXT_SUSPEND. */
  minimumBackgroundDuration?: number;
}

export interface InstallOptions {
  installMode?: InstallMode;
  /** Minimum background duration in milliseconds for ON_NEXT_RESUME and ON_NEXT_SUSPEND. */
  minimumBackgroundDuration?: number;
}

// Internal values (idle, checking, downloading, installing) are used for
// state tracking. sync() only returns the four public values documented
// in the Spec: up-to-date, update-installed, sync-in-progress, error.
export type SyncStatus =
  | "idle"
  | "checking"
  | "downloading"
  | "installing"
  | "up-to-date"
  | "update-installed"
  | "embedded-revert-applied"
  | "sync-in-progress"
  | "error";

export interface UpdateMetadata {
  packageHash: string;
  /**
   * Binary version this package was installed under. `null` when the host
   * app's binary version has not yet been observed (no successful
   * `fetchManifest()` round-trip).
   */
  binaryVersion: string | null;
  deploymentKey: string;
  label: string;
  isMandatory: boolean;
  releaseNotes: string | null;
  installedAt: string;
  /** Artifact type persisted in packages/{hash}/update.json. */
  source: "patch" | "full_bundle";
  isFirstRun: boolean;
}

export interface DownloadProgress {
  totalBytes: number;
  receivedBytes: number;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export const CodemagicPatchErrorCode = {
  NETWORK_ERROR: "NETWORK_ERROR",
  INVALID_MANIFEST: "INVALID_MANIFEST",
  SIGNATURE_MISMATCH: "SIGNATURE_MISMATCH",
  INTEGRITY_ERROR: "INTEGRITY_ERROR",
  DOWNLOAD_IN_PROGRESS: "DOWNLOAD_IN_PROGRESS",
  SYNC_IN_PROGRESS: "SYNC_IN_PROGRESS",
  NOT_DOWNLOADED: "NOT_DOWNLOADED",
  INVALID_UPDATE_TARGET: "INVALID_UPDATE_TARGET",
} as const;

export type CodemagicPatchErrorCodeType =
  (typeof CodemagicPatchErrorCode)[keyof typeof CodemagicPatchErrorCode];

export class CodemagicPatchError extends Error {
  readonly code: CodemagicPatchErrorCodeType;

  constructor(code: CodemagicPatchErrorCodeType, message: string) {
    super(message);
    this.name = "CodemagicPatchError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Manifest types
// ---------------------------------------------------------------------------

export interface PreviousPackageInfo {
  release_label: string;
  package_hash: string;
  patch_url?: string;
  patch_size?: number;
  full_bundle_url: string;
  full_bundle_size: number;
  is_mandatory: boolean;
  release_notes?: string;
  rollout_percentage: number;
  signature?: string;
}

export interface ManifestResponse {
  target_package_hash: string | null;
  release_label?: string;
  patch_url?: string;
  patch_size?: number;
  full_bundle_url?: string;
  full_bundle_size?: number;
  is_mandatory?: boolean;
  release_notes?: string;
  rollout_percentage?: number;
  signature?: string;
  previous_package_info?: PreviousPackageInfo;
}

export interface MetaResponse {
  latest_binary_version: string;
}

// ---------------------------------------------------------------------------
// Metrics types
// ---------------------------------------------------------------------------

export type MetricsEventName =
  | "Downloaded"
  | "Installed"
  | "Success"
  | "Failed"
  | "Active";

export interface EventEnvelope {
  event_id: string;
  event_name: MetricsEventName;
  emitted_at: string;
  device_id: string;
  deployment_key: string;
  binary_version: string | null;
  running_package_hash: string | null;
  target_package_hash: string | null;
  platform: string;
  sdk_version: string;
  attributes: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Internal runtime types (not part of public API)
// ---------------------------------------------------------------------------

export interface RuntimeRemotePackage
  extends Omit<RemotePackage, "previouslyFailed"> {
  signature: string | null;
}

export interface RuntimePackage extends LocalPackage {
  binaryVersion: string | null;
  signatureVerified: boolean;
  successReportedAt: string | null;
  lastActiveReportedAt: string | null;
}

export interface FailedInstallState {
  packageHash: string;
  reason: string;
}

export interface MetricsEvent {
  name: string;
  packageHash?: string;
  deliveryType?: "patch" | "full_bundle";
  deploymentKey?: string;
  binaryVersion?: string | null;
  runningPackageHash?: string | null;
  status?: string;
  reason?: string;
  failureSubtype?: string;
  at: string;
}

export interface RuntimeState {
  /**
   * Host app binary version reported by native `fetchManifest()` context.
   * `null` until the first successful manifest fetch (or when native could
   * not determine the binary version for the current process).
   */
  binaryVersion: string | null;
  deploymentKey: string;
  deviceId: string;
  remotePackage: RuntimeRemotePackage | null;
  latestBinaryVersion: string | null;
  storeUpdateAvailable: boolean;
  /**
   * Package currently executing in this process. Decided at hydration from
   * `bootSource` and held immutable for the rest of the process lifetime —
   * activations only ever reassign this once at the moment a pending package
   * takes effect. May alias `pendingPackage` (pre-notify) or `confirmedPackage`
   * (post-notify / steady state). `null` when the embedded bundle is active.
   */
  runningPackage: RuntimePackage | null;
  /**
   * Last package confirmed via `notifyAppReady()`. Mirrors `state.json.current`.
   */
  confirmedPackage: RuntimePackage | null;
  previousPackage: RuntimePackage | null;
  pendingPackage: RuntimePackage | null;
  pendingInstallMode: InstallMode | null;
  pendingMinimumBackgroundDuration: number;
  lastBackgroundedAtMs: number | null;
  suspendActivationTimer: ReturnType<typeof setTimeout> | null;
  blockedActivation: boolean;
  failedInstall: FailedInstallState | null;
  downloadedPackages: Map<string, RuntimeRemotePackage>;
  lastUpdateCheckResult: UpdateCheckResult | null;
  hydrated: boolean;
  hydrationPromise: Promise<void> | null;
  publicKeyConfigured: boolean;
  syncInProgress: boolean;
  downloadInProgress: boolean;
  restartSuppressed: boolean;
  lastSyncStatus: SyncStatus;
  lastSyncError: string | null;
  clockMs: number | null;
  events: MetricsEvent[];
  bridgeReloadCount: number;
  /**
   * Last observed AppState ("active" / "background" / "inactive" / …). Lives
   * inside `RuntimeState` so the test reset path can clear it via the same
   * `Object.assign(state, createInitialRuntimeState())` without needing a
   * dedicated test-only helper.
   */
  lastAppState: string;
}

export type BootSource = "embedded" | "current" | "pending";

// ---------------------------------------------------------------------------
// Directory layout constants
// ---------------------------------------------------------------------------

export const CODEMAGIC_PATCH_ROOT = "codemagic-patch";
export const PACKAGES_DIR = `${CODEMAGIC_PATCH_ROOT}/packages`;
export const STATE_DIR = `${CODEMAGIC_PATCH_ROOT}/state`;
export const DOWNLOADS_DIR = `${CODEMAGIC_PATCH_ROOT}/downloads`;
export const TMP_DIR = `${CODEMAGIC_PATCH_ROOT}/tmp`;
export const EVENTS_DIR = `${CODEMAGIC_PATCH_ROOT}/events`;
