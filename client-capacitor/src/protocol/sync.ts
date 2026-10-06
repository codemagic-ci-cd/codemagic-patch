// Adapted from codemagic-ci-cd/codemagic-patch@b41c6f556e13346ff9b666eb82490900672f1dd9
// client/src/sync.ts (Apache-2.0). One omission: upstream's `warnInDevelopment()`
// (a `console.warn` on sync failure, gated on React Native's `__DEV__` global) — no
// Capacitor equivalent of that build-time flag exists. The failure is still surfaced
// through the `'error'` return value and `state.lastSyncError`.

import { checkForUpdate } from './checkForUpdate';
import { downloadUpdate } from './downloadUpdate';
import { DEFAULT_INSTALL_MODE, installUpdate } from './installUpdate';
import { notifyAppReady } from './notifyAppReady';
import { state } from './runtime';
import { type DownloadProgress, InstallMode, type RemotePackage, type SyncOptions, type SyncStatus } from './types';

function resolveSyncInstallMode(remotePackage: RemotePackage, options?: SyncOptions): InstallMode {
  if (remotePackage.isMandatory) {
    return options?.mandatoryInstallMode ?? InstallMode.IMMEDIATE;
  }

  return options?.installMode ?? DEFAULT_INSTALL_MODE;
}

export async function sync(
  options?: SyncOptions,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<SyncStatus> {
  if (state.syncInProgress) {
    return 'sync-in-progress';
  }

  state.syncInProgress = true;
  state.lastSyncError = null;
  state.lastSyncStatus = 'checking';

  try {
    // sync() internally calls notifyAppReady() at the start (matches PROTOCOL.md's
    // notifyAppReady usage contract).
    await notifyAppReady();

    const updateCheck = await checkForUpdate();

    if (updateCheck.action === 'up-to-date') {
      state.lastSyncStatus = 'up-to-date';
      return 'up-to-date';
    }

    if (updateCheck.action === 'embedded-revert') {
      state.lastSyncStatus = 'installing';
      await installUpdate(updateCheck, {
        installMode: options?.installMode ?? DEFAULT_INSTALL_MODE,
        minimumBackgroundDuration: options?.minimumBackgroundDuration,
      });
      state.lastSyncStatus = 'embedded-revert-applied';
      return 'embedded-revert-applied';
    }

    if (updateCheck.remotePackage.previouslyFailed) {
      state.lastSyncStatus = 'up-to-date';
      return 'up-to-date';
    }

    state.lastSyncStatus = 'downloading';
    const localPackage = await downloadUpdate(updateCheck.remotePackage, onProgress);

    state.lastSyncStatus = 'installing';
    await installUpdate(localPackage, {
      installMode: resolveSyncInstallMode(updateCheck.remotePackage, options),
      minimumBackgroundDuration: options?.minimumBackgroundDuration,
    });

    state.lastSyncStatus = 'update-installed';
    return 'update-installed';
  } catch (error) {
    // sync() does not throw — returns "error" status.
    state.lastSyncStatus = 'error';
    state.lastSyncError = error instanceof Error ? error.message : 'Unknown sync error';
    return 'error';
  } finally {
    state.syncInProgress = false;
  }
}
