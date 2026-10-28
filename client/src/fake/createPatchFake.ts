/**
 * Native-boundary fake for testing apps that use the SDK.
 *
 * The fake replaces the `NativeCodemagicPatch` TurboModule, not the SDK: the
 * real JS runtime hydrates from it, evaluates its manifests and drives its
 * download / install calls, so a test sees the same results an app would.
 * Runner-neutral on purpose: plain async functions, no test-runner imports.
 *
 * Things that behave like the real SDK and can surprise a test:
 * - `sync()` calls `notifyAppReady()` first, which confirms an unconfirmed
 *   running package. To keep it unconfirmed, use `checkForUpdate()` /
 *   `downloadUpdate()` / `installUpdate()` instead of `sync()`.
 * - A server release equal to the running package, the already installed next
 *   package, or the failed install is not downloaded again.
 * - A mandatory release installs `IMMEDIATE` unless `mandatoryInstallMode` says
 *   otherwise.
 * - `restartApp()` resolves but does not reload JS: after it the SDK still
 *   reports the package as ready, not as running. Load the SDK again with a
 *   new fake to test the next launch.
 */

import type {
  NativeBootState,
  NativeDownloadUpdateRequest,
  NativeInstallUpdateRequest,
  NativeManifestContext,
  NativeManifestFetchResult,
  NativePackageMetadata,
  Spec,
} from "../NativeCodemagicPatch";
import type {
  PatchFake,
  PatchFakeMethod,
  PatchFakeSeed,
  PatchFakeServer,
  PatchPackageSeed,
} from "./types";

const DEFAULT_BINARY_VERSION = "1.0.0";
const DEFAULT_DEPLOYMENT_KEY = "patch-fake-deployment-key";
const DEVICE_ID = "patch-fake-device-id";
// Seeded packages were installed by an earlier launch; a fixed time keeps
// their metadata identical across runs.
const SEEDED_INSTALLED_AT = "2026-01-01T00:00:00.000Z";
const DEFAULT_FAILED_INSTALL_REASON = "crash_rollback";
const RELEASE_BUNDLE_SIZE = 1024;
const PACKAGE_HASH_PATTERN = /^[a-f0-9]{64}$/;

interface ResolvedPackage {
  packageHash: string;
  label: string;
  releaseNotes: string | null;
  isMandatory: boolean;
}

interface FakeCore {
  bootState: NativeBootState;
  binaryVersion: string;
  deploymentKey: string;
  server: PatchFakeServer;
  failures: Map<PatchFakeMethod, Error>;
  /** Metadata native can answer for: seeded packages plus everything downloaded since. */
  metadata: Map<string, NativePackageMetadata>;
}

const cores = new WeakMap<PatchFake, FakeCore>();
const nativeModules = new WeakMap<PatchFake, Spec>();

// FNV-1a, run eight times with different salts to fill 64 hex chars. Only
// needs to be stable and distinct per label, not cryptographic.
function hashFromLabel(label: string): string {
  let out = "";
  for (let salt = 0; salt < 8; salt += 1) {
    let hash = 0x811c9dc5;
    const input = `${salt}:${label}`;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    out += hash.toString(16).padStart(8, "0");
  }
  return out;
}

function resolvePackageHash(where: string, label: string | undefined, packageHash: string | undefined): string {
  if (packageHash !== undefined) {
    if (!PACKAGE_HASH_PATTERN.test(packageHash)) {
      throw new Error(
        `createPatchFake: ${where}.packageHash must be 64 lowercase hex characters, got "${packageHash}".`,
      );
    }
    return packageHash;
  }
  if (label === undefined) {
    throw new Error(`createPatchFake: ${where} needs a label or a packageHash.`);
  }
  return hashFromLabel(label);
}

function resolvePackage(where: string, seed: PatchPackageSeed): ResolvedPackage {
  return {
    packageHash: resolvePackageHash(where, seed.label, seed.packageHash),
    label: seed.label,
    releaseNotes: seed.releaseNotes ?? null,
    isMandatory: seed.isMandatory ?? false,
  };
}

