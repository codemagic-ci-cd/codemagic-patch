// Adapted from codemagic-ci-cd/codemagic-patch@b41c6f556e13346ff9b666eb82490900672f1dd9
// client/src/checkForUpdate.ts (Apache-2.0). Changes from upstream, documented in
// specs/UPSTREAM-DIVERGENCE.md:
// 1. `NativeCodemagicPatch` -> `CodemagicPatch` (../nativeCodemagicPatch), with the
//    object-wrapped return shapes this package's native boundary uses (see
//    specs/ARCHITECTURE.md § 4): `verifyJwtSignature()` returns `{ valid }`, not a bare
//    boolean.
// 2. `fetchManifest()`'s result is a real discriminated union at this package's native
//    boundary (`ManifestFetchResult` in ../definitions), not upstream's flat
//    status/source struct — a consequence of ADR-0001's divergence (Capacitor's bridge
//    has no RN-codegen constraint against unions). This removes upstream's
//    `result.source as "running-package" | "binary-version"` cast: the union already
//    narrows correctly once `result.status === "ok"` is checked.
// 3. `CodemagicPatchError`/`CodemagicPatchErrorCode` now come from ../definitions, not
//    ./types — see specs/adr/0008-unified-error-taxonomy.md.
// 4. A rejected `fetchManifest()` records `Failed(status=check, reason=network)`,
//    once per distinct failure code per process (`state.lastCheckFailureCode`).
//    client/specs/metrics/Spec.md's `network` reason covers manifest fetches, but
//    upstream's own checkForUpdate.ts records nothing there — see
//    specs/CHANGELOG.md#e4--network-failure-reason-metrics.

import { CodemagicPatchError, CodemagicPatchErrorCode, type ManifestContext } from '../definitions';
import CodemagicPatch from '../nativeCodemagicPatch';

import { recordEvent } from './events';
import { commonFailurePayload, networkFailurePayload, readDataString } from './failurePayload';
import { isBinaryRevert, isNoOp, selectTarget } from './manifest';
import { parseManifestJson, parseStoreUpdateMetadata, type StoreUpdateMetadata } from './parser';
import { computeRolloutHash } from './rollout';
import { ensureHydrated, state } from './runtime';
import type { ManifestResponse, RemotePackage, RuntimeRemotePackage, UpdateCheckResult } from './types';

function createRemotePackageView(remotePackage: RuntimeRemotePackage, previouslyFailed: boolean): RemotePackage {
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
    action: 'up-to-date',
    ...updateCheckBase(),
  });
}

function otaUpdateResult(remotePackage: RuntimeRemotePackage): UpdateCheckResult {
  return rememberUpdateCheckResult({
    action: 'ota-update',
    remotePackage: createRemotePackageView(
      remotePackage,
      state.failedInstall?.packageHash === remotePackage.packageHash,
    ),
    ...updateCheckBase(),
  });
}

function embeddedRevertResult(): UpdateCheckResult {
  return rememberUpdateCheckResult({
    action: 'embedded-revert',
    ...updateCheckBase(),
  });
}

function applyNativeManifestContext(context: ManifestContext): void {
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
 * Verify code signing per the 4-way enforcement matrix:
 * - key ✓ + sig ✓ → verify (CodemagicPatch.verifyJwtSignature)
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
    await recordEvent('Failed', {
      packageHash,
      status: 'check',
      reason: 'signature_verification',
    });
    return 'Manifest signature verification failed (missing signature)';
  }

  const { valid } = await CodemagicPatch.verifyJwtSignature({
    jwt: signature,
    contentHash: packageHash,
  });

  if (valid) {
    return null;
  }

  await recordEvent('Failed', {
    packageHash,
    status: 'check',
    reason: 'signature_verification',
  });
  return 'Manifest signature verification failed (public key mismatch)';
}

