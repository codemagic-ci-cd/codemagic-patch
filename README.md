# Codemagic Patch

Codemagic Patch is a **self-hosted over-the-air (OTA) update service for React Native apps**. Ship JavaScript/asset updates straight to installed apps — no app-store review for changes that live in your JS bundle.

This monorepo contains everything you need to run the service yourself and wire it into an app:

- a **server** (control plane + release worker),
- a **React Native client SDK** (`@codemagic/patch-client`) with an Expo config plugin,
- a **CLI** (`cmpatch`) for publishing and managing releases,
- a **web dashboard**, and
- a one-command **Docker Compose self-host** stack.

---

## Table of contents

1. [How it works](#how-it-works)
2. [Core concepts](#core-concepts)
3. [Repository layout](#repository-layout)
4. [Requirements](#requirements)
5. [Part 1 — Run the server (self-host)](#part-1--run-the-server-self-host)
6. [Part 2 — Install the CLI and sign in](#part-2--install-the-cli-and-sign-in)
7. [Part 3 — Create apps & deployments](#part-3--create-apps--deployments)
8. [Part 4 — Connect your React Native app](#part-4--connect-your-react-native-app)
9. [Part 5 — Publish your first release](#part-5--publish-your-first-release)
10. [Managing releases](#managing-releases)
11. [Code signing (optional)](#code-signing-optional)
12. [How delivery works](#how-delivery-works)
13. [Operations](#operations)
14. [Configuration reference](#configuration-reference)
15. [CLI command reference](#cli-command-reference)
16. [Troubleshooting](#troubleshooting)

---

## How it works

```
  Developer / CI                Self-host server                 Installed app
 ┌──────────────┐   release    ┌──────────────────┐   manifest  ┌──────────────┐
 │   cmpatch    │ ───────────► │  API + worker    │ ◄────────── │  patch-client│
 │  release-... │   upload     │  (Fastify)       │   download  │   SDK (RN)   │
 └──────────────┘              │  Postgres + S3   │ ──────────► │  swaps bundle│
                               └──────────────────┘   artifacts └──────────────┘
                                        ▲
                                        │ HTTPS, TLS, dashboard
                                   ┌────┴────┐
                                   │  Caddy  │
                                   └─────────┘
```

1. You publish a release with the CLI. The server bundles your JS, computes a native **fingerprint** and a target **binary version**, then stores the artifact and a manifest in object storage.
2. On launch (or resume), the SDK fetches the manifest for its deployment + binary version, downloads the new bundle (or a smaller **binary patch** when available), and swaps it in on the next restart.
3. The SDK reports download/install/success/failure metrics back to the server.

The default self-host stack runs four services on a single Docker host:

| Service        | Role                                                                          |
| -------------- | ----------------------------------------------------------------------------- |
| **Caddy**      | HTTPS/TLS (Let's Encrypt), API reverse proxy, dashboard, storage-domain proxy |
| **Server**     | API + release worker in one process (`MODE=all`)                              |
| **PostgreSQL** | Control-plane data: apps, deployments, releases, IAM, metrics                 |
| **MinIO**      | S3-compatible object storage for public artifacts and internal uploads        |

---

## Core concepts

| Concept            | What it is                                                                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **App**            | A logical application. **Use a separate app per platform** (e.g. `MyApp-iOS`, `MyApp-Android`).                                                            |
| **Deployment**     | A release channel inside an app. Every app is created with **`Staging`** and **`Production`**.                                                             |
| **Deployment key** | The public identifier the SDK uses to fetch updates. Found via `cmpatch deployment list`. **Not a secret** — it's baked into the app binary.               |
| **Release**        | A published bundle targeting one deployment + binary version. Identified by a label like `v1`. Supports gradual rollout, mandatory updates, and rollback.  |
| **Binary version** | The native app version a release targets (e.g. `1.2.3`). The SDK only installs releases that match the running binary version.                             |
| **Fingerprint**    | A hash of the native project. Guards against shipping a JS bundle to an incompatible native binary.                                                        |

> **⚠️ Always use separate deployment keys for iOS and Android.** The manifest path does not include the platform, so reusing one key across both platforms (with the same binary version) lets releases overwrite each other.

---

## Repository layout

| Path               | Package                   | Description                                                          |
| ------------------ | ------------------------- | ------------------------------------------------------------------- |
| `server/`          | `@codemagic/patch-server` | Fastify API + release/manifest worker                               |
| `client/`          | `@codemagic/patch-client` | React Native SDK + Expo config plugin (`app.plugin.js`)             |
| `cli/`             | `codemagic-patch`         | The `cmpatch` CLI                                                    |
| `web-dashboard/`   | `web-dashboard`           | React SPA dashboard (served by Caddy)                               |
| `shared/`          | `@codemagic/patch-shared` | Types and helpers shared across packages                            |
| `deploy/selfhost/` | —                         | Caddyfile, MinIO bucket policy, dashboard image build               |
| `scripts/selfhost/`| —                         | `install.sh`, `backup.sh`, `restore.sh`, `upgrade.sh`, `smoke.sh`   |
| `examples/`        | —                         | Local-dev seed data and bundle fixtures                             |

---

## Requirements

**Server host**

- Docker + Docker Compose v2, and `curl`
- Public inbound access on ports **80** and **443**
- **Two domains** with DNS A/AAAA records pointing at the host — one for the API/dashboard, one for artifact storage. They must differ:
  - API/dashboard — e.g. `updates.example.com`
  - Storage — e.g. `storage.updates.example.com`
- A **GitHub OAuth App** (see below)

**Building / using the CLI (local or CI)**

- Node.js `>=22.20.0`
- Yarn `4.12.0` (via Corepack)

**React Native app**

- React Native `>=0.76`, React `>=18`

---

## Part 1 — Run the server (self-host)

### 1.1 Prepare a GitHub OAuth App

Sign-in (both the CLI device flow and the dashboard) is backed by GitHub OAuth. Create **one** OAuth App and collect:

| Setting                       | Value                                       |
| ----------------------------- | ------------------------------------------- |
| Homepage URL                  | `https://updates.example.com`               |
| Authorization callback URL    | `https://updates.example.com/auth/callback` |
| **Enable Device Flow**        | ✅ required for `cmpatch login`             |
| Client ID                     | e.g. `Iv1.xxxxxxxxxxxxxxxx`                  |
| Client Secret                 | generated on the same app                   |

> The first admin's email (`--email` below) **must exactly match the verified primary email** on their GitHub account. The default registration mode is `invite_only`, so the very first sign-in is rejected if it doesn't match.

### 1.2 Install

Clone the repo onto the server and run the installer:

```bash
git clone <this-repository-url> codemagic-patch
cd codemagic-patch

scripts/selfhost/install.sh \
  --api-domain updates.example.com \
  --storage-domain storage.updates.example.com \
  --email admin@example.com \
  --github-oauth-client-id Iv1.xxxxxxxxxxxxxxxx \
  --github-oauth-client-secret <github_client_secret>
```

The installer:

- writes `.env.selfhost` with **strong random secrets** for Postgres, MinIO, the worker, and OAuth (it refuses to overwrite an existing file),
- builds the server and Caddy (dashboard) images,
- starts the Compose stack under project name `codemagic-patch-selfhost`,
- waits for Caddy to obtain Let's Encrypt certificates (1–2 min) by polling `/health` and storage health, and
- prepares the single fixed **`default-team`** on first boot.

When it finishes you'll have:

```text
Dashboard:      https://updates.example.com/
API URL:        https://updates.example.com           (app config: CodemagicPatchApiUrl)
Download base:  https://storage.updates.example.com/codemagic-patch   (app config: CodemagicPatchDownloadBaseUrl)
```

> 🔐 **`.env.selfhost` holds production secrets.** Back it up and never commit or expose it.

### 1.3 Verify

```bash
curl -fsS https://updates.example.com/health
curl -fsS https://storage.updates.example.com/minio/health/ready

# Unauthenticated smoke test
scripts/selfhost/smoke.sh

# After you create an API token (Part 2), run the full publish smoke test
CODEMAGIC_PATCH_TOKEN=cm_pat_xxx scripts/selfhost/smoke.sh
```

### 1.4 (Optional) Put Cloudflare in front of storage

By default clients download directly from the storage domain (`DELIVERY_ADAPTER=base-url`). To front storage with Cloudflare and have the server purge the edge cache after each release, add these flags at install time:

```bash
scripts/selfhost/install.sh \
  --api-domain updates.example.com \
  --storage-domain storage.updates.example.com \
  --email admin@example.com \
  --github-oauth-client-id Iv1.xxxxxxxxxxxxxxxx \
  --github-oauth-client-secret <github_client_secret> \
  --cloudflare \
  --cloudflare-api-token <cf_cache_purge_token> \
  --cloudflare-zone-id <cf_zone_id>
```

The token needs **Zone → Cache Purge** permission. Keep the storage domain **DNS-only** until Caddy issues the certificate, then switch it to **proxied**.

---

## Part 2 — Install the CLI and sign in

You can do everything from the dashboard, but CI and scripting use the CLI. Install it globally from this repo:

```bash
corepack enable
yarn install
yarn cli:install-global   # builds and installs the `cmpatch` binary globally
```

Store defaults so you can omit `--server-url`/`--team` on every command:

```bash
cmpatch --version
cmpatch config set server-url https://updates.example.com
cmpatch config set team default-team
```

Sign in as the admin (completes a GitHub device-code approval in your browser):

```bash
cmpatch login --server-url https://updates.example.com
```

Mint a token for CI:

```bash
cmpatch token create --name ci
```

The `cm_pat_...` value is shown **once**. Store it as a CI secret and supply it via the `CODEMAGIC_PATCH_TOKEN` env var or `--token`.

> **Auth precedence:** `--token` → `CODEMAGIC_PATCH_TOKEN` → the credential saved by `cmpatch login` (stored in `~/.codemagic-patch/`).

---

## Part 3 — Create apps & deployments

Keep iOS and Android in **separate apps**:

```bash
cmpatch app create --name MyApp-iOS
cmpatch app create --name MyApp-Android

cmpatch deployment list --app MyApp-iOS --format table
cmpatch deployment list --app MyApp-Android --format table
```

`app create` automatically creates the **`Staging`** and **`Production`** deployments. The `DEPLOYMENT_KEY` column from `deployment list` is the value your app embeds (`CodemagicPatchDeploymentKey`). The same operations are available in the dashboard at `https://updates.example.com/`.

---

## Part 4 — Connect your React Native app

Add the SDK:

```bash
yarn add @codemagic/patch-client
```

The SDK is configured through four native values (injected at build time):

| App config key                  | Value                                                  |
| ------------------------------- | ------------------------------------------------------ |
| `CodemagicPatchDeploymentKey`   | the deployment key from `cmpatch deployment list`      |
| `CodemagicPatchDownloadBaseUrl` | your **Download base** URL (ends with `/codemagic-patch`) |
| `CodemagicPatchApiUrl`          | your **API** URL                                        |
| `CodemagicPatchPublicKey`       | *(optional)* PEM public key for code-signing enforcement |

### Option A — Expo (prebuild)

Add the config plugin to `app.json` / `app.config.js`:

```json
{
  "expo": {
    "plugins": [
      [
        "@codemagic/patch-client/app.plugin.js",
        {
          "ios": {
            "deploymentKey": "ios-staging-deployment-key",
            "downloadBaseUrl": "https://storage.updates.example.com/codemagic-patch",
            "apiUrl": "https://updates.example.com"
          },
          "android": {
            "deploymentKey": "android-staging-deployment-key",
            "downloadBaseUrl": "https://storage.updates.example.com/codemagic-patch",
            "apiUrl": "https://updates.example.com"
          }
        }
      ]
    ]
  }
}
```

Then regenerate native projects:

```bash
npx expo prebuild
cd ios && pod install && cd ..
```

The plugin injects the config keys (iOS `Info.plist`, Android `strings.xml`) **and** wires native bundle selection for you:

- **iOS** AppDelegate → prefers `CodemagicPatch.bundleURL()`, falling back to the embedded bundle.
- **Android** MainApplication → prefers `CodemagicPatch.getJSBundleFile(applicationContext)`.

### Option B — Bare React Native

Wire the same things manually. The Expo plugin sources are the reference implementation:

**iOS**

- Add `CodemagicPatchDeploymentKey`, `CodemagicPatchDownloadBaseUrl`, `CodemagicPatchApiUrl` to `Info.plist`.
- In your AppDelegate, prefer the OTA bundle before the embedded fallback:
  ```swift
  import CodemagicPatchClient
  // ...
  CodemagicPatch.bundleURL() ?? Bundle.main.url(forResource: "main", withExtension: "jsbundle")
  ```
  Reference: `client/plugin/src/withIosBundleURL.ts`

**Android**

- Add the same keys to `android/app/src/main/res/values/strings.xml`.
- In `MainApplication.kt`, make `getJSBundleFile()` (or `getDefaultReactHost(..., jsBundleFilePath = ...)`) use the SDK:
  ```kotlin
  import io.codemagic.patch.CodemagicPatch
  // ...
  override fun getJSBundleFile(): String? = CodemagicPatch.getJSBundleFile(applicationContext)
  ```
  Reference: `client/plugin/src/withAndroidBundleFile.ts`

### Run updates in app code

The simplest integration is a single `sync()` call after startup. `sync()` runs `notifyAppReady()`, the update check, download, and install in order.

```ts
import { useEffect } from "react";
import { sync } from "@codemagic/patch-client";

export function useCodemagicPatch() {
  useEffect(() => {
    void sync(
      {
        installMode: "ON_NEXT_RESTART",
        mandatoryInstallMode: "IMMEDIATE",
      },
      (progress) => {
        console.log("OTA download", progress.receivedBytes, "/", progress.totalBytes);
      },
    );
  }, []);
}
```

**Install modes:** `IMMEDIATE` · `ON_NEXT_RESTART` *(default)* · `ON_NEXT_RESUME` · `ON_NEXT_SUSPEND`

**`SyncOptions`:** `{ installMode?, mandatoryInstallMode?, minimumBackgroundDuration? }` — `sync()` resolves to a status such as `"up-to-date"`, `"update-installed"`, `"embedded-revert-applied"`, `"sync-in-progress"`, or `"error"`.

For manual control, the SDK also exports `checkForUpdate()`, `downloadUpdate()`, `installUpdate()`, `notifyAppReady()`, `restartApp()`, `allowRestart()`, and `disallowRestart()`.

---

## Part 5 — Publish your first release

From your React Native project root, create the CLI context once:

```bash
cmpatch init \
  --server-url https://updates.example.com \
  --ios-app MyApp-iOS \
  --android-app MyApp-Android \
  --deployment Staging \
  --yes
```

This writes `codemagic-patch.config.json` so later commands can omit `--server-url`/`--app`. Inspect the resolved context:

```bash
cmpatch context
```

Dry-run, then publish:

```bash
# Preview without uploading
cmpatch release-react --platform ios --deployment Staging --dry-run
cmpatch release-react --platform android --deployment Staging --dry-run

# Publish
cmpatch release-react --platform ios     --deployment Staging --release-notes "Fix onboarding crash" --yes
cmpatch release-react --platform android --deployment Staging --release-notes "Fix onboarding crash" --yes
```

`release-react` analyzes the project, auto-detects the bundler (Metro or Expo), computes the target binary version + native fingerprint, builds the bundle, and uploads it. If auto-detection can't determine a value, pass it explicitly:

```bash
cmpatch release-react \
  --platform ios \
  --deployment Staging \
  --target-binary-version 1.2.3 \
  --bundler metro \
  --entry-file index.js \
  --yes
```

Watch processing complete:

```bash
cmpatch release list --app MyApp-iOS --deployment Staging --format table
cmpatch release inspect --app MyApp-iOS --deployment Staging --label v1 --wait
```

> 💡 `cmpatch bundle --platform ios` builds a `.cmpatch` artifact **without** uploading — useful for inspecting or publishing later via `cmpatch release create --bundle-path file.cmpatch`.

---

## Managing releases

> The examples below run from a project root where `cmpatch init` has written `codemagic-patch.config.json`. Name-based commands (like `promote`) also need a default team — set it once with `cmpatch config set team default-team` or pass `--team default-team`.

**Gradual rollout**

```bash
cmpatch release-react --platform ios --deployment Production \
  --rollout-percentage 10 --release-notes "Gradual rollout" --yes
```

**Mandatory update**

```bash
cmpatch release-react --platform ios --deployment Production --mandatory --yes
```

**Disable / re-enable a release**

```bash
cmpatch release disable --app MyApp-iOS --deployment Production --label v3 --yes
cmpatch release enable  --app MyApp-iOS --deployment Production --label v3 --yes
```

**Roll back** to the previous release

```bash
cmpatch release rollback --app MyApp-iOS --deployment Production --yes
```

**Promote** a tested release from Staging to Production

```bash
cmpatch release promote \
  --app MyApp-iOS \
  --source-deployment Staging \
  --dest-deployment Production \
  --label v4 \
  --yes
```

**Metrics**

```bash
cmpatch deployment metrics --app MyApp-iOS --deployment Production --format table
cmpatch release metrics    --app MyApp-iOS --deployment Production --label v4 --format table
```

The client posts `Downloaded` / `Installed` / `Success` / `Failed` / `Active` events to `<apiUrl>/v1/metrics/events`. Metrics failures never block the update flow — the SDK queues and retries them natively.

---

## Code signing (optional)

Require signed releases at app creation, or enable it later:

```bash
cmpatch app create  --name MySignedApp-iOS --require-code-signing
cmpatch app setting --app MyApp-iOS --require-code-signing=true
```

When publishing a signed app, sign the package-hash JWT with your private key:

```bash
cmpatch release-react --platform ios --deployment Staging \
  --private-key-path ./patch-private-key.pem --yes
```

To enforce verification on-device, embed the matching public key (`CodemagicPatchPublicKey`). In Expo plugin config:

```json
{
  "deploymentKey": "ios-staging-deployment-key",
  "downloadBaseUrl": "https://storage.updates.example.com/codemagic-patch",
  "apiUrl": "https://updates.example.com",
  "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
}
```

With a `publicKey` configured, the client **rejects** any release whose manifest signature is missing or doesn't match.

---

## How delivery works

The SDK reads these objects under your **Download base** URL:

```text
<downloadBaseUrl>/<deploymentKey>/meta.json
<downloadBaseUrl>/<deploymentKey>/<binaryVersion>/manifest.json
<downloadBaseUrl>/<deploymentKey>/<binaryVersion>/<runningPackageHash>/manifest.json
```

- The manifest carries the full bundle URL and, when available, a **binary patch** URL. The SDK prefers the smaller patch and automatically falls back to the full bundle if the patch download or apply fails.
- Bundle file names: iOS `main.jsbundle`, Android `index.android.bundle`.
- The MinIO bucket (`codemagic-patch`) allows public reads of published artifacts but **denies** public reads under the `_internal/*` prefix (staged uploads).

---

## Operations

All maintenance commands run against the `codemagic-patch-selfhost` Compose project.

**Status & logs**

```bash
docker compose --project-name codemagic-patch-selfhost --env-file .env.selfhost \
  -f docker-compose.selfhost.yml ps

docker compose --project-name codemagic-patch-selfhost --env-file .env.selfhost \
  -f docker-compose.selfhost.yml logs -f server
```

**Backup** (quiesces the server, dumps Postgres, mirrors the MinIO bucket)

```bash
scripts/selfhost/backup.sh
# → backups/codemagic-patch-selfhost-<timestamp>/ : env.selfhost, postgres.dump,
#   minio-codemagic-patch.tar.gz, versions.txt
```

**Restore**

```bash
scripts/selfhost/restore.sh backups/codemagic-patch-selfhost-<timestamp>
# also replace .env.selfhost from the backup:
scripts/selfhost/restore.sh --restore-env backups/codemagic-patch-selfhost-<timestamp>
```

Restore always takes a pre-restore safety backup first (unless `--skip-safety-backup`).

**Upgrade** (backs up, updates server + Caddy images, then smoke-tests)

```bash
scripts/selfhost/upgrade.sh
# pin a specific server image:
scripts/selfhost/upgrade.sh --image registry.example.com/codemagic-patch-server:tag
```

---

## Configuration reference

`.env.selfhost` is generated by `scripts/selfhost/install.sh`. See `.env.selfhost.example` for the fully annotated list. Edit it by hand only if you're not using the installer, then restart the stack with the same `--project-name`.

**Required**

| Variable                          | Description                                                              |
| --------------------------------- | ------------------------------------------------------------------------ |
| `CODEMAGIC_PATCH_API_DOMAIN`      | API/dashboard domain (no scheme/path)                                    |
| `CODEMAGIC_PATCH_STORAGE_DOMAIN`  | Storage domain (must differ from the API domain)                         |
| `ACME_EMAIL`                      | Email for Let's Encrypt certificates                                     |
| `SERVER_URL`                      | Public API URL, e.g. `https://updates.example.com`                       |
| `PUBLIC_BASE_URL`                 | Public artifact base, default `https://<storage-domain>/codemagic-patch` |
| `POSTGRES_DB` / `_USER` / `_PASSWORD` | PostgreSQL credentials                                              |
| `MINIO_ROOT_USER` / `_PASSWORD`   | MinIO credentials                                                        |
| `WORKER_SHARED_SECRET`            | Protects worker routes (**≥ 32 chars**)                                  |
| `GITHUB_OAUTH_CLIENT_ID`          | GitHub OAuth App client ID                                               |
| `GITHUB_OAUTH_CLIENT_SECRET`      | GitHub OAuth App client secret                                           |
| `OAUTH_DEVICE_POLL_TOKEN_SECRET`  | Local random secret (**≥ 32 chars**)                                     |
| `INITIAL_ADMIN_EMAILS`            | Allowlist for the first invite-only admin sign-in                        |

> The server **refuses to boot** while `WORKER_SHARED_SECRET` or `OAUTH_DEVICE_POLL_TOKEN_SECRET` are shorter than 32 chars, or if GitHub OAuth is unset — so a verbatim copy of the example file fails fast instead of running with known secrets.

**Common optional**

| Variable                  | Default                          | Description                                       |
| ------------------------- | -------------------------------- | ------------------------------------------------- |
| `MODE`                    | `all`                            | `all` · `api` · `worker`                          |
| `REGISTRATION_MODE`       | `invite_only`                    | `invite_only` or `open`                           |
| `STORAGE_ADAPTER`         | `s3` (self-host)                 | `s3` · `gcs` · `memory`                           |
| `DELIVERY_ADAPTER`        | `base-url`                       | `base-url` or `cloudflare` (+ `CLOUDFLARE_*`)     |
| `MANIFEST_CACHE_CONTROL`  | `no-cache, must-revalidate`      | Cache-Control header for manifests                |
| `MAX_UPLOAD_SIZE`         | `200mb`                          | Max artifact upload size                          |
| `RUN_MIGRATIONS`          | `true`                           | Run DB migrations on boot                         |
| `LOGGER`                  | `true`                           | Set `false` to silence server logs                |

---

## CLI command reference

Run `cmpatch help` for grouped topics, or `cmpatch <command> --help` for full flags. Both `cmpatch` and `codemagic-patch` invoke the same binary.

**Auth & config**

| Command                                    | Description                                   |
| ------------------------------------------ | --------------------------------------------- |
| `cmpatch login` / `logout` / `whoami`      | GitHub device-flow sign-in / out / identity   |
| `cmpatch token create \| list \| revoke`   | Manage personal access tokens (`cm_pat_…`)    |
| `cmpatch config list \| get \| set \| unset` | Store defaults: `server-url`, `team`, `team-id` |
| `cmpatch init`                             | Write `codemagic-patch.config.json` for a project |
| `cmpatch context`                          | Show the effective resolved context           |

**Apps & deployments**

| Command                                                   | Description                              |
| --------------------------------------------------------- | ---------------------------------------- |
| `cmpatch app create \| list \| show \| rename \| remove \| setting` | Manage apps (and code-signing)  |
| `cmpatch deployment create \| list \| rename \| remove \| clear` | Manage deployments                |
| `cmpatch deployment history \| metrics`                   | Release history / aggregate metrics      |

**Releases**

| Command                                       | Description                                     |
| --------------------------------------------- | ----------------------------------------------- |
| `cmpatch release-react`                       | Build **and** publish from an RN project        |
| `cmpatch bundle`                              | Build a `.cmpatch` artifact without uploading   |
| `cmpatch release create`                      | Publish a pre-built bundle / `.cmpatch`         |
| `cmpatch release list \| show \| inspect`     | Browse releases; `inspect --wait` to poll       |
| `cmpatch release patch \| enable \| disable`  | Edit metadata / toggle availability             |
| `cmpatch release promote`                     | Copy a release to another deployment            |
| `cmpatch release rollback`                    | Revert to the previous release                  |
| `cmpatch release metrics`                     | Metrics for one release                         |

**Members & diagnostics**

| Command                                                      | Description                                  |
| ----------------------------------------------------------- | -------------------------------------------- |
| `cmpatch member add \| invite \| provision \| list \| remove …` | Team membership and invitations          |
| `cmpatch doctor`                                            | Check local readiness before publishing      |
| `cmpatch fingerprint --platform ios\|android`               | Compute the native fingerprint               |

List/metrics commands accept `--format table|json`.

---

## Troubleshooting

**Server won't boot / OAuth errors**

- `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET` are set.
- `OAUTH_DEVICE_POLL_TOKEN_SECRET` and `WORKER_SHARED_SECRET` are each ≥ 32 chars.
- Under `REGISTRATION_MODE=invite_only`, `INITIAL_ADMIN_EMAILS` is non-empty.

**First admin sign-in rejected**

- `INITIAL_ADMIN_EMAILS` matches the GitHub account's **verified primary** email.
- The OAuth App callback URL is `https://<api-domain>/auth/callback` and **Device Flow** is enabled.

**Caddy certificate issuance is slow**

- API/storage DNS records point at the host; ports 80/443 are open.
- With Cloudflare, keep the storage domain **DNS-only** until the first certificate is issued.

**Release published but the app finds no update**

- The app's embedded `CodemagicPatchDeploymentKey` matches the key from `cmpatch deployment list`.
- The app's binary version matches the release's target binary version.
- `CodemagicPatchDownloadBaseUrl` ends with `/codemagic-patch`.
- iOS and Android use **separate** deployment keys.

**Release stuck processing**

```bash
cmpatch release inspect --app MyApp-iOS --deployment Staging --label <label> --wait
docker compose --project-name codemagic-patch-selfhost --env-file .env.selfhost \
  -f docker-compose.selfhost.yml logs --tail=200 server
```

**Check local readiness before publishing**

```bash
cmpatch doctor --app MyApp-iOS --deployment Staging --verbose
```
