/**
 * TurboModule contract for the native CodemagicPatch module.
 *
 * This is the narrow JS/native boundary.
 * Native owns CodemagicPatch storage, boot selection, artifact I/O, package
 * finalization, metrics WAL/delivery, and crypto resources. JS consumes only
 * package-scoped and lifecycle-specific methods; there is no generic config,
 * storage, path, or file bridge here.
 */

import { TurboModuleRegistry, type TurboModule } from "react-native";

export type NativeBootSource = "embedded" | "current" | "pending";

export interface NativeFailedInstall {
  packageHash: string;
  reason: string;
  failedAt: string;
}

export interface NativeBootState {
  // One of `NativeBootSource`'s values. Typed `string` at the boundary because
  // RN 0.76's ObjC++ codegen rejects string-literal unions as struct fields; JS
  // narrows it back to `NativeBootSource` on read.
  bootSource: string;
  runningPackageHash: string | null;
  confirmedPackageHash: string | null;
  pendingPackageHash: string | null;
  previousPackageHash: string | null;
  failedInstall: NativeFailedInstall | null;
}

export type NativeManifestSource = "running-package" | "binary-version";

export interface NativeManifestContext {
  deploymentKey: string;
  binaryVersion: string | null;
  runningPackageHash: string | null;
  deviceId: string;
  publicKeyConfigured: boolean;
}

// Flat struct rather than a discriminated union. RN 0.76's ObjC++ TurboModule
// codegen rejects a union return type ("Union types are unsupported in
// structs"), so the status/manifestJson correlation is a runtime contract
// upheld by the native module instead of being expressed in the type:
//   - status "ok"        → `manifestJson` is a non-null JSON string
//   - status "not-found" → `manifestJson` is null and `source` is "binary-version"
export interface NativeManifestFetchResult {
  // `status` is "ok" | "not-found"; `source` is one of `NativeManifestSource`.
  // Both typed `string` because RN 0.76's ObjC++ codegen rejects string-literal
  // unions as struct fields. The status/manifestJson correlation is a native
  // runtime contract upheld by the module, not the type:
  //   - "ok"        → `manifestJson` is a non-null JSON string
  //   - "not-found" → `manifestJson` is null and `source` is "binary-version"
  status: string;
  source: string;
  manifestJson: string | null;
  metaJson: string | null;
  context: NativeManifestContext;
}

export interface NativePackageMetadata {
  package_hash: string;
  binary_version: string;
  deployment_key: string;
  label: string;
  is_mandatory: boolean;
  release_notes: string | null;
  installed_at: string;
  // "patch" | "full_bundle"; typed `string` for RN 0.76 codegen compatibility.
  source: string;
  signature_verified?: boolean;
  success_reported_at?: string | null;
  last_active_reported_at?: string | null;
}

export type NativeUpdateArtifactType = "patch" | "full_bundle";

export interface NativePendingUpdateMetadataInput {
  label: string;
  isMandatory: boolean;
  releaseNotes: string | null;
  signatureVerified?: boolean;
}

export interface NativeDownloadUpdateRequest {
  packageHash: string;
  // One of `NativeUpdateArtifactType`. Typed `string` for RN 0.76 codegen
  // compatibility (JS literals are still assignable on write).
  artifactType: string;
  url: string;
  expectedBytes?: number;
  metadata: NativePendingUpdateMetadataInput;
}

export interface NativeInstallUpdateRequest {
  packageHash: string;
}

export interface NativeJwtVerificationRequest {
  jwt: string;
  contentHash: string;
}

export interface Spec extends TurboModule {
  getBootState(): Promise<NativeBootState>;
  fetchManifest(): Promise<NativeManifestFetchResult>;
  getDeviceId(): Promise<string>;
  getPackageMetadata(packageHash: string): Promise<NativePackageMetadata | null>;

  enqueueMetricEvent(eventJson: string): Promise<void>;

  downloadUpdate(request: NativeDownloadUpdateRequest): Promise<void>;
  installUpdate(request: NativeInstallUpdateRequest): Promise<void>;
  confirmPendingUpdate(): Promise<void>;
  stageEmbeddedRevert(): Promise<void>;
  clearUpdatesForTests(): Promise<void>;
  reloadBundle(): Promise<void>;

  verifyJwtSignature(request: NativeJwtVerificationRequest): Promise<boolean>;
}

// Resolved at module load. If the TurboModule isn't registered (autolinking
// failed, host app needs a rebuild), getEnforcing throws here and the JS bundle
// fails to evaluate — surfacing the build error loudly at app boot instead of
// degrading into recoverable runtime failures at the first SDK call.
const NativeCodemagicPatch: Spec = TurboModuleRegistry.getEnforcing<Spec>("NativeCodemagicPatch");

export default NativeCodemagicPatch;
