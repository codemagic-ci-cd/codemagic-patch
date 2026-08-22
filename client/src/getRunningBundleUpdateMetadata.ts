import type { RunningBundleUpdateMetadata } from "./types";
import { ensureHydrated, state } from "./runtime";

/**
 * Identify the OTA package whose JS bundle is executing in this process.
 *
 * Reads the hydrated `runningPackage` slot (Spec §Cold-Start Rehydration), so
 * the answer is fixed for the process lifetime: installs and `notifyAppReady()`
 * never change it — a newly installed package only becomes the running bundle
 * after the next bridge reload. Resolves to `null` when the embedded binary
 * bundle is running (fresh install, embedded revert, crash rollback with no
 * confirmed package, or binary-version invalidation).
 */
export async function getRunningBundleUpdateMetadata(): Promise<RunningBundleUpdateMetadata | null> {
  await ensureHydrated();

  const runningPackage = state.runningPackage;

  if (!runningPackage) {
    return null;
  }

  return {
    label: runningPackage.label,
    packageHash: runningPackage.packageHash,
    releaseNotes: runningPackage.releaseNotes,
  };
}
