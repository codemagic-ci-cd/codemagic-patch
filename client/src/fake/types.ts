/**
 * Public types of the native-boundary test fake. These describe scenarios in
 * SDK terms (labels, packages, server answers); the native wire shapes the fake
 * maps them onto stay private.
 */

export interface PatchPackageSeed {
  label: string;
  /** 64-char lowercase hex. Derived from `label` when omitted. */
  packageHash?: string;
  releaseNotes?: string | null;
  isMandatory?: boolean;
}

export interface PatchFakeSeed {
  /** Default `"1.0.0"`. */
  binaryVersion?: string;
  deploymentKey?: string;
  /** The package this process booted into. Omitted or null: the store binary (embedded bundle). */
  running?: PatchPackageSeed | null;
  /** `running` was just installed and booted for the first time, before `notifyAppReady()`. */
  runningUnconfirmed?: boolean;
  /** The confirmed package `running` would roll back to. Only with `runningUnconfirmed` in v1. */
  previous?: PatchPackageSeed;
  /** The last install native recorded as failed (for example a crash rollback). */
  failedInstall?: { label?: string; packageHash?: string; reason?: string };
  server?: PatchFakeServer;
}

export interface PatchFakeServer {
  /** What `checkForUpdate()` / `sync()` gets. Omitted or null: up to date. */
  release?: PatchPackageSeed | null;
  /** The newest store binary version for this deployment. Higher than `binaryVersion` means a store update is available. */
  latestBinaryVersion?: string;
  /** The update check fails with this error. */
  error?: Error;
}

/** Native boundary methods `fail()` can break. */
export type PatchFakeMethod =
  | "getBootState"
  | "fetchManifest"
  | "getDeviceId"
  | "getPackageMetadata"
  | "enqueueMetricEvent"
  | "downloadUpdate"
  | "installUpdate"
  | "confirmPendingUpdate"
  | "stageEmbeddedRevert"
  | "clearUpdatesForTests"
  | "reloadBundle"
  | "verifyJwtSignature";

export interface PatchFake {
  /**
   * Every later call of `method` rejects with `error` until cleared with
   * `fail(method, null)`.
   */
  fail(method: PatchFakeMethod, error: Error | null): void;
  /** Replace the `server` part of the seed for later update checks. */
  setServer(server: PatchFakeServer): void;
}
