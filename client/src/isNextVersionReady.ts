import { ensureHydrated, state } from "./runtime";

/**
 * Whether a package other than the running one is installed and takes over on
 * the next bridge reload (`restartApp()`, an install-mode lifecycle trigger, or
 * a cold start). Changes at runtime: `false` at boot, `true` once `sync()` /
 * `installUpdate()` lands a newer package in the same process.
 *
 * Deliberately a standalone call rather than a field on
 * `getRunningBundleUpdateMetadata()`'s result: that call returns `null` while
 * the embedded bundle runs, which is exactly when a fresh install receives its
 * first OTA and needs this answer.
 *
 * A staged embedded revert is not reported. Reverting clears the pending slot
 * instead of filling it, so this stays `false` even though the next reload
 * switches back to the embedded bundle.
 */
export async function isNextVersionReady(): Promise<boolean> {
  await ensureHydrated();

  // A non-null pending slot alone does not mean a newer version is waiting. On
  // the first boot of a pending package (state table row 3) `pendingPackage`
  // *is* the running package until `notifyAppReady()` promotes it, so only a
  // pending hash that differs from the running hash counts as "next". While
  // the embedded bundle runs there is no running hash, so any pending package
  // counts.
  return (
    state.pendingPackage != null &&
    state.pendingPackage.packageHash !== state.runningPackage?.packageHash
  );
}