async function evaluateManifest(
  manifest: ManifestResponse | null,
  source: 'running-package' | 'binary-version',
): Promise<UpdateCheckResult> {
  if (!manifest) {
    throw new CodemagicPatchError(CodemagicPatchErrorCode.InvalidManifest, 'Manifest schema validation failed');
  }

  if (isBinaryRevert(manifest)) {
    return state.runningPackage ? embeddedRevertResult() : upToDateResult();
  }

  const runningHash = state.runningPackage?.packageHash ?? '';

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

  const signatureError = await getManifestSignatureError(target.signature, target.packageHash);

  if (signatureError) {
    if (target.isPreviousFallback) {
      return upToDateResult();
    }

    state.failedInstall = {
      packageHash: target.packageHash,
      reason: 'signature_verification',
    };
    throw new CodemagicPatchError(CodemagicPatchErrorCode.SignatureMismatch, signatureError);
  }

  const runtimeRemote: RuntimeRemotePackage = {
    packageHash: target.packageHash,
    label: target.releaseLabel,
    deploymentKey: state.deploymentKey,
    releaseNotes: target.releaseNotes ?? null,
    isMandatory: target.isMandatory,
    fullBundleUrl: target.fullBundleUrl,
    // PROTOCOL.md: responses on the fallback path MUST omit patch_url, and any
    // patch_url present there is a protocol violation the client must ignore.
    // Enforced here rather than trusted from the manifest, regardless of what a
    // (possibly buggy) server actually sent — see specs/PROTOCOL-CONFORMANCE.md J5.
    patchUrl: source === 'binary-version' ? null : (target.patchUrl ?? null),
    fullBundleSize: target.fullBundleSize,
    patchSize: source === 'binary-version' ? null : (target.patchSize ?? null),
    signature: target.signature ?? null,
  };

  state.remotePackage = runtimeRemote;
  return otaUpdateResult(runtimeRemote);
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  await ensureHydrated();

  try {
    const result = await CodemagicPatch.fetchManifest();
    // A successful fetch ends any run of identical check-failure events this
    // process was suppressing (see the catch block below) — the next failure,
    // whenever it comes, is a fresh outage, not a continuation of the last one.
    state.lastCheckFailureCode = null;
    applyNativeManifestContext(result.context);
    applyStoreUpdateMetadata(parseStoreUpdateMetadata(result.metaJson, result.context.binaryVersion));

    if (state.binaryVersion === null) {
      // Native did not report a binary version for this process. Without a
      // baseline we cannot evaluate manifest targets or compare against
      // `meta.json`, so the round becomes a no-op. Surface the condition
      // through a Failed metric event so the gap is visible in telemetry.
      await recordEvent('Failed', {
        status: 'check',
        reason: 'missing_binary_version',
        payload: commonFailurePayload(),
      });
      return upToDateResult();
    }

    if (result.status === 'not-found') {
      return upToDateResult();
    }

    // `result` is narrowed to the "ok" branch of ManifestFetchResult here, so
    // `result.source` is already `ManifestSource` — no upstream-style cast needed.
    return await evaluateManifest(parseManifestJson(result.manifestJson), result.source);
  } catch (error) {
    if (error instanceof CodemagicPatchError) {
      throw error;
    }

    // A rejected CodemagicPatch.fetchManifest() call — anything else thrown in
    // this block already surfaced as its own CodemagicPatchError above and is
    // handled by its own reason (missing_binary_version, signature_verification,
    // invalid_manifest), not this one. client/specs/metrics/Spec.md's `network`
    // reason is explicitly "Manifest fetch or artifact download failed", so a
    // manifest-fetch failure gets the same reason downloadUpdate.ts already
    // records for a download failure — read from the native rejection itself,
    // before it's wrapped below, since that's where detail_code/detail_message
    // (PROTOCOL.md § Metric Event `Failed` Payload) actually live.
    // state.deploymentKey/state.binaryVersion have no source until a manifest
    // fetch actually resolves once (see applyNativeManifestContext below) — for
    // a device where this is the first check of the process, or one stuck in a
    // sustained outage, that may never have happened yet. Native attaches its
    // own local config's deploymentKey/binaryVersion (resolved before it ever
    // attempted the fetch) onto the rejection for exactly this reason, under
    // the same `data` channel as detail_code/detail_message — read here rather
    // than left to fall back to a blank state.deploymentKey, which the server's
    // required-field validation would silently drop the event over.
    const deploymentKey = readDataString(error, 'deployment_key');
    const binaryVersion = readDataString(error, 'binary_version');
    const payload = networkFailurePayload(error);
    // `networkFailurePayload` always sets `code` in practice (`MetricsFailurePayload.code`
    // is optional only because other failure reasons have no code at all) — normalized
    // to `null` here purely to match `lastCheckFailureCode`'s type, not because it's
    // ever actually missing for a `network` payload.
    const failureCode = payload.code ?? null;

    // Code-review finding: a sustained outage (artifact origin and metrics API
    // both unreachable, or the device simply offline) re-enters this catch
    // block on every foreground sync, each with its own unique event_id
    // (events.ts never collapses these), so an extended outage could fill the
    // WAL's 100-event cap with near-identical reports of the same failure —
    // oldest-first eviction (enforceEventQueueCap) would then push out genuinely
    // distinct earlier events (Downloaded/Installed) first. Only the first
    // occurrence of a given failure code is recorded; a change in code (a
    // different failure mode) or a successful check in between (which resets
    // `lastCheckFailureCode` above) starts recording again.
    if (state.lastCheckFailureCode !== failureCode) {
      state.lastCheckFailureCode = failureCode;
      await recordEvent('Failed', {
        status: 'check',
        reason: 'network',
        payload,
        ...(deploymentKey ? { deploymentKey } : {}),
        ...(binaryVersion ? { binaryVersion } : {}),
      });
    }

    throw new CodemagicPatchError(
      CodemagicPatchErrorCode.NetworkError,
      error instanceof Error ? error.message : 'Network error during update check',
    );
  }
}
