// Pure helpers behind the "upload a .cmpatch release" modal. The modal owns
// React state and DOM; everything here is framework-free so it can be unit
// tested directly (the dashboard tests logic, not rendered components).
//
// A .cmpatch is parsed in the browser via the shared parseArtifact (same code the
// CLI uses); the policy form is seeded from the artifact's baked-in defaults and
// then turned back into an UploadPolicy for the multipart upload.

import {
  parseArtifact,
  type Artifact,
  type ReleasePolicyDefaults,
  type UploadPolicy,
} from "@codemagic/patch-shared";

/** Editable policy fields, mirroring ReleasePolicyDefaults with rollout as raw text. */
export interface PolicyForm {
  /** Raw input text; validated by {@link parseRolloutPercent}. */
  rolloutText: string;
  isMandatory: boolean;
  disabled: boolean;
  noDuplicateReleaseError: boolean;
  releaseNotes: string;
}

/** Seed the form from the artifact's baked-in defaults (every field overridable). */
export function seedPolicyForm(defaults: ReleasePolicyDefaults): PolicyForm {
  return {
    rolloutText: String(defaults.rolloutPercentage),
    isMandatory: defaults.isMandatory,
    disabled: defaults.disabled,
    noDuplicateReleaseError: defaults.noDuplicateReleaseError,
    releaseNotes: defaults.releaseNotes,
  };
}

/** Strict integer 1–100; partial/empty/out-of-range input is null. */
export function parseRolloutPercent(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,3}$/.test(trimmed)) {
    return null;
  }
  const value = Number.parseInt(trimmed, 10);
  return value >= 1 && value <= 100 ? value : null;
}

/**
 * Build the {@link UploadPolicy} from form state; null when the rollout is
 * invalid (the submit button stays disabled). Empty/whitespace release notes are
 * omitted — matching the CLI, which only sends notes when given.
 */
export function policyFromForm(form: PolicyForm): UploadPolicy | null {
  const rolloutPercentage = parseRolloutPercent(form.rolloutText);
  if (rolloutPercentage === null) {
    return null;
  }
  const policy: UploadPolicy = {
    rolloutPercentage,
    isMandatory: form.isMandatory,
    disabled: form.disabled,
    noDuplicateReleaseError: form.noDuplicateReleaseError,
  };
  if (form.releaseNotes.trim() !== "") {
    policy.releaseNotes = form.releaseNotes;
  }
  return policy;
}

/**
 * Read a dropped/selected file into an {@link Artifact}, validating the
 * descriptor. Throws ArtifactError when the bytes are not a valid `.cmpatch`.
 */
export async function readArtifactFile(file: File): Promise<Artifact> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return parseArtifact(bytes);
}

/** Human-readable byte size for the descriptor summary (e.g. "1.2 MB"). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "—";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || value % 1 === 0 ? 0 : 1)} ${units[unitIndex]}`;
}
