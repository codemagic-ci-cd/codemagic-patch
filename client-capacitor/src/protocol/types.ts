// Ported from codemagic-ci-cd/codemagic-patch@b41c6f556e13346ff9b666eb82490900672f1dd9
// client/src/types.ts (Apache-2.0), with one deliberate omission: the
// `CodemagicPatchError`/`CodemagicPatchErrorCode` section is dropped — those now live in
// `../definitions.ts`, merged with the plugin-boundary error codes from Phase 0.
// See specs/adr/0008-unified-error-taxonomy.md. Otherwise unchanged except:
// - Upstream's `WrapOptions` is named `StartOptions`, for `start()` (see ./start.ts).
// - `RuntimeState.lastCheckFailureCode` is added (see checkForUpdate.ts, change 4).

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
  source: 'patch' | 'full_bundle';
}

export interface UpdateCheckBase {
  isStoreUpdateAvailable: boolean;
  latestBinaryVersion: string | null;
}

export type UpdateCheckResult =
  | (UpdateCheckBase & {
      action: 'up-to-date';
      remotePackage?: undefined;
    })
  | (UpdateCheckBase & {
      action: 'ota-update';
      remotePackage: RemotePackage;
    })
  | (UpdateCheckBase & {
      action: 'embedded-revert';
      remotePackage?: undefined;
    });

export type EmbeddedRevertUpdate = Extract<UpdateCheckResult, { action: 'embedded-revert' }>;

export type InstallTarget = LocalPackage | EmbeddedRevertUpdate;

export const InstallMode = {
  IMMEDIATE: 'IMMEDIATE',
  ON_NEXT_RESTART: 'ON_NEXT_RESTART',
  ON_NEXT_RESUME: 'ON_NEXT_RESUME',
  ON_NEXT_SUSPEND: 'ON_NEXT_SUSPEND',
} as const;

// eslint-disable-next-line no-redeclare -- TypeScript allows a value and type to share a public name.
export type InstallMode = (typeof InstallMode)[keyof typeof InstallMode];

export const CheckFrequency = {
  ON_APP_START: 'ON_APP_START',
  ON_APP_RESUME: 'ON_APP_RESUME',
} as const;

// eslint-disable-next-line no-redeclare -- TypeScript allows a value and type to share a public name.
export type CheckFrequency = (typeof CheckFrequency)[keyof typeof CheckFrequency];

/** Upstream's `WrapOptions`, for `start()` — this SDK's counterpart of `Patch.wrap()`. */
export interface StartOptions extends SyncOptions {
  /** Check once `start()` is called, and optionally on foreground return. Defaults to ON_APP_START. */
  checkFrequency?: CheckFrequency;
}

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
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'installing'
  | 'up-to-date'
  | 'update-installed'
  | 'embedded-revert-applied'
  | 'sync-in-progress'
  | 'error';

/**
 * Identity of the OTA package whose web assets are executing in this process.
 * Returned by `getRunningBundleUpdateMetadata()`; callers receive `null`
 * instead when the embedded binary bundle is running.
 */
export interface RunningBundleUpdateMetadata {
  /** Release label of the running OTA package as published by the server (e.g. "v3"). */
  label: string;
  /** Package hash of the running OTA package. */
  packageHash: string;
  /** Release notes captured at install time; `null` when the release was published without notes. */
  releaseNotes: string | null;
}

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
  source: 'patch' | 'full_bundle';
  isFirstRun: boolean;
}

export interface DownloadProgress {
  totalBytes: number;
  receivedBytes: number;
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

// Code-review finding (critical): PROTOCOL.md § Metric Lifecycle Names requires new
// SDKs to emit 'Ready'/'Applied' — 'Installed'/'Success' are read only as compatibility
// aliases for SDK releases that predate the rename. This SDK has never shipped, so it
// emits the current names directly rather than the pre-rename ones.
export type MetricsEventName = 'Downloaded' | 'Ready' | 'Applied' | 'Failed' | 'Active';

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

export interface RuntimeRemotePackage extends Omit<RemotePackage, 'previouslyFailed'> {
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

/**
 * Detail attached to a `Failed` event, serialized into `attributes.payload` as
 * a JSON string. One shape for every reason — PROTOCOL.md §Metric Event
 * `Failed` Payload is the contract.
 */
export interface MetricsFailurePayload {
  /**
   * The failure's machine-readable discriminator, and the key every
   * server-side and dashboard breakdown groups on. For `network` this is the
   * HTTP status of the failed response as a decimal string, or `"0"` when no
   * response was received.
   */
  code?: string;
  /**
   * Failure text relayed from whatever reported it. Never composed by the SDK;
   * omitted when nothing could be relayed.
   */
  message?: string;
  /**
   * Android `ApplicationExitInfo` reason for the previous process. Android
   * API 30+ only — absent on iOS and older Android.
   */
  android_previous_process_exit?: string;
}

export interface MetricsEvent {
  name: string;
  packageHash?: string;
  deliveryType?: 'patch' | 'full_bundle';
  deploymentKey?: string;
  binaryVersion?: string | null;
  runningPackageHash?: string | null;
  status?: string;
  reason?: string;
  failureSubtype?: string;
  payload?: MetricsFailurePayload;
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
  /**
   * Why the previous process ended (Android 11+; null elsewhere). Read once at
   * hydration from the native boot snapshot and carried on every `Failed`
   * payload.
   */
  androidPreviousProcessExit: string | null;
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
  /**
   * A staged embedded-binary revert awaiting activation. Tracked apart from
   * `pendingPackage` (a revert has no package) so install-mode timing,
   * `restartApp(true)` and `allowRestart()` still recognise it as pending.
   */
  pendingEmbeddedRevert: boolean;
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
  /**
   * In-flight `notifyAppReady()` run. Concurrent callers (direct and via
   * `sync()`) await this same promise so Applied / Active are emitted once.
   */
  appReadyPromise: Promise<void> | null;
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
   * Last observed app state (`active`/`inactive`/`background`), from the native
   * `CodemagicPatchAppStateChange` event — see specs/adr/0013-native-app-state-events.md.
   */
  lastAppState: string;
  /**
   * `code` (HTTP status, or the no-response sentinel) of the last recorded
   * `Failed(reason=network)` check-failure event, or `null` if the last check
   * either succeeded or hasn't failed yet this process. A sustained outage
   * re-enters `checkForUpdate()`'s catch block on every foreground sync, and
   * without this, each one wrote its own near-identical WAL entry — under a
   * long outage, oldest-first eviction (`enforceEventQueueCap`) would push out
   * genuinely distinct earlier events (Downloaded/Installed) in favor of 100
   * copies of the same ongoing failure. See `checkForUpdate.ts`'s use.
   */
  lastCheckFailureCode: string | null;
}

export type BootSource = 'embedded' | 'current' | 'pending';

// ---------------------------------------------------------------------------
// Directory layout constants
// ---------------------------------------------------------------------------

export const CODEMAGIC_PATCH_ROOT = 'codemagic-patch';
export const PACKAGES_DIR = `${CODEMAGIC_PATCH_ROOT}/packages`;
export const STATE_DIR = `${CODEMAGIC_PATCH_ROOT}/state`;
export const DOWNLOADS_DIR = `${CODEMAGIC_PATCH_ROOT}/downloads`;
export const TMP_DIR = `${CODEMAGIC_PATCH_ROOT}/tmp`;
export const EVENTS_DIR = `${CODEMAGIC_PATCH_ROOT}/events`;
