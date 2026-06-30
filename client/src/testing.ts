import type {
  BootSource,
  FailedInstallState,
  MetricsEvent,
  RuntimePackage,
  SyncStatus,
  UpdateMetadata,
} from "./types";
import {
  applyBootHydration,
  clearSuspendActivationTimer,
  createInitialRuntimeState,
  nowIso,
  state,
  toUpdateMetadata,
} from "./runtime";

export interface RuntimeSnapshot {
  binaryVersion: string | null;
  deviceId: string;
  /** Package executing in this process. Mirrors `RuntimeState.runningPackage`. */
  runningPackage: UpdateMetadata | null;
  /** Last package confirmed via `notifyAppReady()`. Mirrors `RuntimeState.confirmedPackage`. */
  confirmedPackage: UpdateMetadata | null;
  previousPackageHash: string | null;
  pendingPackage: UpdateMetadata | null;
  failedInstall: FailedInstallState | null;
  restartSuppressed: boolean;
  lastSyncStatus: SyncStatus;
  lastSyncError: string | null;
  events: MetricsEvent[];
  bridgeReloadCount: number;
  storeUpdateAvailable: boolean;
  latestBinaryVersion: string | null;
}

export interface RuntimeResetPackageSeed {
  packageHash: string;
  label?: string;
  deploymentKey?: string;
  releaseNotes?: string | null;
  isMandatory?: boolean;
  source?: "patch" | "full_bundle";
  installedAt?: string;
}

export interface RuntimeResetOptions {
  binaryVersion?: string | null;
  deploymentKey?: string;
  deviceId?: string;
  /**
   * Last package confirmed via `notifyAppReady()`. Mirrors `state.json.current`
   * on disk in real installations.
   */
  confirmedPackage?: RuntimeResetPackageSeed | null;
  previousPackage?: RuntimeResetPackageSeed | null;
  pendingPackage?: RuntimeResetPackageSeed | null;
  /**
   * Optional explicit boot source. When provided it drives the
   * hydration alias rule for `runningPackage`. When omitted the alias is
   * inferred from which seeds are present (`pendingPackage` → `pending`,
   * `confirmedPackage` only → `current`, neither → `embedded`).
   *
   * `runningPackage` is never seeded directly — it is always derived by
   * `applyBootHydration` from these inputs to keep tests aligned with the
   * production hydration algorithm.
   *
   * When any boot seed (`confirmedPackage` / `pendingPackage` /
   * `previousPackage` / `bootSource` / `failedInstall`) is provided,
   * `__resetRuntimeForTests` synchronously hydrates the in-memory slots.
   * Without a boot seed the runtime is left unhydrated.
   */
  bootSource?: BootSource;
  failedInstall?: FailedInstallState | null;
  latestBinaryVersion?: string | null;
  storeUpdateAvailable?: boolean;
  publicKeyConfigured?: boolean;
  clockMs?: number | null;
  restartSuppressed?: boolean;
}

function createRuntimePackageFromResetSeed(
  seed: RuntimeResetPackageSeed,
): RuntimePackage {
  return {
    packageHash: seed.packageHash,
    label: seed.label ?? "v1",
    deploymentKey: seed.deploymentKey ?? state.deploymentKey,
    releaseNotes: seed.releaseNotes ?? null,
    isMandatory: seed.isMandatory ?? false,
    fullBundleUrl: null,
    patchUrl: null,
    fullBundleSize: 0,
    patchSize: null,
    previouslyFailed: false,
    installedAt: seed.installedAt ?? nowIso(),
    source: seed.source ?? "full_bundle",
    binaryVersion: state.binaryVersion,
    signatureVerified: false,
    successReportedAt: null,
    lastActiveReportedAt: null,
  };
}

export function __resetRuntimeForTests(options: RuntimeResetOptions = {}): void {
  clearSuspendActivationTimer();
  const nextState = createInitialRuntimeState();

  nextState.binaryVersion = options.binaryVersion ?? null;
  nextState.deploymentKey = options.deploymentKey ?? "";
  nextState.deviceId = options.deviceId ?? "default-device-id";
  nextState.latestBinaryVersion = options.latestBinaryVersion ?? null;
  nextState.storeUpdateAvailable = options.storeUpdateAvailable ?? false;
  nextState.publicKeyConfigured = options.publicKeyConfigured ?? false;
  nextState.clockMs = options.clockMs ?? null;
  nextState.restartSuppressed = options.restartSuppressed ?? false;

  // `nextState.lastAppState` carries the "active" default, so the
  // Object.assign also resets the AppState tracking field.
  Object.assign(state, nextState);

  const hasBootSeed =
    options.confirmedPackage !== undefined ||
    options.pendingPackage !== undefined ||
    options.previousPackage !== undefined ||
    options.bootSource !== undefined ||
    options.failedInstall !== undefined;

  if (!hasBootSeed) {
    // No boot seed — the test owns native-module injection and the runtime
    // hydrates lazily through the real getBootState() path on first API call.
    state.hydrated = false;
    return;
  }

  // Boot-seed sugar: synchronously hydrate the in-memory slots so hydration
  // tests can snapshot without awaiting.
  applyBootHydration({
    bootSource: options.bootSource,
    confirmed: options.confirmedPackage
      ? createRuntimePackageFromResetSeed(options.confirmedPackage)
      : null,
    pending: options.pendingPackage
      ? createRuntimePackageFromResetSeed(options.pendingPackage)
      : null,
    previous: options.previousPackage
      ? createRuntimePackageFromResetSeed(options.previousPackage)
      : null,
    failedInstall: options.failedInstall ?? null,
  });
  state.hydrated = true;
}

export function __getRuntimeSnapshotForTests(): RuntimeSnapshot {
  return {
    binaryVersion: state.binaryVersion,
    deviceId: state.deviceId,
    runningPackage: state.runningPackage
      ? toUpdateMetadata(
          state.runningPackage,
          state.pendingPackage?.packageHash === state.runningPackage.packageHash,
        )
      : null,
    confirmedPackage: state.confirmedPackage
      ? toUpdateMetadata(state.confirmedPackage, false)
      : null,
    previousPackageHash: state.previousPackage?.packageHash ?? null,
    pendingPackage: state.pendingPackage
      ? toUpdateMetadata(state.pendingPackage, true)
      : null,
    failedInstall: state.failedInstall ? { ...state.failedInstall } : null,
    restartSuppressed: state.restartSuppressed,
    lastSyncStatus: state.lastSyncStatus,
    lastSyncError: state.lastSyncError,
    events: state.events.map((event) => ({ ...event })),
    bridgeReloadCount: state.bridgeReloadCount,
    storeUpdateAvailable: state.storeUpdateAvailable,
    latestBinaryVersion: state.latestBinaryVersion,
  };
}
