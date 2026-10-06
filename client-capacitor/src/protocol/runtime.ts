// Adapted from codemagic-ci-cd/codemagic-patch@b41c6f556e13346ff9b666eb82490900672f1dd9
// client/src/runtime.ts (Apache-2.0). Two changes from upstream, both documented in
// specs/UPSTREAM-DIVERGENCE.md:
//
// 1. `NativeCodemagicPatch` (RN TurboModule) -> `CodemagicPatch` (this package's
//    Capacitor plugin binding, ../nativeCodemagicPatch). Native call sites are adjusted
//    to this package's object-wrapped return shapes (see specs/ARCHITECTURE.md § 4) —
//    `getDeviceId()` returns `{ deviceId }` not a bare string, `getPackageMetadata()`
//    returns `{ metadata }` not a bare value, and `getBootState()`'s `bootSource` is
//    already a proper union (no upstream-style `as BootSource` cast needed).
// 2. The lifecycle listener subscribes to this plugin's own native
//    `CodemagicPatchAppStateChange` event instead of `AppState` from "react-native" —
//    see specs/adr/0013-native-app-state-events.md. Native emits RN's own `AppState`
//    value names, so `handleAppStateTransition` and everything it drives is unchanged.

import type { PackageMetadata } from '../definitions';
import CodemagicPatch from '../nativeCodemagicPatch';

import {
  type BootSource,
  type FailedInstallState,
  InstallMode,
  type RuntimePackage,
  type RuntimeState,
  type UpdateMetadata,
} from './types';

// ---------------------------------------------------------------------------
// Module-level singletons
// ---------------------------------------------------------------------------

