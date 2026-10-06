import { Injectable } from '@angular/core';
import {
  checkForUpdate,
  getRunningBundleUpdateMetadata,
  isNextVersionReady,
  notifyAppReady,
  sync,
  type RunningBundleUpdateMetadata,
  type SyncStatus,
  type UpdateCheckResult,
} from '@codemagic/capacitor-patch';

/**
 * A thin Angular wrapper around @codemagic/capacitor-patch's own API — this is the
 * worked example the root README's "Usage" section points at.
 */
@Injectable({ providedIn: 'root' })
export class PatchService {
  /**
   * Confirms whichever package this process booted into, so it isn't rolled back —
   * called once per launch from `app.component.ts`, independent of the manual
   * SYNC()/CHECKFORUPDATE() buttons below. This matters even on a launch where the
   * user never taps either button: `notifyAppReady()` only confirms the package
   * *this specific process* is running, so a package installed by `sync()` on one
   * launch stays "pending" — and, per the crash-loop rollback protocol, is a
   * candidate for reverting — until a *later* launch confirms it. Real apps call
   * this on every cold start; this demo separates it from `sync()`'s own internal
   * call (README's Usage section) only so the manual buttons stay focused on
   * demonstrating the update-check/install flow, not launch-time bookkeeping.
   */
  notifyAppReady(): Promise<void> {
    return notifyAppReady();
  }

  /**
   * The simplest integration: checks for an update, downloads it, installs it, and
   * reports app readiness, all in one call. Never throws — always resolves to a
   * status string.
   */
  sync(onProgress?: Parameters<typeof sync>[1]): Promise<SyncStatus> {
    return sync(undefined, onProgress);
  }

  /**
   * Step-by-step alternative to `sync()`, for an app that wants to show its own "an
   * update is available" prompt (using `remotePackage.releaseNotes`/`isMandatory`)
   * before downloading — see the root README's "Usage" section for the full
   * checkForUpdate/downloadUpdate/installUpdate flow this result feeds into.
   */
  checkForUpdate(): Promise<UpdateCheckResult> {
    return checkForUpdate();
  }

  /** `null` when the app is running its embedded (store-shipped) bundle. */
  runningUpdate(): Promise<RunningBundleUpdateMetadata | null> {
    return getRunningBundleUpdateMetadata();
  }

  /**
   * Whether a *different* package than the one currently running is already
   * installed and waiting for the next reload — distinct from `runningUpdate()`,
   * which describes what's executing right now. Lets a host app show its own
   * "Update ready, restart now?" prompt without confusing the two.
   */
  isNextVersionReady(): Promise<boolean> {
    return isNextVersionReady();
  }
}
