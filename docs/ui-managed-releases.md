# Build once, ship from anywhere: `.cmpatch` releases

This guide walks through building an over-the-air update as a self-describing
**`.cmpatch`** artifact and shipping it either by **dragging it onto the web
dashboard** or with a single CLI command. The build step needs no control-plane
access or credentials, and both upload paths send the same request — so you can
build on CI and let a teammate release from the browser without installing
anything.

## What is a `.cmpatch`?

A `.cmpatch` file is a zip container holding everything intrinsic to one build:

- `cmpatch.json` — the descriptor: platform, target binary version, fingerprint,
  the package hash, the (optional) code signature, baked-in policy defaults, and
  build provenance.
- `bundle.zip` — the release payload, carried **verbatim** so its package hash
  and signature stay valid.
- the sourcemap, when one was produced.

The deployment it targets is **not** baked in, and the policy values above are
baked in only as **defaults** — the effective policy (rollout %, mandatory,
disabled, release notes) is chosen at upload time, so one artifact can go to
any deployment.

## Step 1 — Build the artifact

```sh
cmpatch bundle --platform ios --target-binary-version 1.2.0
```

This bundles your app with no control-plane API and no token — the only network
access is a best-effort, unauthenticated fetch of base bytecode from the public
delivery origin, which degrades quietly offline and can be turned off with
`--base-bytecode off` — and writes `<project>.<platform>.cmpatch` in the
current directory. Useful flags:

- `--output <file.cmpatch>` — choose the output path.
- `--private-key-path <pem>` — code-sign the bundle; the signature travels inside
  the artifact and the private key never leaves your machine.
- `--sourcemap-output <path>` — include a sourcemap.
- `--rollout-percentage`, `--mandatory`, `--disabled`, `--release-notes`,
  `--no-duplicate-release-error` — **seed** the upload policy. These become the
  defaults the upload form/flags start from; they are always overridable later.
- `--bundler auto|metro|expo`, `--entry-file`, `--hermes`, `--extra-hermes-flag`
  — bundling controls, mirroring `release-react`.

The package hash and (if you signed) the signature are computed here, so the
artifact is tamper-evident from this point on.

## Step 2a — Upload from the web dashboard

1. Open the deployment you want to ship to.
2. Click **New release** (in the header, or in the centre of an empty release
   history). It requires the `release.deploy` role (developer or above).
3. The dialog first asks how to release — **Via CLI** (shows a pre-filled CLI
   command instead) or **Bundle upload**; pick **Bundle upload**.
4. Drag the `.cmpatch` onto the drop zone, or click to pick it.
5. Review the descriptor the dashboard reads back — platform, target version,
   fingerprint, whether it is code-signed, bundle size, and how it was built.
6. Edit the policy if needed (rollout %, release notes, mandatory, create
   disabled, ignore duplicate-release error). It starts from the artifact's
   baked-in defaults.
7. Click **Upload release**. You're taken to the new release as its worker job
   runs.

If the deployment already contains this exact content, the server flags a
duplicate; an **Upload anyway** button re-submits and records it deliberately.

## Step 2b — Upload from the CLI

```sh
cmpatch release create \
  --bundle-path ./my-app.ios.cmpatch \
  --server-url https://<your-server> \
  --deployment-id <id> \
  --yes
```

Target the deployment with `--deployment-id`, or with `--app <name>
--deployment <name>`. The CLI must be authenticated — a stored `cmpatch login`
session, `--token cm_pat_...`, or the `CODEMAGIC_PATCH_TOKEN` environment
variable. `--yes` skips the interactive confirmation; in a terminal you can
drop it and confirm at the prompt, but CI/non-TTY runs fail without it. Point
`--bundle-path` at the `.cmpatch`. The build identity
— fingerprint, target binary version, signature, sourcemap — is read from the
descriptor, so you don't repeat them: `--target-binary-version`, `--fingerprint`,
`--private-key-path`, and `--sourcemap` are rejected with a `.cmpatch` to avoid a
mismatch, and `--platform` is ignored (the descriptor's platform is
authoritative). You can still set upload-time policy:
`--rollout-percentage`, `--mandatory`, `--disabled`, `--release-notes`,
`--no-duplicate-release-error`; anything you omit falls back to the artifact's
baked-in defaults. Add `--dry-run` to preview without uploading.

Before anything is sent, the CLI recomputes the bundle's package hash and checks
it against the descriptor, failing fast if the artifact was corrupted.

## How trust works

- The **server** treats the signature as opaque — it only checks that one is
  present when the app requires code signing.
- The **device** verifies the signature against the bundle when it applies the
  update.
- The **CLI** does the fail-fast package-hash check before upload. The
  dashboard only parses the descriptor; a corrupted artifact dropped in the
  browser is caught by the server's authoritative re-hash instead.

Because both upload paths build the identical multipart request the CLI has
always sent, no server-side change is involved in any of this.