export function createInitialRuntimeState(): RuntimeState {
  return {
    binaryVersion: null,
    deploymentKey: '',
    deviceId: 'default-device-id',
    androidPreviousProcessExit: null,
    remotePackage: null,
    latestBinaryVersion: null,
    storeUpdateAvailable: false,
    runningPackage: null,
    confirmedPackage: null,
    previousPackage: null,
    pendingPackage: null,
    pendingEmbeddedRevert: false,
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
    appReadyPromise: null,
    publicKeyConfigured: false,
    syncInProgress: false,
    downloadInProgress: false,
    restartSuppressed: false,
    lastSyncStatus: 'idle',
    lastSyncError: null,
    clockMs: null,
    events: [],
    bridgeReloadCount: 0,
    lastAppState: 'active',
    lastCheckFailureCode: null,
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

export function toUpdateMetadata(runtimePackage: RuntimePackage, isFirstRun: boolean): UpdateMetadata {
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
// Hydration (PROTOCOL.md-equivalent cold-start rehydration)
// ---------------------------------------------------------------------------

function createRuntimePackageFromNativeMetadata(metadata: PackageMetadata): RuntimePackage {
  return {
    packageHash: metadata.packageHash,
    label: metadata.label,
    deploymentKey: metadata.deploymentKey,
    releaseNotes: metadata.releaseNotes,
    isMandatory: metadata.isMandatory,
    fullBundleUrl: null,
    patchUrl: null,
    fullBundleSize: 0,
    patchSize: null,
    previouslyFailed: false,
    installedAt: metadata.installedAt,
    source: metadata.source,
    binaryVersion: metadata.binaryVersion,
    signatureVerified: metadata.signatureVerified ?? false,
    successReportedAt: metadata.successReportedAt ?? null,
    lastActiveReportedAt: metadata.lastActiveReportedAt ?? null,
  };
}

async function hydratePackage(packageHash: string | null): Promise<RuntimePackage | null> {
  if (!packageHash) {
    return null;
  }

  const { metadata } = await CodemagicPatch.getPackageMetadata({ packageHash });
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
 * split (cold-start rehydration). This is the single source of truth
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
  const source: BootSource = inputs.bootSource ?? (pending ? 'pending' : confirmed ? 'current' : 'embedded');

  switch (source) {
    case 'embedded':
      state.runningPackage = null;
      break;
    case 'current':
      state.runningPackage = confirmed;
      break;
    case 'pending':
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
      const bootState = await CodemagicPatch.getBootState();
      const [confirmed, pending, previous, { deviceId }] = await Promise.all([
        hydratePackage(bootState.confirmedPackageHash),
        hydratePackage(bootState.pendingPackageHash),
        hydratePackage(bootState.previousPackageHash),
        CodemagicPatch.getDeviceId(),
      ]);

      state.deviceId = deviceId;
      state.androidPreviousProcessExit = bootState.androidPreviousProcessExit ?? null;
      applyBootHydration({
        // Already a proper BootSource union at this package's native boundary
        // (definitions.ts) — no upstream-style `as BootSource` cast needed here.
        bootSource: bootState.bootSource,
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
// App-foreground/background lifecycle
// ---------------------------------------------------------------------------
//
// Upstream's AppState listener, driven by this plugin's own native
// `CodemagicPatchAppStateChange` event instead of React Native's `AppState` — see
// specs/adr/0013-native-app-state-events.md. Native emits RN's own value names
// (`active`/`inactive`/`background`), so everything from `handleAppStateTransition`
// down is upstream's logic unchanged.

/** Native event carrying the app's new `AppState`-style value. */
export const APP_STATE_CHANGE_EVENT = 'CodemagicPatchAppStateChange';

const APP_STATES: readonly string[] = ['active', 'inactive', 'background'];

let appStateSubscription: Promise<unknown> | null = null;

/** Reads the `appState` of a native app-state event, or `null` for anything else. */
export function readAppState(event: unknown): string | null {
  const appState = (event as { appState?: unknown } | null)?.appState;
  return typeof appState === 'string' && APP_STATES.includes(appState) ? appState : null;
}

function isBackgroundAppState(appState: string): boolean {
  return appState === 'background' || appState === 'inactive';
}

export function isCurrentlyBackgrounded(): boolean {
  return isBackgroundAppState(state.lastAppState);
}

function setupAppStateListener(): void {
  if (appStateSubscription) return;

  // Unlike RN's `AppState.currentState`, there is no synchronous current value to
  // seed from; `state.lastAppState`'s "active" default is correct whenever JS is
  // running in the foreground, which is when a WebView loads this module. A failed
  // registration (no native bridge, e.g. server-side rendering) leaves lifecycle
  // activation off, exactly as before this listener existed, rather than throwing
  // out of a module import.
  try {
    appStateSubscription = Promise.resolve(
      CodemagicPatch.addListener(APP_STATE_CHANGE_EVENT, (event: unknown) => {
        const appState = readAppState(event);
        if (appState) handleAppStateTransition(appState);
      }),
    ).catch(() => undefined);
  } catch {
    appStateSubscription = Promise.resolve();
  }
}

function handleAppStateTransition(nextState: string): void {
  const wasBackground = isBackgroundAppState(state.lastAppState);
  const isNowBackground = isBackgroundAppState(nextState);
  const isNowActive = nextState === 'active';

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
  await activateForLifecycle(InstallMode.ON_NEXT_RESUME, backgroundDurationMs);
}

async function handleBackgroundTransition(backgroundDurationMs = 0): Promise<void> {
  await activateForLifecycle(InstallMode.ON_NEXT_SUSPEND, backgroundDurationMs);
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

function hasPendingActivation(): boolean {
  return state.pendingPackage !== null || state.pendingEmbeddedRevert;
}

function canActivateForLifecycle(installMode: InstallMode, backgroundDurationMsValue: number): boolean {
  if (!hasPendingActivation() || state.pendingInstallMode !== installMode) {
    return false;
  }

  if (backgroundDurationMsValue < state.pendingMinimumBackgroundDuration) {
    return false;
  }

  if (state.restartSuppressed) {
    state.blockedActivation = true;
    return false;
  }

  return true;
}

async function activateForLifecycle(installMode: InstallMode, backgroundDurationMsValue: number): Promise<boolean> {
  if (!canActivateForLifecycle(installMode, backgroundDurationMsValue)) {
    return false;
  }

  return activatePendingPackageOrReload();
}

export async function activatePendingPackageOrReload(): Promise<boolean> {
  if (!hasPendingActivation()) {
    return false;
  }

  state.blockedActivation = false;
  await CodemagicPatch.reloadBundle();
  return true;
}

function activatePendingPackageOrScheduleReload(): boolean {
  if (!hasPendingActivation()) {
    return false;
  }

  state.blockedActivation = false;
  void CodemagicPatch.reloadBundle().catch((error: unknown) => {
    state.lastSyncError = error instanceof Error ? error.message : 'Bridge reload failed';
  });
  return true;
}

export function scheduleSuspendActivationIfDue(): void {
  clearSuspendActivationTimer();

  if (!hasPendingActivation() || state.pendingInstallMode !== InstallMode.ON_NEXT_SUSPEND) {
    return;
  }

  const delayMs = Math.max(0, state.pendingMinimumBackgroundDuration);

  if (delayMs === 0) {
    void activateForLifecycle(InstallMode.ON_NEXT_SUSPEND, 0);
    return;
  }

  state.suspendActivationTimer = setTimeout(() => {
    state.suspendActivationTimer = null;
    void activateForLifecycle(InstallMode.ON_NEXT_SUSPEND, backgroundDurationMs());
  }, delayMs);
}

// ---------------------------------------------------------------------------
// Restart control
// ---------------------------------------------------------------------------

export async function restartApp(onlyIfUpdateIsPending = false): Promise<void> {
  await ensureHydrated();

  if (onlyIfUpdateIsPending && !hasPendingActivation()) {
    return;
  }

  if (hasPendingActivation()) {
    if (state.restartSuppressed) {
      state.blockedActivation = true;
      return;
    }

    await activatePendingPackageOrReload();
    return;
  }

  await CodemagicPatch.reloadBundle();
}

export function disallowRestart(): void {
  state.restartSuppressed = true;
}

export function allowRestart(): void {
  state.restartSuppressed = false;

  if (hasPendingActivation() && state.blockedActivation) {
    activatePendingPackageOrScheduleReload();
  }
}
