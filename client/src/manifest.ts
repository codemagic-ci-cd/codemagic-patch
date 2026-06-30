import type { ManifestResponse } from "./types";

// ---------------------------------------------------------------------------
// Selected target — the result of manifest evaluation
// ---------------------------------------------------------------------------

export interface SelectedTarget {
  packageHash: string;
  releaseLabel: string;
  patchUrl: string | undefined;
  patchSize: number | undefined;
  fullBundleUrl: string;
  fullBundleSize: number;
  isMandatory: boolean;
  releaseNotes: string | undefined;
  signature: string | undefined;
  /** Whether this target came from previous_package_info fallback. */
  isPreviousFallback: boolean;
}

// ---------------------------------------------------------------------------
// Manifest evaluation helpers
// ---------------------------------------------------------------------------

/** True when target_package_hash equals the currently running package — no update needed. */
export function isNoOp(
  manifest: ManifestResponse,
  runningPackageHash: string,
): boolean {
  return manifest.target_package_hash === runningPackageHash;
}

/** True when target_package_hash is null — revert to embedded binary. */
export function isBinaryRevert(manifest: ManifestResponse): boolean {
  return manifest.target_package_hash === null;
}

// ---------------------------------------------------------------------------
// Target selection — Spec §Manifest Handling 13 steps
// ---------------------------------------------------------------------------

export interface SignatureVerifier {
  (signature: string | undefined, packageHash: string): boolean;
}

/**
 * Select the target package from a manifest.
 *
 * Implements Spec §Manifest Handling steps 1-13:
 * 1. validate manifest (done by parser.parseManifest)
 * 2-5. binary revert handling (done by caller checking isBinaryRevert)
 * 6-7. no-op check (done by caller checking isNoOp)
 * 8-13. rollout evaluation + previous_package_info fallback
 *
 * @param manifest - Validated manifest (non-null target, not no-op)
 * @param runningPackageHash - Currently running OTA package hash
 * @param rolloutEligible - Whether the installation passes rollout for the root target
 * @param verifySignature - Optional signature verifier. Returns true if valid.
 * @returns Selected target, or null if no eligible target exists
 */
export function selectTarget(
  manifest: ManifestResponse,
  runningPackageHash: string,
  rolloutEligible: boolean,
  verifySignature?: SignatureVerifier,
): SelectedTarget | null {
  const targetHash = manifest.target_package_hash;

  if (targetHash === null) {
    return null;
  }

  // Rollout allows the latest target → select the root manifest package
  if (rolloutEligible) {
    // When a verifier is supplied, enforce the selected target's signature
    if (verifySignature) {
      if (!verifySignature(manifest.signature, targetHash)) {
        return null;
      }
    }

    return {
      packageHash: targetHash,
      releaseLabel: manifest.release_label!,
      patchUrl: manifest.patch_url,
      patchSize: manifest.patch_size,
      fullBundleUrl: manifest.full_bundle_url!,
      fullBundleSize: manifest.full_bundle_size!,
      isMandatory: manifest.is_mandatory!,
      releaseNotes: manifest.release_notes,
      signature: manifest.signature,
      isPreviousFallback: false,
    };
  }

  // Rollout blocks the latest target → try the previous_package_info fallback
  const prev = manifest.previous_package_info;

  if (!prev || prev.package_hash === runningPackageHash) {
    // No fallback available or already on previous
    return null;
  }

  // Verify the previous_package_info signature when a verifier is supplied
  if (verifySignature) {
    if (!verifySignature(prev.signature, prev.package_hash)) {
      // Signature verification failed for fallback — discard, no-op
      return null;
    }
  }

  // Select previous_package_info with its own artifact URLs
  return {
    packageHash: prev.package_hash,
    releaseLabel: prev.release_label,
    patchUrl: prev.patch_url,
    patchSize: prev.patch_size,
    fullBundleUrl: prev.full_bundle_url,
    fullBundleSize: prev.full_bundle_size,
    isMandatory: prev.is_mandatory,
    releaseNotes: prev.release_notes,
    signature: prev.signature,
    isPreviousFallback: true,
  };
}
