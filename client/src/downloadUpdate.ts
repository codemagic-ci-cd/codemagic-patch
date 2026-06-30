import { DeviceEventEmitter } from "react-native";

import {
  CodemagicPatchError,
  CodemagicPatchErrorCode,
  type DownloadProgress,
  type LocalPackage,
  type RemotePackage,
  type RuntimeRemotePackage,
} from "./types";
import NativeCodemagicPatch, {
  type NativeDownloadUpdateRequest,
  type NativeUpdateArtifactType,
} from "./NativeCodemagicPatch";
import { ensureHydrated, nowIso, state } from "./runtime";
import { recordEvent } from "./events";

const NATIVE_DOWNLOAD_PROGRESS_EVENT = "CodemagicPatchDownloadProgress";

interface NativeDownloadProgressEvent {
  artifactType?: unknown;
  packageHash?: unknown;
  receivedBytes?: unknown;
  totalBytes?: unknown;
}

interface NativeProgressSubscription {
  remove(): void;
}

export function positiveByteCount(
  value: number | null | undefined,
): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function nativeProgressNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : null;
}

function subscribeNativeDownloadProgress(
  packageHash: string,
  artifactType: NativeUpdateArtifactType,
  emitProgress: (progress: DownloadProgress) => void,
): NativeProgressSubscription {
  return DeviceEventEmitter.addListener(
    NATIVE_DOWNLOAD_PROGRESS_EVENT,
    (event: NativeDownloadProgressEvent) => {
      if (event.packageHash !== packageHash || event.artifactType !== artifactType) {
        return;
      }
      const totalBytes = nativeProgressNumber(event.totalBytes);
      const receivedBytes = nativeProgressNumber(event.receivedBytes);
      if (totalBytes === null || receivedBytes === null) {
        return;
      }
      emitProgress({ totalBytes, receivedBytes });
    },
  );
}

export function nativeDownloadRequest(
  request: Omit<NativeDownloadUpdateRequest, "expectedBytes">,
  expectedBytes: number | undefined,
): NativeDownloadUpdateRequest {
  return expectedBytes === undefined
    ? request
    : { ...request, expectedBytes };
}

function cloneRemotePackage(remotePackage: RuntimeRemotePackage): RuntimeRemotePackage {
  return { ...remotePackage };
}

function assertCurrentRemotePackage(remotePackage: RemotePackage): RuntimeRemotePackage {
  const current = state.lastUpdateCheckResult;

  if (
    current?.action !== "ota-update" ||
    current.remotePackage.packageHash !== remotePackage.packageHash ||
    state.remotePackage?.packageHash !== remotePackage.packageHash
  ) {
    throw new CodemagicPatchError(
      CodemagicPatchErrorCode.INVALID_UPDATE_TARGET,
      "downloadUpdate requires the current ota-update remote package.",
    );
  }

  return cloneRemotePackage(state.remotePackage);
}

export async function downloadUpdate(
  remotePackage: RemotePackage,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<LocalPackage> {
  await ensureHydrated();

  // Concurrency guard
  if (state.downloadInProgress) {
    throw new CodemagicPatchError(
      CodemagicPatchErrorCode.DOWNLOAD_IN_PROGRESS,
      "A download is already in progress.",
    );
  }

  const selectedRemotePackage = assertCurrentRemotePackage(remotePackage);

  if (!remotePackage.fullBundleUrl && !remotePackage.patchUrl) {
    throw new CodemagicPatchError(
      CodemagicPatchErrorCode.NOT_DOWNLOADED,
      "downloadUpdate requires a full bundle URL or patch URL.",
    );
  }

  state.downloadInProgress = true;

  try {
    state.downloadedPackages.set(remotePackage.packageHash, selectedRemotePackage);

    let deliveryType: "patch" | "full_bundle" = remotePackage.patchUrl ? "patch" : "full_bundle";

    const downloadNativeArtifact = async (
      artifactType: NativeUpdateArtifactType,
    ): Promise<void> => {
      const url =
        artifactType === "patch" ? remotePackage.patchUrl! : remotePackage.fullBundleUrl!;
      const manifestBytes =
        artifactType === "patch"
          ? remotePackage.patchSize ?? undefined
          : remotePackage.fullBundleSize;
      const expectedBytes = positiveByteCount(manifestBytes);
      const totalBytes = expectedBytes ?? 0;
      let lastReceivedBytes = 0;

      if (onProgress) {
        onProgress({ totalBytes, receivedBytes: 0 });
      }

      const subscription = onProgress
        ? subscribeNativeDownloadProgress(remotePackage.packageHash, artifactType, (progress) => {
            lastReceivedBytes = progress.receivedBytes;
            onProgress(progress);
          })
        : null;

      try {
        await NativeCodemagicPatch.downloadUpdate(
          nativeDownloadRequest(
            {
              packageHash: remotePackage.packageHash,
              artifactType,
              url,
              metadata: {
                label: remotePackage.label,
                isMandatory: remotePackage.isMandatory,
                releaseNotes: remotePackage.releaseNotes,
                signatureVerified: state.publicKeyConfigured
                  ? Boolean(selectedRemotePackage.signature)
                  : false,
              },
            },
            expectedBytes,
          ),
        );
      } finally {
        subscription?.remove();
      }

      if (onProgress) {
        onProgress({
          totalBytes,
          receivedBytes: totalBytes > 0 ? totalBytes : lastReceivedBytes,
        });
      }
    };

    const firstArtifactType: NativeUpdateArtifactType = remotePackage.patchUrl
      ? "patch"
      : "full_bundle";

    try {
      await downloadNativeArtifact(firstArtifactType);
    } catch (error) {
      if (firstArtifactType !== "patch" || !remotePackage.fullBundleUrl) {
        await recordEvent("Failed", {
          packageHash: remotePackage.packageHash,
          deliveryType: firstArtifactType,
          status: "download",
          reason: "network",
        });
        throw error;
      }

      deliveryType = "full_bundle";
      try {
        await downloadNativeArtifact("full_bundle");
      } catch (fullBundleError) {
        await recordEvent("Failed", {
          packageHash: remotePackage.packageHash,
          deliveryType: "full_bundle",
          status: "download",
          reason: "network",
        });
        throw fullBundleError;
      }
    }

    const localPackage: LocalPackage = {
      ...remotePackage,
      installedAt: nowIso(),
      source: deliveryType,
    };

    await recordEvent("Downloaded", {
      packageHash: localPackage.packageHash,
      deliveryType,
    });
    return localPackage;
  } finally {
    state.downloadInProgress = false;
  }
}