function seededMetadata(
  pkg: ResolvedPackage,
  seed: PatchFakeSeed,
  options: { confirmed: boolean },
): NativePackageMetadata {
  return {
    package_hash: pkg.packageHash,
    binary_version: seed.binaryVersion ?? DEFAULT_BINARY_VERSION,
    deployment_key: seed.deploymentKey ?? DEFAULT_DEPLOYMENT_KEY,
    label: pkg.label,
    is_mandatory: pkg.isMandatory,
    release_notes: pkg.releaseNotes,
    installed_at: SEEDED_INSTALLED_AT,
    source: "full_bundle",
    signature_verified: false,
    // A confirmed package already reported Applied; an unconfirmed one has not.
    success_reported_at: options.confirmed ? SEEDED_INSTALLED_AT : null,
    last_active_reported_at: null,
  };
}

function createCore(seed: PatchFakeSeed): FakeCore {
  const running = seed.running ? resolvePackage("running", seed.running) : null;
  const previous = seed.previous ? resolvePackage("previous", seed.previous) : null;

  if (seed.runningUnconfirmed && !running) {
    throw new Error("createPatchFake: runningUnconfirmed needs a running package.");
  }
  if (previous && !seed.runningUnconfirmed) {
    throw new Error(
      "createPatchFake: previous without runningUnconfirmed is not supported yet. Seed previous only together with running + runningUnconfirmed.",
    );
  }

  const failedInstall = seed.failedInstall
    ? {
        packageHash: resolvePackageHash(
          "failedInstall",
          seed.failedInstall.label,
          seed.failedInstall.packageHash,
        ),
        reason: seed.failedInstall.reason ?? DEFAULT_FAILED_INSTALL_REASON,
        failedAt: SEEDED_INSTALLED_AT,
      }
    : null;

  if (failedInstall && running && failedInstall.packageHash === running.packageHash) {
    throw new Error(
      "createPatchFake: failedInstall cannot be the running package. Native never boots a package it recorded as failed.",
    );
  }

  const metadata = new Map<string, NativePackageMetadata>();
  let bootState: NativeBootState;

  if (!running) {
    bootState = {
      bootSource: "embedded",
      runningPackageHash: null,
      confirmedPackageHash: null,
      pendingPackageHash: null,
      previousPackageHash: null,
      failedInstall,
      androidPreviousProcessExit: null,
    };
  } else if (seed.runningUnconfirmed) {
    metadata.set(running.packageHash, seededMetadata(running, seed, { confirmed: false }));
    if (previous) {
      metadata.set(previous.packageHash, seededMetadata(previous, seed, { confirmed: true }));
    }
    bootState = {
      bootSource: "pending",
      runningPackageHash: running.packageHash,
      confirmedPackageHash: previous?.packageHash ?? null,
      pendingPackageHash: running.packageHash,
      previousPackageHash: previous?.packageHash ?? null,
      failedInstall,
      androidPreviousProcessExit: null,
    };
  } else {
    metadata.set(running.packageHash, seededMetadata(running, seed, { confirmed: true }));
    bootState = {
      bootSource: "current",
      runningPackageHash: running.packageHash,
      confirmedPackageHash: running.packageHash,
      pendingPackageHash: null,
      previousPackageHash: null,
      failedInstall,
      androidPreviousProcessExit: null,
    };
  }

  return {
    bootState,
    binaryVersion: seed.binaryVersion ?? DEFAULT_BINARY_VERSION,
    deploymentKey: seed.deploymentKey ?? DEFAULT_DEPLOYMENT_KEY,
    server: seed.server ?? {},
    failures: new Map(),
    metadata,
  };
}

function manifestContext(core: FakeCore): NativeManifestContext {
  return {
    deploymentKey: core.deploymentKey,
    binaryVersion: core.binaryVersion,
    runningPackageHash: core.bootState.runningPackageHash,
    deviceId: DEVICE_ID,
    publicKeyConfigured: false,
  };
}

