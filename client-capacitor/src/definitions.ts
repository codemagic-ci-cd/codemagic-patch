/**
 * The native contract for `@codemagic/capacitor-patch`.
 *
 * This mirrors the 13-row table in `specs/ARCHITECTURE.md` § 4 ("The native contract"),
 * itself derived from the 12-method `Spec` in upstream
 * `codemagic-ci-cd/codemagic-patch`'s `client/src/NativeCodemagicPatch.ts`. Native owns
 * storage, boot selection, artifact I/O, package finalisation, metrics WAL/delivery and
 * crypto resources; JS consumes only these package-scoped and lifecycle-specific
 * methods. There is deliberately no generic config, storage, path or file bridge here —
 * see `specs/adr/0001-fork-protocol-layer-propose-patch-core.md`.
 *
 * Divergence from the upstream RN client: several upstream types are widened to bare
 * `string`, and one result is a flat struct instead of a discriminated union, because
 * "RN 0.76's ObjC++ codegen rejects string-literal unions as struct fields" (verbatim
 * comment in the upstream source). Capacitor's bridge has no such constraint, so this
 * file uses proper discriminated unions throughout. The wire contract is unchanged —
 * see `specs/UPSTREAM-DIVERGENCE.md`.
 *
 * Phase 0 implements `getBootState()` on both platforms. Every other method exists here
 * as a locked type contract but rejects with `CodemagicPatchErrorCode.Unimplemented`
 * until its owning phase lands — see the `@phase` tag on each method below and
 * `specs/IMPLEMENTATION-PLAN.md`. None of this is stubbed to silently succeed: a caller
 * gets a clear rejection, never a fake result.
 */

import type { Plugin } from '@capacitor/core';

/** Where the currently running package came from. `PROTOCOL.md` § On-Device Package Layout. */
export type BootSource = 'embedded' | 'current' | 'pending';

/** A previously attempted install that failed to reach `confirmPendingUpdate()`. */
export interface FailedInstall {
  packageHash: string;
  reason: string;
  failedAt: string;
}

export interface BootState {
  bootSource: BootSource;
  runningPackageHash: string | null;
  confirmedPackageHash: string | null;
  pendingPackageHash: string | null;
  previousPackageHash: string | null;
  failedInstall: FailedInstall | null;
  /**
   * Why this app's previous process ended, as an `ApplicationExitInfo` reason name.
   * Android 11+ only; `null` everywhere else (including every iOS boot). Carried on the
   * boot snapshot because the value is fixed for the process and every `Failed` metric
   * payload wants it (`PROTOCOL.md` § Metric Event `Failed` Payload).
   */
  androidPreviousProcessExit: string | null;
}

/** Which manifest path rule produced a result. `PROTOCOL.md` § `manifest.json` › Path Rule. */
export type ManifestSource = 'running-package' | 'binary-version';

export interface ManifestContext {
  deploymentKey: string;
  binaryVersion: string | null;
  runningPackageHash: string | null;
  deviceId: string;
  publicKeyConfigured: boolean;
}

/**
 * Result of a manifest fetch. A proper discriminated union — see the divergence note
 * above. `metaJson` may be present alongside either variant: `meta.json` is fetched in
 * parallel and is informational only (`PROTOCOL.md` § `meta.json` › Semantics), so its
 * presence or absence never changes which branch of this union is returned.
 */
export type ManifestFetchResult =
  | {
      status: 'ok';
      source: ManifestSource;
      /** Raw JSON text of `manifest.json`. Parsed by `src/protocol/manifest.ts`, not here. */
      manifestJson: string;
      metaJson: string | null;
      context: ManifestContext;
    }
  | {
      status: 'not-found';
      /** Always `'binary-version'` — a 404 on the primary path retries the fallback before giving up. */
      source: 'binary-version';
      manifestJson: null;
      metaJson: string | null;
      context: ManifestContext;
    };

export interface PackageMetadata {
  packageHash: string;
  binaryVersion: string;
  deploymentKey: string;
  label: string;
  isMandatory: boolean;
  releaseNotes: string | null;
  installedAt: string;
  source: 'patch' | 'full_bundle';
  signatureVerified?: boolean;
  successReportedAt?: string | null;
  lastActiveReportedAt?: string | null;
}

export type UpdateArtifactType = 'patch' | 'full_bundle';

export interface PendingUpdateMetadataInput {
  label: string;
  isMandatory: boolean;
  releaseNotes: string | null;
  signatureVerified?: boolean;
}

export interface DownloadUpdateRequest {
  packageHash: string;
  artifactType: UpdateArtifactType;
  url: string;
  expectedBytes?: number;
  metadata: PendingUpdateMetadataInput;
}

export interface InstallUpdateRequest {
  packageHash: string;
}

export interface JwtVerificationRequest {
  jwt: string;
  contentHash: string;
}

/**
 * Stable, machine-checkable error codes. Prefer checking `error.code` over parsing
 * `error.message` — messages may gain detail over time, codes will not change meaning.
 *
 * One taxonomy for both the plugin-boundary layer (this file, `src/web.ts`) and the
 * protocol layer (`src/protocol/*`) — see `specs/adr/0008-unified-error-taxonomy.md` for
 * why these aren't two separate error classes. The `NetworkError`-through-
 * `InvalidUpdateTarget` values are ported from upstream `client/src/types.ts`
 * verbatim (same string values); `Unimplemented`, `UnsupportedOnWeb` and
 * `ConfigurationInvalid` are specific to this plugin-boundary layer and have no
 * upstream equivalent.
 */
