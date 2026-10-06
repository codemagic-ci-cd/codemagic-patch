// Adapted from codemagic-ci-cd/codemagic-patch@b41c6f556e13346ff9b666eb82490900672f1dd9
// client/src/downloadUpdate.ts (Apache-2.0). Changes from upstream, documented in
// specs/UPSTREAM-DIVERGENCE.md:
// 1. `DeviceEventEmitter.addListener(...)` (RN's device-wide event bus, needing a
//    manual packageHash/artifactType filter) -> `CodemagicPatch.addListener(...)`, the
//    Capacitor plugin proxy's own event mechanism (every Capacitor plugin gets one; see
//    ionic-team/capacitor core/src/web-plugin.ts and core/runtime.ts). Already scoped to
//    this plugin instance, but the packageHash/artifactType filter is kept anyway for
//    defense in depth. Two mechanical differences follow from this: Capacitor's
//    `addListener()` returns a `Promise<PluginListenerHandle>` (RN's is synchronous), and
//    its `remove()` is async (RN's is synchronous) — both awaited below.
// 2. `NativeCodemagicPatch` -> `CodemagicPatch` (../nativeCodemagicPatch).
// 3. `CodemagicPatchError`/`CodemagicPatchErrorCode` now come from ../definitions — see
//    specs/adr/0008-unified-error-taxonomy.md.
//
// The event name `CodemagicPatchDownloadProgress` and its payload shape
// (packageHash/artifactType/receivedBytes/totalBytes) are a contract this file expects
// a Phase 4 native `downloadUpdate()` implementation to call via `notifyListeners()` —
// see specs/PROTOCOL-CONFORMANCE.md.

import {
  CodemagicPatchError,
  CodemagicPatchErrorCode,
  type DownloadUpdateRequest,
  type UpdateArtifactType,
} from '../definitions';
import CodemagicPatch from '../nativeCodemagicPatch';

import { recordEvent } from './events';
import { networkFailurePayload } from './failurePayload';
import { ensureHydrated, nowIso, state } from './runtime';
import type { DownloadProgress, LocalPackage, RemotePackage, RuntimeRemotePackage } from './types';

const NATIVE_DOWNLOAD_PROGRESS_EVENT = 'CodemagicPatchDownloadProgress';

interface NativeDownloadProgressEvent {
  artifactType?: unknown;
  packageHash?: unknown;
  receivedBytes?: unknown;
  totalBytes?: unknown;
}

/**
 * Structurally identical to Capacitor's own `PluginListenerHandle` (`{ remove: () =>
 * Promise<void> }`) — owned locally, like upstream's `NativeProgressSubscription`, so
 * this file doesn't need a `@capacitor/core` import for one type. `CodemagicPatch
 * .addListener()`'s actual return value satisfies this structurally.
 */
interface NativeProgressSubscription {
  remove(): Promise<void>;
}

export function positiveByteCount(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nativeProgressNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : null;
}

async function subscribeNativeDownloadProgress(
  packageHash: string,
  artifactType: UpdateArtifactType,
  emitProgress: (progress: DownloadProgress) => void,
): Promise<NativeProgressSubscription> {
  return CodemagicPatch.addListener(NATIVE_DOWNLOAD_PROGRESS_EVENT, (event: NativeDownloadProgressEvent) => {
    if (event.packageHash !== packageHash || event.artifactType !== artifactType) {
      return;
    }
    const totalBytes = nativeProgressNumber(event.totalBytes);
    const receivedBytes = nativeProgressNumber(event.receivedBytes);
    if (totalBytes === null || receivedBytes === null) {
      return;
    }
    emitProgress({ totalBytes, receivedBytes });
  });
}

export function nativeDownloadRequest(
  request: Omit<DownloadUpdateRequest, 'expectedBytes'>,
  expectedBytes: number | undefined,
): DownloadUpdateRequest {
  return expectedBytes === undefined ? request : { ...request, expectedBytes };
}

function cloneRemotePackage(remotePackage: RuntimeRemotePackage): RuntimeRemotePackage {
  return { ...remotePackage };
}

