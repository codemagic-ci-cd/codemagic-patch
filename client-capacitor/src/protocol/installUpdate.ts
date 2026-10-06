// Adapted from codemagic-ci-cd/codemagic-patch@b41c6f556e13346ff9b666eb82490900672f1dd9
// client/src/installUpdate.ts (Apache-2.0). Changes from upstream, documented in
// specs/UPSTREAM-DIVERGENCE.md:
// 1. `NativeCodemagicPatch` -> `CodemagicPatch` (../nativeCodemagicPatch).
// 2. `CodemagicPatchError`/`CodemagicPatchErrorCode` now come from ../definitions — see
//    specs/adr/0008-unified-error-taxonomy.md.

import { CodemagicPatchError, CodemagicPatchErrorCode } from '../definitions';
import CodemagicPatch from '../nativeCodemagicPatch';

import { nativeDownloadRequest, positiveByteCount } from './downloadUpdate';
import { createMetricEvent, enqueueMetricEvent, recordEvent } from './events';
import { commonFailurePayload, networkFailurePayload } from './failurePayload';
import {
  activatePendingPackageOrReload,
  clearSuspendActivationTimer,
  ensureHydrated,
  isCurrentlyBackgrounded,
  scheduleSuspendActivationIfDue,
  state,
} from './runtime';
import {
  type EmbeddedRevertUpdate,
  InstallMode,
  type InstallOptions,
  type InstallTarget,
  type LocalPackage,
  type MetricsEvent,
  type RuntimePackage,
  type RuntimeRemotePackage,
} from './types';

export const DEFAULT_INSTALL_MODE: InstallMode = InstallMode.ON_NEXT_RESTART;

function isEmbeddedRevertUpdate(target: InstallTarget): target is EmbeddedRevertUpdate {
  return 'action' in target && target.action === 'embedded-revert';
}

function createRuntimePackage(localPackage: LocalPackage, remotePackage: RuntimeRemotePackage): RuntimePackage {
  return {
    ...localPackage,
    binaryVersion: state.binaryVersion,
    signatureVerified: state.publicKeyConfigured ? Boolean(remotePackage.signature) : false,
    successReportedAt: null,
    lastActiveReportedAt: null,
  };
}

function createReadyMetricEvent(localPackage: LocalPackage, installMode: InstallMode): MetricsEvent {
  return createMetricEvent('Ready', {
    packageHash: localPackage.packageHash,
    deliveryType: localPackage.source,
    status: installMode,
  });
}

async function enqueueReadyMetricEvent(localPackage: LocalPackage, installMode: InstallMode): Promise<MetricsEvent> {
  const readyEvent = createReadyMetricEvent(localPackage, installMode);
  await enqueueMetricEvent(readyEvent);
  return readyEvent;
}

async function installNativeDownloadedPackage(
  localPackage: LocalPackage,
  remotePackage: RuntimeRemotePackage,
): Promise<LocalPackage> {
  try {
    await CodemagicPatch.installUpdate({ packageHash: localPackage.packageHash });
  } catch (error) {
    if (localPackage.source !== 'patch' || !remotePackage.fullBundleUrl) {
      await recordEvent('Failed', {
        packageHash: localPackage.packageHash,
        deliveryType: localPackage.source,
        status: 'install',
        reason: 'integrity',
        payload: commonFailurePayload(),
      });
      throw error;
    }

    try {
      await CodemagicPatch.downloadUpdate(
        nativeDownloadRequest(
          {
            packageHash: localPackage.packageHash,
            artifactType: 'full_bundle',
            url: remotePackage.fullBundleUrl,
            metadata: {
              label: remotePackage.label,
              isMandatory: remotePackage.isMandatory,
              releaseNotes: remotePackage.releaseNotes,
              signatureVerified: state.publicKeyConfigured ? Boolean(remotePackage.signature) : false,
            },
          },
          positiveByteCount(remotePackage.fullBundleSize),
        ),
      );
    } catch (downloadError) {
      await recordEvent('Failed', {
        packageHash: localPackage.packageHash,
        deliveryType: 'full_bundle',
        status: 'download',
        reason: 'network',
        payload: networkFailurePayload(downloadError),
      });
      throw downloadError;
    }

    await recordEvent('Downloaded', {
      packageHash: localPackage.packageHash,
      deliveryType: 'full_bundle',
    });
    const fallbackPackage: LocalPackage = {
      ...localPackage,
      source: 'full_bundle',
    };
    try {
      await CodemagicPatch.installUpdate({ packageHash: fallbackPackage.packageHash });
    } catch (installError) {
      await recordEvent('Failed', {
        packageHash: localPackage.packageHash,
        deliveryType: 'full_bundle',
        status: 'install',
        reason: 'integrity',
        payload: commonFailurePayload(),
      });
      throw installError;
    }

    return fallbackPackage;
  }

  return localPackage;
}

export async function installUpdate(localPackage: InstallTarget, options?: InstallOptions): Promise<void> {
  await ensureHydrated();

  if (isEmbeddedRevertUpdate(localPackage)) {
    if (state.lastUpdateCheckResult !== localPackage) {
      throw new CodemagicPatchError(
        CodemagicPatchErrorCode.InvalidUpdateTarget,
        'installUpdate requires the current embedded-revert update target.',
      );
    }

    await CodemagicPatch.stageEmbeddedRevert();

    state.confirmedPackage = null;
    state.pendingPackage = null;
    state.pendingEmbeddedRevert = true;
    state.pendingInstallMode = options?.installMode ?? DEFAULT_INSTALL_MODE;
    state.previousPackage = null;
    state.pendingMinimumBackgroundDuration = options?.minimumBackgroundDuration ?? 0;
    clearSuspendActivationTimer();
    state.blockedActivation = false;

    await activateInstalledUpdate();

    return;
  }

  const downloadedRemotePackage = state.downloadedPackages.get(localPackage.packageHash);

  if (!downloadedRemotePackage) {
    throw new CodemagicPatchError(
      CodemagicPatchErrorCode.NotDownloaded,
      'Install rejected: package was not downloaded.',
    );
  }

  const installMode = options?.installMode ?? DEFAULT_INSTALL_MODE;
  const installedLocalPackage = await installNativeDownloadedPackage(localPackage, downloadedRemotePackage);

  const runtimePackage = createRuntimePackage(installedLocalPackage, downloadedRemotePackage);

  state.pendingEmbeddedRevert = false;
  state.pendingPackage = runtimePackage;
  state.pendingInstallMode = installMode;
  state.pendingMinimumBackgroundDuration = options?.minimumBackgroundDuration ?? 0;
  clearSuspendActivationTimer();
  state.blockedActivation = false;
  state.failedInstall = null;

  state.events.push(await enqueueReadyMetricEvent(installedLocalPackage, installMode));

  await activateInstalledUpdate();
}

async function activateInstalledUpdate(): Promise<void> {
  if (state.pendingInstallMode === InstallMode.ON_NEXT_SUSPEND && isCurrentlyBackgrounded()) {
    scheduleSuspendActivationIfDue();
  }

  if (state.pendingInstallMode !== InstallMode.IMMEDIATE) {
    return;
  }

  if (state.restartSuppressed) {
    state.blockedActivation = true;
    return;
  }

  await activatePendingPackageOrReload();
}
