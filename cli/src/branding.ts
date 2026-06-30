// Single source of truth for the user-facing product name in CLI prose
// (errors, prompts, help text, doctor diagnostics). Mirrors the dashboard's
// branding constant. Code tokens like `CodemagicPatchDeploymentKey`, env vars
// (`CODEMAGIC_PATCH_*`), and SDK log tags are NOT brand prose — leave them as-is.
export const PRODUCT_NAME = "Codemagic Patch";