function fetchManifestResult(core: FakeCore): NativeManifestFetchResult {
  const metaJson =
    core.server.latestBinaryVersion !== undefined
      ? JSON.stringify({ latest_binary_version: core.server.latestBinaryVersion })
      : null;
  const context = manifestContext(core);
  const release = core.server.release
    ? resolvePackage("server.release", core.server.release)
    : null;

  if (!release) {
    // Native reports not-found only for the binary-version URL (sdk-native Spec).
    return { status: "not-found", source: "binary-version", manifestJson: null, metaJson, context };
  }

  return {
    status: "ok",
    source: core.bootState.runningPackageHash ? "running-package" : "binary-version",
    manifestJson: JSON.stringify({
      target_package_hash: release.packageHash,
      release_label: release.label,
      full_bundle_url: `https://patch-fake.invalid/bundles/${release.packageHash}.tar.zst`,
      full_bundle_size: RELEASE_BUNDLE_SIZE,
      is_mandatory: release.isMandatory,
      rollout_percentage: 100,
      ...(release.releaseNotes !== null ? { release_notes: release.releaseNotes } : {}),
    }),
    metaJson,
    context,
  };
}

function createNativeModule(core: FakeCore): Spec {
  function checkFailure(method: PatchFakeMethod): void {
    const error = core.failures.get(method);
    if (error) {
      throw error;
    }
  }

  return {
    async getBootState() {
      checkFailure("getBootState");
      return {
        ...core.bootState,
        failedInstall: core.bootState.failedInstall ? { ...core.bootState.failedInstall } : null,
      };
    },
    async fetchManifest() {
      checkFailure("fetchManifest");
      if (core.server.error) {
        throw core.server.error;
      }
      return fetchManifestResult(core);
    },
    async getDeviceId() {
      checkFailure("getDeviceId");
      return DEVICE_ID;
    },
    async getPackageMetadata(packageHash: string) {
      checkFailure("getPackageMetadata");
      const metadata = core.metadata.get(packageHash);
      return metadata ? { ...metadata } : null;
    },
    async enqueueMetricEvent(_eventJson: string) {
      checkFailure("enqueueMetricEvent");
    },
    async downloadUpdate(request: NativeDownloadUpdateRequest) {
      checkFailure("downloadUpdate");
      core.metadata.set(request.packageHash, {
        package_hash: request.packageHash,
        binary_version: core.binaryVersion,
        deployment_key: core.deploymentKey,
        label: request.metadata.label,
        is_mandatory: request.metadata.isMandatory,
        release_notes: request.metadata.releaseNotes,
        installed_at: new Date().toISOString(),
        source: request.artifactType,
        signature_verified: request.metadata.signatureVerified ?? false,
        success_reported_at: null,
        last_active_reported_at: null,
      });
    },
    async installUpdate(request: NativeInstallUpdateRequest) {
      checkFailure("installUpdate");
      if (!core.metadata.has(request.packageHash)) {
        throw new Error(`Package ${request.packageHash} was not downloaded.`);
      }
    },
    async confirmPendingUpdate() {
      checkFailure("confirmPendingUpdate");
    },
    async stageEmbeddedRevert() {
      checkFailure("stageEmbeddedRevert");
    },
    async clearUpdatesForTests() {
      checkFailure("clearUpdatesForTests");
    },
    async reloadBundle() {
      checkFailure("reloadBundle");
    },
    async verifyJwtSignature() {
      checkFailure("verifyJwtSignature");
      return false;
    },
  } satisfies Spec;
}

export function createPatchFake(seed: PatchFakeSeed = {}): PatchFake {
  const core = createCore(seed);
  const fake: PatchFake = {
    fail(method, error) {
      if (error) {
        core.failures.set(method, error);
      } else {
        core.failures.delete(method);
      }
    },
    setServer(server) {
      // Validate now so a bad release fails at the call site, not inside the SDK.
      if (server.release) {
        resolvePackage("server.release", server.release);
      }
      core.server = server;
    },
  };
  if (seed.server?.release) {
    resolvePackage("server.release", seed.server.release);
  }
  cores.set(fake, core);
  return fake;
}

/**
 * The `NativeCodemagicPatch` implementation behind a fake, for adapters that
 * install it in place of the TurboModule. Not part of the public entry: its
 * shape is the native wire contract.
 */
export function patchFakeNativeModule(fake: PatchFake): Spec {
  let nativeModule = nativeModules.get(fake);
  if (!nativeModule) {
    const core = cores.get(fake);
    if (!core) {
      throw new Error("patchFakeNativeModule: not a fake from createPatchFake().");
    }
    nativeModule = createNativeModule(core);
    nativeModules.set(fake, nativeModule);
  }
  return nativeModule;
}
