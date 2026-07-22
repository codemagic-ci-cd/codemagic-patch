import {
  CodemagicPatchError,
  CodemagicPatchErrorCode,
  type ManifestResponse,
  type RemotePackage,
  type RuntimeRemotePackage,
  type UpdateCheckResult,
} from "./types";
import NativeCodemagicPatch, {
  type NativeManifestContext,
} from "./NativeCodemagicPatch";
import { isBinaryRevert, isNoOp, selectTarget } from "./manifest";
import {
  parseManifestJson,
  parseStoreUpdateMetadata,
  type StoreUpdateMetadata,
} from "./parser";
import { computeRolloutHash } from "./rollout";
import { ensureHydrated, state } from "./runtime";
import { recordEvent } from "./events";

function createRemotePackageView(
  remotePackage: RuntimeRemotePackage,
  previouslyFailed: boolean,
): RemotePackage {
  return {
    packageHash: remotePackage.packageHash,
    label: remotePackage.label,
    deploymentKey: remotePackage.deploymentKey,
    releaseNotes: remotePackage.releaseNotes,
    isMandatory: remotePackage.isMandatory,
    fullBundleUrl: remotePackage.fullBundleUrl,
    patchUrl: remotePackage.patchUrl,
    fullBundleSize: remotePackage.fullBundleSize ?? 0,
    patchSize: remotePackage.patchSize ?? null,
    previouslyFailed,
  };
}

function updateCheckBase() {
  return {
    isStoreUpdateAvailable: state.storeUpdateAvailable,
    latestBinaryVersion: state.latestBinaryVersion,
  };
}

function rememberUpdateCheckResult(result: UpdateCheckResult): UpdateCheckResult {
  state.lastUpdateCheckResult = result;
  return result;
}

function upToDateResult(): UpdateCheckResult {
  return rememberUpdateCheckResult({
    action: "up-to-date",
    ...updateCheckBase(),
  });
}

function otaUpdateResult(remotePackage: RuntimeRemotePackage): UpdateCheckResult {
  return rememberUpdateCheckResult({
    action: "ota-update",
    remotePackage: createRemotePackageView(
      remotePackage,
      state.failedInstall?.packageHash === remotePackage.packageHash,
    ),
    ...updateCheckBase(),
  });
}

function embeddedRevertResult(): UpdateCheckResult {
  return rememberUpdateCheckResult({
    action: "embedded-revert",
    ...updateCheckBase(),
  });
}

function applyNativeManifestContext(context: NativeManifestContext): void {
  state.deploymentKey = context.deploymentKey;
  // Native may report `null` when it cannot determine the binary version for
  // the current process — propagate as-is so downstream consumers can decide
  // how to handle the absence rather than receiving a fabricated value.
  state.binaryVersion = context.binaryVersion;
  // Never let an empty native deviceId clobber the hydrated id.
  if (context.deviceId) {
    state.deviceId = context.deviceId;
  }
  state.publicKeyConfigured = context.publicKeyConfigured;
}

function applyStoreUpdateMetadata(metadata: StoreUpdateMetadata): void {
  state.latestBinaryVersion = metadata.latestBinaryVersion;
  state.storeUpdateAvailable = metadata.isStoreUpdateAvailable;
}

/**
 * Verify code signing per Spec §Enforcement Rules (4-way matrix):
 * - key ✓ + sig ✓ → verify (NativeCodemagicPatch.verifyJwtSignature)
 * - key ✓ + sig ✗ → reject (missing signature)
 * - key ✗ + sig ✓ → skip (warning only)
 * - key ✗ + sig ✗ → proceed normally
 */
async function getManifestSignatureError(
  signature: string | null | undefined,
  packageHash: string,
): Promise<string | null> {
  if (!state.publicKeyConfigured) {
    return null;
  }

  if (!signature) {
    await recordEvent("Failed", {
      packageHash,
      status: "check",
      reason: "signature_verification",
    });
    return "Manifest signature verification failed (missing signature)";
  }

  const valid = await NativeCodemagicPatch.verifyJwtSignature({
    jwt: signature,
    contentHash: packageHash,
  });

  if (valid) {
    return null;
  }

  await recordEvent("Failed", {
    packageHash,
    status: "check",
    reason: "signature_verification",
  });
  return "Manifest signature verification failed (public key mismatch)";
}

