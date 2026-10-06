// Adapted from codemagic-ci-cd/codemagic-patch@b41c6f556e13346ff9b666eb82490900672f1dd9
// client/src/notifyAppReady.ts (Apache-2.0, client v0.5.0). One change from upstream:
// `NativeCodemagicPatch` -> `CodemagicPatch` (../nativeCodemagicPatch).
//
// The single-flight below was first added here (specs/OPEN-QUESTIONS.md Q7) and then
// fixed the same way upstream in v0.5.0; this file now tracks upstream's version,
// names included.

import CodemagicPatch from '../nativeCodemagicPatch';

import { emitActiveIfDue, packageMetricFields, recordEvent } from './events';
import { clearSuspendActivationTimer, ensureHydrated, state } from './runtime';

export async function notifyAppReady(): Promise<void> {
  // Share one in-flight run across overlapping callers (direct calls and the
  // one `sync()` makes on entry). Without this, both pass the
  // `successReportedAt` / `shouldEmitActive` checks before either awaits the
  // native confirm and emits Applied / Active twice with distinct event IDs.
  if (!state.appReadyPromise) {
    state.appReadyPromise = runAppReady().finally(() => {
      state.appReadyPromise = null;
    });
  }

  await state.appReadyPromise;
}

async function runAppReady(): Promise<void> {
  await ensureHydrated();

  const runningPackage = state.runningPackage;

  if (!runningPackage) {
    return;
  }

  const isPendingRun = state.pendingPackage?.packageHash === runningPackage.packageHash;

  if (isPendingRun) {
    await CodemagicPatch.confirmPendingUpdate();

    // Confirmed promotion: this is the sole point at which a pending package
    // becomes the confirmed-good. confirmedPackage now mirrors runningPackage
    // and consequently `state.json.current` on disk.
    state.confirmedPackage = runningPackage;
    state.pendingPackage = null;
    state.pendingInstallMode = null;

    state.pendingMinimumBackgroundDuration = 0;
    clearSuspendActivationTimer();
    state.blockedActivation = false;

    if (!runningPackage.successReportedAt) {
      const appliedEvent = await recordEvent('Applied', {
        ...packageMetricFields(runningPackage),
        deliveryType: runningPackage.source,
      });
      runningPackage.successReportedAt = appliedEvent.at;
    }
  }

  await emitActiveIfDue(runningPackage);
}
