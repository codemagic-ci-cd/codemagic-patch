import NativeCodemagicPatch from "./NativeCodemagicPatch";
import {
  clearSuspendActivationTimer,
  ensureHydrated,
  state,
} from "./runtime";
import { emitActiveIfDue, packageMetricFields, recordEvent } from "./events";

export async function notifyAppReady(): Promise<void> {
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
      const successEvent = await recordEvent("Success", {
        ...packageMetricFields(runningPackage),
        deliveryType: runningPackage.source,
      });
      runningPackage.successReportedAt = successEvent.at;
    }

    await emitActiveIfDue(runningPackage);
  } else {
    await emitActiveIfDue(runningPackage);
  }
}
