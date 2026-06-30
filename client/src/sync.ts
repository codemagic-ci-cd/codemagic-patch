import type {
  DownloadProgress,
  InstallMode,
  RemotePackage,
  SyncOptions,
  SyncStatus,
} from "./types";
import { state } from "./runtime";
import { checkForUpdate } from "./checkForUpdate";
import { downloadUpdate } from "./downloadUpdate";
import { DEFAULT_INSTALL_MODE, installUpdate } from "./installUpdate";
import { notifyAppReady } from "./notifyAppReady";

function resolveSyncInstallMode(
  remotePackage: RemotePackage,
  options?: SyncOptions,
): InstallMode {
  if (remotePackage.isMandatory) {
    return options?.mandatoryInstallMode ?? "IMMEDIATE";
  }

  return options?.installMode ?? DEFAULT_INSTALL_MODE;
}

export async function sync(
  options?: SyncOptions,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<SyncStatus> {
  if (state.syncInProgress) {
    return "sync-in-progress";
  }

  state.syncInProgress = true;
  state.lastSyncError = null;
  state.lastSyncStatus = "checking";

  try {
    // sync() internally calls notifyAppReady() at the start (Spec §notifyAppReady Usage)
    await notifyAppReady();

    const updateCheck = await checkForUpdate();

    if (updateCheck.action === "up-to-date") {
      state.lastSyncStatus = "up-to-date";
      return "up-to-date";
    }

    if (updateCheck.action === "embedded-revert") {
      state.lastSyncStatus = "installing";
      await installUpdate(updateCheck, {
        installMode: options?.installMode ?? DEFAULT_INSTALL_MODE,
        minimumBackgroundDuration: options?.minimumBackgroundDuration,
      });
      state.lastSyncStatus = "embedded-revert-applied";
      return "embedded-revert-applied";
    }

    if (updateCheck.remotePackage.previouslyFailed) {
      state.lastSyncStatus = "up-to-date";
      return "up-to-date";
    }

    state.lastSyncStatus = "downloading";
    const localPackage = await downloadUpdate(updateCheck.remotePackage, onProgress);

    state.lastSyncStatus = "installing";
    await installUpdate(localPackage, {
      installMode: resolveSyncInstallMode(updateCheck.remotePackage, options),
      minimumBackgroundDuration: options?.minimumBackgroundDuration,
    });

    state.lastSyncStatus = "update-installed";
    return "update-installed";
  } catch (error) {
    // sync() does not throw — returns "error" status (Spec §Error Handling)
    state.lastSyncStatus = "error";
    state.lastSyncError =
      error instanceof Error ? error.message : "Unknown sync error";
    return "error";
  } finally {
    state.syncInProgress = false;
  }
}