function assertCurrentRemotePackage(remotePackage: RemotePackage): RuntimeRemotePackage {
  const current = state.lastUpdateCheckResult;

  if (
    current?.action !== 'ota-update' ||
    current.remotePackage.packageHash !== remotePackage.packageHash ||
    state.remotePackage?.packageHash !== remotePackage.packageHash
  ) {
    throw new CodemagicPatchError(
      CodemagicPatchErrorCode.InvalidUpdateTarget,
      'downloadUpdate requires the current ota-update remote package.',
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
    throw new CodemagicPatchError(CodemagicPatchErrorCode.DownloadInProgress, 'A download is already in progress.');
  }

  const selectedRemotePackage = assertCurrentRemotePackage(remotePackage);

  if (!remotePackage.fullBundleUrl && !remotePackage.patchUrl) {
    throw new CodemagicPatchError(
      CodemagicPatchErrorCode.NotDownloaded,
      'downloadUpdate requires a full bundle URL or patch URL.',
    );
  }

  state.downloadInProgress = true;

  try {
    state.downloadedPackages.set(remotePackage.packageHash, selectedRemotePackage);

    let deliveryType: 'patch' | 'full_bundle' = remotePackage.patchUrl ? 'patch' : 'full_bundle';

    const downloadNativeArtifact = async (artifactType: UpdateArtifactType): Promise<void> => {
      const url = artifactType === 'patch' ? remotePackage.patchUrl! : remotePackage.fullBundleUrl!;
      const manifestBytes =
        artifactType === 'patch' ? (remotePackage.patchSize ?? undefined) : remotePackage.fullBundleSize;
      const expectedBytes = positiveByteCount(manifestBytes);
      const totalBytes = expectedBytes ?? 0;
      let lastReceivedBytes = 0;

      if (onProgress) {
        onProgress({ totalBytes, receivedBytes: 0 });
      }

      const subscription = onProgress
        ? await subscribeNativeDownloadProgress(remotePackage.packageHash, artifactType, (progress) => {
            lastReceivedBytes = progress.receivedBytes;
            onProgress(progress);
          })
        : null;

      try {
        await CodemagicPatch.downloadUpdate(
          nativeDownloadRequest(
            {
              packageHash: remotePackage.packageHash,
              artifactType,
              url,
              metadata: {
                label: remotePackage.label,
                isMandatory: remotePackage.isMandatory,
                releaseNotes: remotePackage.releaseNotes,
                signatureVerified: state.publicKeyConfigured ? Boolean(selectedRemotePackage.signature) : false,
              },
            },
            expectedBytes,
          ),
        );
      } finally {
        await subscription?.remove();
      }

      if (onProgress) {
        onProgress({
          totalBytes,
          receivedBytes: totalBytes > 0 ? totalBytes : lastReceivedBytes,
        });
      }
    };

    const firstArtifactType: UpdateArtifactType = remotePackage.patchUrl ? 'patch' : 'full_bundle';

    try {
      await downloadNativeArtifact(firstArtifactType);
    } catch (error) {
      if (firstArtifactType !== 'patch' || !remotePackage.fullBundleUrl) {
        await recordEvent('Failed', {
          packageHash: remotePackage.packageHash,
          deliveryType: firstArtifactType,
          status: 'download',
          reason: 'network',
          payload: networkFailurePayload(error),
        });
        throw error;
      }

      deliveryType = 'full_bundle';
      try {
        await downloadNativeArtifact('full_bundle');
      } catch (fullBundleError) {
        await recordEvent('Failed', {
          packageHash: remotePackage.packageHash,
          deliveryType: 'full_bundle',
          status: 'download',
          reason: 'network',
          payload: networkFailurePayload(fullBundleError),
        });
        throw fullBundleError;
      }
    }

    const localPackage: LocalPackage = {
      ...remotePackage,
      installedAt: nowIso(),
      source: deliveryType,
    };

    await recordEvent('Downloaded', {
      packageHash: localPackage.packageHash,
      deliveryType,
    });
    return localPackage;
  } finally {
    state.downloadInProgress = false;
  }
}
