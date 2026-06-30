import { AppState } from "react-native";

import type {
  BootSource,
  FailedInstallState,
  InstallMode,
  RuntimePackage,
  RuntimeState,
  UpdateMetadata,
} from "./types";

import NativeCodemagicPatch, {
  type NativePackageMetadata,
} from "./NativeCodemagicPatch";

// ---------------------------------------------------------------------------
// Module-level singletons
// ---------------------------------------------------------------------------

export function createInitialRuntimeState(): RuntimeState {
  return {
    binaryVersion: null,
    deploymentKey: "",
    deviceId: "default-device-id",
    remotePackage: null,
    latestBinaryVersion: null,
    storeUpdateAvailable: false,
    runningPackage: null,
    confirmedPackage: null,
    previousPackage: null,
    pendingPackage: null,
    pendingInstallMode: null,
    pendingMinimumBackgroundDuration: 0,
    lastBackgroundedAtMs: null,
    suspendActivationTimer: null,
    blockedActivation: false,
    failedInstall: null,
    downloadedPackages: new Map(),
    lastUpdateCheckResult: null,
    hydrated: false,
    hydrationPromise: null,
    publicKeyConfigured: false,
    syncInProgress: false,
    downloadInProgress: false,
    restartSuppressed: false,
    lastSyncStatus: "idle",
    lastSyncError: null,
    clockMs: null,
    events: [],
    bridgeReloadCount: 0,
    lastAppState: "active",
  };
}

export const state: RuntimeState = createInitialRuntimeState();

export function nowMs(): number {
  return state.clockMs ?? Date.now();
}

export function nowIso(): string {
  return new Date(nowMs()).toISOString();
}

// ---------------------------------------------------------------------------
// RuntimePackage → UpdateMetadata projection (used by test snapshots)
// ---------------------------------------------------------------------------

export function toUpdateMetadata(
  runtimePackage: RuntimePackage,
  isFirstRun: boolean,
): UpdateMetadata {
  return {
    packageHash: runtimePackage.packageHash,
    binaryVersion: runtimePackage.binaryVersion,
    deploymentKey: runtimePackage.deploymentKey,
    label: runtimePackage.label,
    isMandatory: runtimePackage.isMandatory,
    releaseNotes: runtimePackage.releaseNotes,
    installedAt: runtimePackage.installedAt,
    source: runtimePackage.source,
    isFirstRun,
  };
}

// ---------------------------------------------------------------------------
// Hydration (Spec §Cold-Start Rehydration)
// ---------------------------------------------------------------------------

function createRuntimePackageFromNativeMetadata(
  metadata: NativePackageMetadata,
): RuntimePackage {
  return {
    packageHash: metadata.package_hash,
    label: metadata.label,
    deploymentKey: metadata.deployment_key,
    releaseNotes: metadata.release_notes,
    isMandatory: metadata.is_mandatory,
    fullBundleUrl: null,
    patchUrl: null,
    fullBundleSize: 0,
    patchSize: null,
    previouslyFailed: false,
    installedAt: metadata.installed_at,
    // Native upholds the "patch" | "full_bundle" value space; the boundary type
    // is `string` for RN 0.76 codegen compatibility, so narrow it back here.
    source: metadata.source as "patch" | "full_bundle",
    binaryVersion: metadata.binary_version,
    signatureVerified: metadata.signature_verified ?? false,
    successReportedAt: metadata.success_reported_at ?? null,
    lastActiveReportedAt: metadata.last_active_reported_at ?? null,
  };
}

async function hydratePackage(
  packageHash: string | null,
): Promise<RuntimePackage | null> {
  if (!packageHash) {
    return null;
  }

  const metadata = await NativeCodemagicPatch.getPackageMetadata(packageHash);
  return metadata ? createRuntimePackageFromNativeMetadata(metadata) : null;
}

