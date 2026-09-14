// Single source of truth for the user-facing product name in CLI prose
// (errors, prompts, help text, doctor diagnostics). Mirrors the dashboard's
// branding constant. Code tokens like `CodemagicPatchDeploymentKey`, env vars
// (`CODEMAGIC_PATCH_*`), and SDK log tags are NOT brand prose — leave them as-is.
export const PRODUCT_NAME = "Codemagic Patch";

// User-visible repository links must point at the public repo, which is where
// the docs live for everyone outside the org (the internal mirror 404s).
export const SOURCE_REPO_URL =
  "https://github.com/codemagic-ci-cd/codemagic-patch";

// The self-hosting guide, on the public repo. Deep-linked from `selfhost`
// wherever a step cannot be completed from the CLI (an unsupported Docker
// host, a deployment that is down, a value the user has to go and find).
export const SELFHOST_DOCS_URL = `${SOURCE_REPO_URL}/blob/main/docs/self-hosting-compose.md`;

// The published docs site. The production build serves the Docusaurus output
// under /docs/ (scripts/build_patch_docs_static_site.sh), so the base path
// lives here once and every page link derives from it.
export const PATCH_DOCS_SITE_URL = "https://patch.codemagic.io/docs";

// The CloudFront walkthrough on the published docs site. Opened by the
// wizard's CloudFront branch, which cannot create AWS resources itself and so
// leans on the guide for the parts that happen in the Console.
export const CLOUDFRONT_DOCS_URL = `${PATCH_DOCS_SITE_URL}/setup/cloudfront`;

// The Cloudflare guide's "enable it on an existing install" section. The
// delivery adapter is written on the first install alone, so this by-hand
// route — edit `.env.selfhost`, rerun `install.sh` — is the only way to a CDN
// afterwards, and the one thing the wizard can honestly point at when it says
// "later".
export const CLOUDFLARE_ENABLE_LATER_URL = `${PATCH_DOCS_SITE_URL}/setup/cloudflare#enable-cloudflare-on-an-existing-install`;

// The pages `cmpatch init` hands over to when the project is linked: wiring
// the SDK into the app, and publishing the first release. Both are steps the
// CLI cannot take for the user.
export const NATIVE_SETUP_DOCS_URL = `${PATCH_DOCS_SITE_URL}/setup/native-setup`;
export const FIRST_RELEASE_DOCS_URL = `${PATCH_DOCS_SITE_URL}/setup/first-release`;

// How to see the Cloudflare cache at work. Needs a published release, which
// the install summary that used to print the check inline never had.
export const CLOUDFLARE_VERIFY_DOCS_URL = `${PATCH_DOCS_SITE_URL}/setup/cloudflare#verify`;