export enum CodemagicPatchErrorCode {
  /** The requested method's implementation has not landed yet (see the method's `@phase` tag). */
  Unimplemented = 'UNIMPLEMENTED',
  /** Called from the web platform, where OTA updates have no meaning (see `src/web.ts`). */
  UnsupportedOnWeb = 'UNSUPPORTED_ON_WEB',
  /** A required `capacitor.config.ts` plugin option is missing or malformed (see ADR-0003). */
  ConfigurationInvalid = 'CONFIGURATION_INVALID',
  /** Manifest fetch, or another network call in the sync pipeline, failed. */
  NetworkError = 'NETWORK_ERROR',
  /** `manifest.json` was fetched but failed schema validation (`src/protocol/parser.ts`). */
  InvalidManifest = 'INVALID_MANIFEST',
  /** A signature-enforced target's JWT did not verify against the configured public key. */
  SignatureMismatch = 'SIGNATURE_MISMATCH',
  /** A downloaded or installed package failed a hash/integrity check. */
  IntegrityError = 'INTEGRITY_ERROR',
  /** `downloadUpdate()` called while a download is already in flight. */
  DownloadInProgress = 'DOWNLOAD_IN_PROGRESS',
  /** `sync()` called while a previous `sync()` call is still in flight. */
  SyncInProgress = 'SYNC_IN_PROGRESS',
  /** `installUpdate()` called for a package that was never downloaded. */
  NotDownloaded = 'NOT_DOWNLOADED',
  /** `downloadUpdate()`/`installUpdate()` called with a target that isn't the current update-check result. */
  InvalidUpdateTarget = 'INVALID_UPDATE_TARGET',
  /**
   * A required argument to a native plugin call was missing or blank (e.g. an empty
   * `packageHash`). Added by a code-review finding: native already rejected with the
   * literal string `"INVALID_ARGUMENT"` for this case on both platforms
   * (`CodemagicPatchPlugin.kt`/`.swift`'s `getPackageMetadata`/`downloadUpdate`/
   * `installUpdate`), but this enum had no matching member — an app catching
   * `CodemagicPatchError` and switching on `CodemagicPatchErrorCode` had no case to
   * handle it. `src/protocol/*` itself never triggers this (it validates arguments
   * before ever calling native), so this is reachable only by a caller using the raw
   * native bridge (`../nativeCodemagicPatch`) directly rather than the public API.
   */
  InvalidArgument = 'INVALID_ARGUMENT',
}

export class CodemagicPatchError extends Error {
  constructor(
    public readonly code: CodemagicPatchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CodemagicPatchError';
  }
}

/**
 * Extends Capacitor's own `Plugin` for `addListener`/`removeAllListeners` — every
 * registered Capacitor plugin gets these at runtime regardless of whether its own
 * interface declares them (verified in `ionic-team/capacitor`
 * `core/src/web-plugin.ts` and `core/src/runtime.ts`); declaring the extension here
 * just makes the type match what already works. `Phase 4`'s progress-event contract
 * (`src/protocol/downloadUpdate.ts`) is the first consumer. Mirrors upstream's own
 * `NativeCodemagicPatch.ts`, whose `Spec extends TurboModule` for the same reason.
 */
export interface CodemagicPatchPlugin extends Plugin {
  /**
   * @phase 0 — implemented on both platforms.
   * Returns embedded/current/pending state plus confirmed, pending, previous and
   * running package hashes, and the last failed install if any.
   */
  getBootState(): Promise<BootState>;

  /**
   * @phase 4 — fetches `manifest.json` (and `meta.json` in parallel) from the static
   * delivery origin. Native performs the fetch so the configured URLs and device id
   * never cross into JS; the returned JSON strings are parsed by `src/protocol/manifest.ts`.
   */
  fetchManifest(): Promise<ManifestFetchResult>;

  /** @phase 4 — a stable per-install identifier, used for rollout bucketing. */
  getDeviceId(): Promise<{ deviceId: string }>;

  /** @phase 3 — reads `update.json` next to `packages/{packageHash}/contents/`. */
  getPackageMetadata(options: { packageHash: string }): Promise<{ metadata: PackageMetadata | null }>;

  /** @phase 5 — appends to the on-device metrics write-ahead log; delivery is native's problem. */
  enqueueMetricEvent(options: { eventJson: string }): Promise<void>;

  /** @phase 4 — downloads a full bundle or patch artifact by {@link UpdateArtifactType}. */
  downloadUpdate(options: DownloadUpdateRequest): Promise<void>;

  /**
   * @phase 3/4 — stages a downloaded package as pending and applies it via
   * `WebView.setServerBasePath`. Does not persist — see
   * `specs/adr/0004-update-application-and-boot-selection.md`.
   */
  installUpdate(options: InstallUpdateRequest): Promise<void>;

  /**
   * @phase 3 — promotes the pending package to confirmed in `state/state.json` only.
   * Deliberately does **not** call Capacitor's own `WebView.persistServerBasePath` — see
   * `specs/adr/0004-update-application-and-boot-selection.md`'s "Spike resolution":
   * `state.json` is the sole source of truth for boot selection, resolved fresh by the
   * native plugin's `load()` on every cold boot. Called at the start of `sync()`.
   */
  confirmPendingUpdate(): Promise<void>;

  /** @phase 3 — handles `target_package_hash: null` by reverting to the embedded bundle. */
  stageEmbeddedRevert(): Promise<void>;

  /** @phase 3 — test-only escape hatch. Never called from application code. */
  clearUpdatesForTests(): Promise<void>;

  /**
   * @phase 4 — the one method with no upstream RN equivalent in spirit: RN reloads the
   * JS bundle, Capacitor reloads the WebView after `setServerBasePath`.
   */
  reloadBundle(): Promise<void>;

  /** @phase 7 — verifies a release JWT against the configured public key, if any. */
  verifyJwtSignature(options: JwtVerificationRequest): Promise<{ valid: boolean }>;
}
