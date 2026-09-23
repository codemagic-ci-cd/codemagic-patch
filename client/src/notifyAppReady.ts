import NativeCodemagicPatch from "./NativeCodemagicPatch";
import {
  clearSuspendActivationTimer,
  ensureHydrated,
  state,
} from "./runtime";
import { emitActiveIfDue, packageMetricFields, recordEvent } from "./events";

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
    await NativeCodemagicPatch.confirmPendingUpdate();

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
      const appliedEvent = await recordEvent("Applied", {
        ...packageMetricFields(runningPackage),
        deliveryType: runningPackage.source,
      });
      runningPackage.successReportedAt = appliedEvent.at;
    }
  }

  await emitActiveIfDue(runningPackage);
}
