// Ported verbatim from codemagic-ci-cd/codemagic-patch@b41c6f556e13346ff9b666eb82490900672f1dd9
// client/src/getRunningBundleUpdateMetadata.ts (Apache-2.0). No changes.

import { ensureHydrated, state } from './runtime';
import type { RunningBundleUpdateMetadata } from './types';

/**
 * Identify the OTA package whose web assets are executing in this process.
 *
 * Reads the hydrated `runningPackage` slot (cold-start rehydration), so
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
