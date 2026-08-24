// Single source of truth for the user-facing product name in CLI prose
// (errors, prompts, help text, doctor diagnostics). Mirrors the dashboard's
// branding constant. Code tokens like `CodemagicPatchDeploymentKey`, env vars
// (`CODEMAGIC_PATCH_*`), and SDK log tags are NOT brand prose — leave them as-is.
export const PRODUCT_NAME = "Codemagic Patch";

// User-visible repository links must point at the public repo, which is where
// the docs live for everyone outside the org (the internal mirror 404s).
export const SOURCE_REPO_URL =
  "https://github.com/codemagic-ci-cd/codemagic-patch";