export interface BootHydrationInputs {
  bootSource?: BootSource;
  confirmed?: RuntimePackage | null;
  pending?: RuntimePackage | null;
  previous?: RuntimePackage | null;
  failedInstall?: FailedInstallState | null;
}

/**
 * Hydrate the disk-mirroring slots and derive `runningPackage` per the layer
 * split (Spec §Cold-Start Rehydration). This is the single source of truth
 * for translating native disk pointers into JS in-memory state.
 *
 *   state.json.current        → confirmedPackage
 *   state.json.pending        → pendingPackage
 *   state.json.previous       → previousPackage
 *   state.json.failed_install → failedInstall
 *   bootSource          → runningPackage alias
 *     embedded → null
 *     current  → confirmedPackage
 *     pending  → pendingPackage
 *
 * When `bootSource` is omitted, the alias is inferred from which seeds are
 * present (pending wins over confirmed wins over embedded).
 */
export function applyBootHydration(inputs: BootHydrationInputs): void {
  const confirmed = inputs.confirmed ?? null;
  const pending = inputs.pending ?? null;

  state.confirmedPackage = confirmed;
  state.pendingPackage = pending;
  state.previousPackage = inputs.previous ?? null;
  state.failedInstall = inputs.failedInstall ?? null;

  // runningPackage is always derived from bootSource aliasing one of the
  // disk-mirroring slots — there is no legal hydrated state where running
  // holds a value independent of confirmed/pending.
  const source: BootSource =
    inputs.bootSource ?? (pending ? "pending" : confirmed ? "current" : "embedded");

  switch (source) {
    case "embedded":
      state.runningPackage = null;
      break;
    case "current":
      state.runningPackage = confirmed;
      break;
    case "pending":
      state.runningPackage = pending;
      break;
  }
}

export async function ensureHydrated(): Promise<void> {
  if (state.hydrated) {
    return;
  }

  if (!state.hydrationPromise) {
    state.hydrationPromise = (async () => {
      const bootState = await NativeCodemagicPatch.getBootState();
      const [confirmed, pending, previous, deviceId] = await Promise.all([
        hydratePackage(bootState.confirmedPackageHash),
        hydratePackage(bootState.pendingPackageHash),
        hydratePackage(bootState.previousPackageHash),
        NativeCodemagicPatch.getDeviceId(),
      ]);

      state.deviceId = deviceId;
      applyBootHydration({
        // Native upholds the `NativeBootSource` value space; the boundary type
        // is `string` for RN 0.76 codegen compatibility, so narrow it back here.
        bootSource: bootState.bootSource as BootSource,
        confirmed,
        pending,
        previous,
        failedInstall: bootState.failedInstall
          ? {
              packageHash: bootState.failedInstall.packageHash,
              reason: bootState.failedInstall.reason,
            }
          : null,
      });

      state.hydrated = true;
    })().finally(() => {
      state.hydrationPromise = null;
    });
  }

  await state.hydrationPromise;
}

// ---------------------------------------------------------------------------
// AppState lifecycle (Spec §Trigger Policy)
// ---------------------------------------------------------------------------

let appStateSubscription: { remove(): void } | null = null;

function isBackgroundAppState(appState: string): boolean {
  return appState === "background" || appState === "inactive";
}

export function isCurrentlyBackgrounded(): boolean {
  return isBackgroundAppState(state.lastAppState);
}

function setupAppStateListener(): void {
  if (appStateSubscription) return;

  state.lastAppState = AppState.currentState;
  appStateSubscription = AppState.addEventListener("change", handleAppStateTransition);
}

function handleAppStateTransition(nextState: string): void {
  const wasBackground = isBackgroundAppState(state.lastAppState);
  const isNowBackground = isBackgroundAppState(nextState);
  const isNowActive = nextState === "active";

  if (!wasBackground && isNowBackground) {
    state.lastBackgroundedAtMs = nowMs();
    scheduleSuspendActivationIfDue();
  }

  if (wasBackground && isNowActive) {
    const durationMs = backgroundDurationMs();
    const hadPendingSuspendActivation = state.suspendActivationTimer != null;
    clearSuspendActivationTimer();
    state.lastBackgroundedAtMs = null;

    if (hadPendingSuspendActivation) {
      void handleBackgroundTransition(durationMs);
    } else {
      void handleForegroundEntry(durationMs);
    }
  }

  state.lastAppState = nextState;
}

