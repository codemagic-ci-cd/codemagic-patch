import { assertArtifactConsistency, type Artifact } from "./artifact";
import { ArtifactError, CMPATCH_BUNDLE_FILE, type ReleasePolicyDefaults } from "./descriptor";

/**
 * Upload-time policy. Seeded from `descriptor.defaults` but always supplied by the
 * caller (CLI flags / web form). `releaseNotes === undefined` ⇒ omitted from the
 * uploaded metadata (matching the CLI's behavior of only sending notes when given).
 */
export interface UploadPolicy {
  rolloutPercentage: number;
  isMandatory: boolean;
  disabled: boolean;
  noDuplicateReleaseError: boolean;
  releaseNotes?: string;
}

/** Build an UploadPolicy from descriptor defaults plus optional caller overrides. */
export function resolveUploadPolicy(
  defaults: ReleasePolicyDefaults,
  overrides: Partial<UploadPolicy> = {},
): UploadPolicy {
  const releaseNotes =
    overrides.releaseNotes ?? (defaults.releaseNotes !== "" ? defaults.releaseNotes : undefined);
  const policy: UploadPolicy = {
    rolloutPercentage: overrides.rolloutPercentage ?? defaults.rolloutPercentage,
    isMandatory: overrides.isMandatory ?? defaults.isMandatory,
    disabled: overrides.disabled ?? defaults.disabled,
    noDuplicateReleaseError:
      overrides.noDuplicateReleaseError ?? defaults.noDuplicateReleaseError,
  };
  if (releaseNotes !== undefined) {
    policy.releaseNotes = releaseNotes;
  }
  return policy;
}

/**
 * The release-relevant fields needed to build the upload multipart — the narrow
 * input the CLI upload path has on hand, without fabricating a full descriptor.
 */
export interface ReleaseFormParts {
  fingerprint: string;
  targetBinaryVersion: string;
  signature?: string;
  signatureHashAlgorithm?: string;
  bundleZip: Uint8Array;
  /** Multipart filename for the bundle part; defaults to "bundle.zip". The server ignores it. */
  bundleFile?: string;
  sourcemap?: Uint8Array;
  sourcemapFile?: string;
}

/**
 * The single source of truth for the `POST /v1/deployments/:id/releases` multipart
 * body, shared by the CLI upload path and the web. Mirrors cli/src/multipart.ts:
 * the same `metadata` field set and order (the JSON is byte-sensitive), `metadata`
 * as the FIRST part (the server enforces ordering), and the bundle uploaded verbatim.
 */
export function releaseFormFromParts(parts: ReleaseFormParts, policy: UploadPolicy): FormData {
  if ((parts.sourcemap !== undefined) !== (parts.sourcemapFile !== undefined)) {
    throw new ArtifactError("sourcemap bytes and sourcemapFile must be provided together");
  }

  const metadata: Record<string, unknown> = {
    disabled: policy.disabled,
    fingerprint: parts.fingerprint,
    is_mandatory: policy.isMandatory,
    no_duplicate_release_error: policy.noDuplicateReleaseError,
    rollout_percentage: policy.rolloutPercentage,
    target_binary_version: parts.targetBinaryVersion,
  };
  if (policy.releaseNotes !== undefined) {
    metadata.release_notes = policy.releaseNotes;
  }
  if (parts.signature !== undefined) {
    metadata.signature = parts.signature;
  }
  if (parts.signatureHashAlgorithm !== undefined) {
    metadata.signature_hash_algorithm = parts.signatureHashAlgorithm;
  }

  const form = new FormData();
  form.set("metadata", JSON.stringify(metadata));
  form.set(
    "bundle",
    new Blob([parts.bundleZip], { type: "application/zip" }),
    parts.bundleFile ?? CMPATCH_BUNDLE_FILE,
  );
  if (parts.sourcemap !== undefined && parts.sourcemapFile !== undefined) {
    form.set(
      "sourcemap",
      new Blob([parts.sourcemap], { type: "application/octet-stream" }),
      parts.sourcemapFile,
    );
  }
  return form;
}

/**
 * Convenience over {@link releaseFormFromParts} for callers that already hold a full
 * Artifact (the web after `parseArtifact`, or a `.cmpatch` re-upload). The CLI upload
 * path uses `releaseFormFromParts` directly.
 */
export function artifactToReleaseForm(artifact: Artifact, policy: UploadPolicy): FormData {
  assertArtifactConsistency(artifact);
  const { descriptor } = artifact;
  return releaseFormFromParts(
    {
      fingerprint: descriptor.fingerprint,
      targetBinaryVersion: descriptor.targetBinaryVersion,
      signature: descriptor.signature,
      signatureHashAlgorithm: descriptor.signatureHashAlgorithm,
      bundleZip: artifact.bundleZip,
      bundleFile: descriptor.bundleFile,
      sourcemap: artifact.sourcemap,
      sourcemapFile: descriptor.sourcemapFile,
    },
    policy,
  );
}