async function evaluateManifest(
  manifest: ManifestResponse | null,
  source: "running-package" | "binary-version",
): Promise<UpdateCheckResult> {
  if (!manifest) {
    throw new CodemagicPatchError(
      CodemagicPatchErrorCode.INVALID_MANIFEST,
      "Manifest schema validation failed",
    );
  }

  if (isBinaryRevert(manifest)) {
    return state.runningPackage ? embeddedRevertResult() : upToDateResult();
  }

  const runningHash = state.runningPackage?.packageHash ?? "";

  if (isNoOp(manifest, runningHash)) {
    return upToDateResult();
  }

  const rolloutEligible =
    !manifest.release_label ||
    manifest.rollout_percentage === undefined ||
    manifest.rollout_percentage === null ||
    manifest.rollout_percentage >= 100 ||
    computeRolloutHash(state.deviceId, manifest.release_label) < manifest.rollout_percentage;

  const target = selectTarget(manifest, runningHash, rolloutEligible);

  if (!target) {
    return upToDateResult();
  }

  // The selected target is already installed and awaiting restart — nothing to
  // download or install, so skip before signature enforcement (a path that
  // installs nothing is not signature-verified, same as the no-op path).
  if (state.pendingPackage?.packageHash === target.packageHash) {
    return upToDateResult();
  }

  const signatureError = await getManifestSignatureError(
    target.signature,
    target.packageHash,
  );

  if (signatureError) {
    if (target.isPreviousFallback) {
      return upToDateResult();
    }

    state.failedInstall = {
      packageHash: target.packageHash,
      reason: "signature_verification",
    };
    throw new CodemagicPatchError(
      CodemagicPatchErrorCode.SIGNATURE_MISMATCH,
      signatureError,
    );
  }

  const runtimeRemote: RuntimeRemotePackage = {
    packageHash: target.packageHash,
    label: target.releaseLabel,
    deploymentKey: state.deploymentKey,
    releaseNotes: target.releaseNotes ?? null,
    isMandatory: target.isMandatory,
    fullBundleUrl: target.fullBundleUrl,
    patchUrl: source === "binary-version" ? null : target.patchUrl ?? null,
    fullBundleSize: target.fullBundleSize,
    patchSize: source === "binary-version" ? null : target.patchSize ?? null,
    signature: target.signature ?? null,
  };

  state.remotePackage = runtimeRemote;
  return otaUpdateResult(runtimeRemote);
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  await ensureHydrated();

  try {
    const result = await NativeCodemagicPatch.fetchManifest();
    applyNativeManifestContext(result.context);
    applyStoreUpdateMetadata(
      parseStoreUpdateMetadata(result.metaJson, result.context.binaryVersion),
    );

    if (state.binaryVersion === null) {
      // Native did not report a binary version for this process. Without a
      // baseline we cannot evaluate manifest targets or compare against
      // `meta.json`, so the round becomes a no-op. Surface the condition
      // through a Failed metric event so the gap is visible in telemetry.
      await recordEvent("Failed", {
        status: "check",
        reason: "missing_binary_version",
      });
      return upToDateResult();
    }

    if (result.status === "not-found") {
      return upToDateResult();
    }

    // Native upholds the "running-package" | "binary-version" value space; the
    // boundary type is `string` for RN 0.76 codegen compatibility.
    return await evaluateManifest(
      parseManifestJson(result.manifestJson),
      result.source as "running-package" | "binary-version",
    );
  } catch (error) {
    if (error instanceof CodemagicPatchError) {
      throw error;
    }

    throw new CodemagicPatchError(
      CodemagicPatchErrorCode.NETWORK_ERROR,
      error instanceof Error ? error.message : "Network error during update check",
    );
  }
}