async function handleForegroundEntry(backgroundDurationMs = 0): Promise<void> {
  await activateForLifecycle("ON_NEXT_RESUME", backgroundDurationMs);
}

async function handleBackgroundTransition(backgroundDurationMs = 0): Promise<void> {
  await activateForLifecycle("ON_NEXT_SUSPEND", backgroundDurationMs);
}

setupAppStateListener();

// ---------------------------------------------------------------------------
// Activation state machine
// ---------------------------------------------------------------------------

export function clearSuspendActivationTimer(): void {
  if (!state.suspendActivationTimer) {
    return;
  }

  clearTimeout(state.suspendActivationTimer);
  state.suspendActivationTimer = null;
}

function backgroundDurationMs(): number {
  if (state.lastBackgroundedAtMs == null) {
    return 0;
  }

  return Math.max(0, nowMs() - state.lastBackgroundedAtMs);
}

function canActivateForLifecycle(
  installMode: InstallMode,
  backgroundDurationMs: number,
): boolean {
  if (!state.pendingPackage || state.pendingInstallMode !== installMode) {
    return false;
  }

  if (backgroundDurationMs < state.pendingMinimumBackgroundDuration) {
    return false;
  }

  if (state.restartSuppressed) {
    state.blockedActivation = true;
    return false;
  }

  return true;
}

async function activateForLifecycle(
  installMode: InstallMode,
  backgroundDurationMs: number,
): Promise<boolean> {
  if (!canActivateForLifecycle(installMode, backgroundDurationMs)) {
    return false;
  }

  return activatePendingPackageOrReload();
}

export async function activatePendingPackageOrReload(): Promise<boolean> {
  if (!state.pendingPackage) {
    return false;
  }

  state.blockedActivation = false;
  await NativeCodemagicPatch.reloadBundle();
  return true;
}

function activatePendingPackageOrScheduleReload(): boolean {
  if (!state.pendingPackage) {
    return false;
  }

  state.blockedActivation = false;
  void NativeCodemagicPatch.reloadBundle().catch((error) => {
    state.lastSyncError = error instanceof Error ? error.message : "Bridge reload failed";
  });
  return true;
}

export function scheduleSuspendActivationIfDue(): void {
  clearSuspendActivationTimer();

  if (!state.pendingPackage || state.pendingInstallMode !== "ON_NEXT_SUSPEND") {
    return;
  }

  const delayMs = Math.max(0, state.pendingMinimumBackgroundDuration);

  if (delayMs === 0) {
    void handleBackgroundTransition(0);
    return;
  }

  state.suspendActivationTimer = setTimeout(() => {
    state.suspendActivationTimer = null;
    void handleBackgroundTransition(backgroundDurationMs());
  }, delayMs);
}

// ---------------------------------------------------------------------------
// Restart control (Spec §Restart Suppression)
// ---------------------------------------------------------------------------

export async function restartApp(onlyIfUpdateIsPending = false): Promise<void> {
  await ensureHydrated();

  if (onlyIfUpdateIsPending && !state.pendingPackage) {
    return;
  }

  if (state.pendingPackage && !state.restartSuppressed) {
    await activatePendingPackageOrReload();
    return;
  }

  await NativeCodemagicPatch.reloadBundle();
}

export function disallowRestart(): void {
  state.restartSuppressed = true;
}

export function allowRestart(): void {
  state.restartSuppressed = false;

  if (state.pendingPackage && state.blockedActivation) {
    activatePendingPackageOrScheduleReload();
  }
}
