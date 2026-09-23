# @codemagic/patch-cli

Command-line interface for releasing and managing over-the-air (OTA) React Native updates with [Codemagic Patch](https://github.com/codemagic-ci-cd/codemagic-patch). Provides the `cmpatch` command.

## Requirements

- Node.js `20.19+` or `22.12+`

## Install

```sh
npm install -g @codemagic/patch-cli
```

## Quick start

From your React Native project root, let the CLI connect the project to a Patch
server and create or select the platform apps and deployment:

```sh
cmpatch init

# Complete any remaining setup steps and rebuild the native app first.
# Preview, then publish an OTA release
cmpatch release-react --deployment Staging --dry-run
cmpatch release-react --deployment Staging
```

`cmpatch init` guides you to install a server or enter an existing server URL,
sign in when needed, writes the selected context to
`codemagic-patch.config.json`, and wires the SDK into the app. Rebuild and
install the native app before testing its first OTA release.

### Try the full service locally

To evaluate Patch before provisioning a server, start the full stack on your
machine:

```sh
cmpatch selfhost local-eval
```

`cmpatch selfhost local-eval` checks Docker (and offers to install or start it),
keeps its own checkout of Codemagic Patch, and starts the server, worker, Postgres, MinIO, and dashboard
on localhost. It requires `git`, `curl`, and Docker with Compose v2, and runs on
macOS, Linux, or WSL 2. Use `cmpatch selfhost local-eval status` to see the
services, checkout, and sample publish command; stop it with
`cmpatch selfhost local-eval down`.

Once the stack is ready, you can [connect your own app](https://patch.codemagic.io/docs/#5-try-it-with-your-own-app). If you want to try an OTA with a ready-made app first, run the optional demo:

```sh
cmpatch demo
```

It reuses the evaluation checkout, signs you in if needed, and builds and launches the demo app. After you see the broken product
cards, approve publishing the fix; the CLI makes the change and the app applies
it over the air automatically. No separate clone or source editing is needed.
The demo requires Node.js ≥ 22.20, Yarn via Corepack, and an iOS Simulator with
Xcode and CocoaPods or Bundler on macOS, or an Android emulator with the Android
SDK, Java, and `adb` on PATH. Follow the [Local quickstart](https://patch.codemagic.io/docs/)
for dashboard exploration or connecting your own app.

If Docker retains unusable evaluation container records, the command
automatically recreates the evaluation environment. Evaluation data may be
reset during recovery; other Docker projects are left alone.

## Commands

| Group | Description |
| --- | --- |
| `release` | Publish, inspect, patch, promote, and roll back OTA releases. |
| `management` | Manage apps, deployments, and deployment history. |
| `auth` | Authenticate, manage tokens, and manage team members. |
| `diagnostics` | Diagnose local setup and OTA readiness (`cmpatch doctor`). |
| `config` | Store defaults, wire the SDK, and inspect the effective local context. |
| `fingerprint` | Compute fingerprints and inspect device update logs. |
| `selfhost` | Run the local evaluation stack or install and maintain a self-hosted server. |

Use `cmpatch help <group>` for the commands in a group, `cmpatch help <command>` for per-command usage and examples, and `cmpatch --version` to print the CLI version.

## Output formats

Most commands accept `--format json|table`. When stdout is a terminal, output defaults to a human-readable table; when piped, it defaults to JSON, so the CLI is directly scriptable:

```sh
cmpatch app list --format json | jq '.apps[].name'
```

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Server or runtime error (not found, conflict, rate limited, …) |
| 2 | HTTP authentication refusal, usage error, or incomplete SDK wiring (`wire` / `init`) |
| 3 | Validation error, including a rejected saved credential |
| 4 | Account disabled |
| 130 | Interactive prompt aborted (Ctrl-C) |

`init` now wires the SDK by default and returns the wiring exit code even
after saving the project connection. Existing scripts that only link the
project should use `init --skip-wire` to keep connection-only behavior.
To apply wiring non-interactively, pass `--yes`; a dirty working tree also
requires `--allow-dirty`. If CocoaPods installation is needed, request it with
`--pod-install` on macOS. On Linux that step remains incomplete (exit `2`),
even with the flag, until completed on macOS.

## Configuration

- **User config:** `~/.codemagic-patch/config.json` — CLI-wide defaults such as `serverUrl`. Credentials are stored per server in `~/.codemagic-patch/credentials.json`. Set the `CODEMAGIC_PATCH_HOME` environment variable to relocate this directory.
- **Project config:** `codemagic-patch.config.json` at your project root (or a `codemagicPatch` key in `package.json`) — per-project defaults such as `app`, `deployment`, and platform-specific overrides. Created by `cmpatch init`.

Explicit flags always take precedence over configured defaults. Run `cmpatch context` to inspect the effective configuration, and `cmpatch doctor` to diagnose setup issues.

`cmpatch doctor` checks application SDK settings, server configuration, and download endpoint connectivity without requiring an existing OTA release. To additionally inspect delivery manifests and advertised bundle/patch accessibility, run:

```sh
cmpatch doctor --verify-delivery
cmpatch doctor --verify-delivery --platform ios --target-binary-version 1.2.3
```

Use `--current-package-hash <hash>` with `--verify-delivery` to simulate an OTA-active baseline. A missing primary manifest follows the fallback path. No eligible release or an explicit embedded-bundle target is reported as unverified artifact coverage, not an installation failure. Publication status alone cannot prove CDN propagation.

For a global `--app`/`--app-id` selector in a two-platform project, include `--platform ios` or `--platform android`; use `apps.ios`/`apps.android` mappings to inspect both. Explicit app IDs are verified directly without automatic team selection, while an explicitly selected team and the deployment's app membership are still checked. Authenticated control-plane redirects are reported without forwarding credentials: verify the canonical server URL and rerun with `--server-url`.

Native discovery follows a unique iOS app target's plist and source membership when an Xcode project is available. Android checks SDK values across resource XML files, separating unrelated translations from actual overrides. `--platform android --gradle-file <module>/build.gradle` selects a custom module's adjacent source tree. JS source checks follow bounded local imports and re-exports separately for each platform.

A passing resource/source check does not certify the final build. When Patch resource settings are resolved without conflicts, an unevaluated external Gradle build is shown as information and does not prevent setup checks from passing. External Gradle scripts, dynamic Expo configuration, unresolved Xcode configuration, custom JS aliases, and external package entries can still require additional inspection. Doctor does not execute these configurations or run prebuild automatically.

JSON output includes separate `coverage.setup` and `coverage.delivery` results. Exit code 0 means no confirmed diagnostic failure; inspect coverage for incomplete verification. Accessibility checks do not verify file integrity, signatures, installation, or behavior on a device. Default doctor is read-only and does not publish releases. The optional configuration fix below is the only write it supports.

### Optional doctor configuration fix

`cmpatch doctor --fix --server-url https://patch.example.com` can offer to create a missing `codemagic-patch.config.json` with that explicit URL after a successful readiness check. The prompt shows the file and value; existing files and package-level server settings are preserved. This saves the CLI server default, not native SDK settings. Diagnostics run again after applying.

Use `--fix --yes` to apply this limited fix without prompting in CI or JSON mode. Without `--yes`, noninteractive runs report the proposal without writing. Plain `doctor` remains read-only. Native integration edits, login, dependencies, prebuild and publication remain manual actions.

## Install with external storage

`cmpatch selfhost install` offers bundled MinIO (default), Cloudflare R2 when
API DNS uses Cloudflare, Amazon S3, and Google Cloud Storage. External storage
uses separate public and private buckets. Choose automatic new-resource setup
or guided console setup; existing complete runtime settings skip provisioning.

```sh
cmpatch selfhost install user@vps --storage-mode s3
cmpatch selfhost install user@vps --storage-mode gcs --storage-setup guided
```

S3/GCS need accounts that permit public artifact reads; GCS also needs a usable
service-account key. AWS profiles/gcloud accounts are selected explicitly.
Disposable setup credentials are separate from runtime credentials and cleaned
up best effort. Failed setup prints resources and a guided reuse command; it
never rolls back cloud resources. Read/write, public download, privacy and
selected CDN cache/purge probes run before deployment. A signed-in release smoke
check and actual device use remain separate checks.

CloudFront and S3/GCS Cloudflare Cloud Connector (Beta) are guided console
walkthroughs. See [external storage setup](../docs/self-hosting-compose.md#external-storage-in-the-install-wizard)
for prerequisites, unattended flags, cleanup and credential replacement.

## License

[Apache-2.0](./LICENSE)
