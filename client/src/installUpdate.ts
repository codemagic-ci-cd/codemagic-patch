import {
  CodemagicPatchError,
  CodemagicPatchErrorCode,
  type EmbeddedRevertUpdate,
  type InstallMode,
  type InstallOptions,
  type InstallTarget,
  type LocalPackage,
  type MetricsEvent,
  type RuntimePackage,
  type RuntimeRemotePackage,
} from "./types";
import NativeCodemagicPatch from "./NativeCodemagicPatch";
import {
  activatePendingPackageOrReload,
  clearSuspendActivationTimer,
  ensureHydrated,
  isCurrentlyBackgrounded,
  scheduleSuspendActivationIfDue,
  state,
} from "./runtime";
import {
  createMetricEvent,
  enqueueMetricEvent,
  recordEvent,
} from "./events";
import { nativeDownloadRequest, positiveByteCount } from "./downloadUpdate";

export const DEFAULT_INSTALL_MODE: InstallMode = "ON_NEXT_RESTART";

function isEmbeddedRevertUpdate(target: InstallTarget): target is EmbeddedRevertUpdate {
  return "action" in target && target.action === "embedded-revert";
}

function createRuntimePackage(
  localPackage: LocalPackage,
  remotePackage: RuntimeRemotePackage,
): RuntimePackage {
  return {
    ...localPackage,
    binaryVersion: state.binaryVersion,
    signatureVerified: state.publicKeyConfigured
      ? Boolean(remotePackage.signature)
      : false,
    successReportedAt: null,
    lastActiveReportedAt: null,
  };
}

function createInstalledMetricEvent(
  localPackage: LocalPackage,
  installMode: InstallMode,
): MetricsEvent {
  return createMetricEvent("Installed", {
    packageHash: localPackage.packageHash,
    deliveryType: localPackage.source,
    status: installMode,
  });
}

async function enqueueInstalledMetricEvent(
  localPackage: LocalPackage,
  installMode: InstallMode,
): Promise<MetricsEvent> {
  const installedEvent = createInstalledMetricEvent(localPackage, installMode);
  await enqueueMetricEvent(installedEvent);
  return installedEvent;
}

async function installNativeDownloadedPackage(
  localPackage: LocalPackage,
  remotePackage: RuntimeRemotePackage,
  installMode: InstallMode,
): Promise<{ localPackage: LocalPackage; installedEvent: MetricsEvent }> {
  try {
    await NativeCodemagicPatch.installUpdate({ packageHash: localPackage.packageHash });
  } catch (error) {
    if (localPackage.source !== "patch" || !remotePackage.fullBundleUrl) {
      await recordEvent("Failed", {
        packageHash: localPackage.packageHash,
        deliveryType: localPackage.source,
        status: "install",
        reason: "integrity",
      });
      throw error;
    }

    try {
      await NativeCodemagicPatch.downloadUpdate(
        nativeDownloadRequest(
          {
            packageHash: localPackage.packageHash,
            artifactType: "full_bundle",
            url: remotePackage.fullBundleUrl,
            metadata: {
              label: remotePackage.label,
              isMandatory: remotePackage.isMandatory,
              releaseNotes: remotePackage.releaseNotes,
              signatureVerified: state.publicKeyConfigured
                ? Boolean(remotePackage.signature)
                : false,
            },
          },
          positiveByteCount(remotePackage.fullBundleSize),
        ),
      );
    } catch (downloadError) {
      await recordEvent("Failed", {
        packageHash: localPackage.packageHash,
        deliveryType: "full_bundle",
        status: "download",
        reason: "network",
      });
      throw downloadError;
    }

    await recordEvent("Downloaded", {
      packageHash: localPackage.packageHash,
      deliveryType: "full_bundle",
    });
    const fallbackPackage: LocalPackage = {
      ...localPackage,
      source: "full_bundle",
    };
    try {
      await NativeCodemagicPatch.installUpdate({ packageHash: fallbackPackage.packageHash });
    } catch (installError) {
      await recordEvent("Failed", {
        packageHash: localPackage.packageHash,
        deliveryType: "full_bundle",
        status: "install",
        reason: "integrity",
      });
      throw installError;
    }

    const installedEvent = await enqueueInstalledMetricEvent(
      fallbackPackage,
      installMode,
    );
    return {
      localPackage: fallbackPackage,
      installedEvent,
    };
  }

  const installedEvent = await enqueueInstalledMetricEvent(
    localPackage,
    installMode,
  );
  return { localPackage, installedEvent };
}

export async function installUpdate(
  localPackage: InstallTarget,
  options?: InstallOptions,
): Promise<void> {
  await ensureHydrated();

  if (isEmbeddedRevertUpdate(localPackage)) {
    if (state.lastUpdateCheckResult !== localPackage) {
      throw new CodemagicPatchError(
        CodemagicPatchErrorCode.INVALID_UPDATE_TARGET,
        "installUpdate requires the current embedded-revert update target.",
      );
    }

    await NativeCodemagicPatch.stageEmbeddedRevert();

    state.confirmedPackage = null;
    state.pendingPackage = null;
    state.pendingInstallMode = null;
    state.previousPackage = null;
    state.pendingMinimumBackgroundDuration = options?.minimumBackgroundDuration ?? 0;
    clearSuspendActivationTimer();
    state.blockedActivation = false;

    if ((options?.installMode ?? DEFAULT_INSTALL_MODE) === "IMMEDIATE") {
      if (state.restartSuppressed) {
        state.blockedActivation = true;
      } else {
        await NativeCodemagicPatch.reloadBundle();
      }
    }

    return;
  }

  const downloadedRemotePackage = state.downloadedPackages.get(localPackage.packageHash);

  if (!downloadedRemotePackage) {
    throw new CodemagicPatchError(
      CodemagicPatchErrorCode.NOT_DOWNLOADED,
      "Install rejected: package was not downloaded.",
    );
  }

  const installMode = options?.installMode ?? DEFAULT_INSTALL_MODE;
  const nativeInstallResult = await installNativeDownloadedPackage(
    localPackage,
    downloadedRemotePackage,
    installMode,
  );
  const installedLocalPackage = nativeInstallResult.localPackage;

  const runtimePackage = createRuntimePackage(installedLocalPackage, downloadedRemotePackage);

  state.pendingPackage = runtimePackage;
  state.pendingInstallMode = installMode;
  state.pendingMinimumBackgroundDuration = options?.minimumBackgroundDuration ?? 0;
  clearSuspendActivationTimer();
  state.blockedActivation = false;
  state.failedInstall = null;

  state.events.push(nativeInstallResult.installedEvent);

  if (state.pendingInstallMode === "ON_NEXT_SUSPEND" && isCurrentlyBackgrounded()) {
    scheduleSuspendActivationIfDue();
  }

  if (state.pendingInstallMode !== "IMMEDIATE") {
    return;
  }

  if (state.restartSuppressed) {
    state.blockedActivation = true;
    return;
  }

  await activatePendingPackageOrReload();
}
