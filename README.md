# Codemagic Patch

[![Discord](https://img.shields.io/discord/1131597315707261018?logo=discord&label=Discord)](https://codemagic.io/discord/) &nbsp; [![npm](https://img.shields.io/npm/v/@codemagic/react-native-patch)](https://www.npmjs.com/package/@codemagic/react-native-patch) &nbsp; [![npm downloads](https://img.shields.io/npm/dm/@codemagic/react-native-patch)](https://www.npmjs.com/package/@codemagic/react-native-patch) &nbsp; [![GitHub Stars](https://img.shields.io/github/stars/codemagic-ci-cd/codemagic-patch)](https://github.com/codemagic-ci-cd/codemagic-patch) &nbsp; [![Follow @codemagicio](https://img.shields.io/twitter/follow/codemagicio?style=social)](https://x.com/codemagicio) &nbsp; [![LinkedIn](https://img.shields.io/badge/Follow%20on%20LinkedIn-0A66C2?logo=linkedin&logoColor=white)](https://www.linkedin.com/company/16170400)

Codemagic Patch is a **self-hosted over-the-air (OTA) update service for React Native apps**. Ship JavaScript/asset updates straight to installed apps — no app-store review for changes that live in your JS bundle.

This monorepo contains everything you need to run the service yourself and wire it into an app:

- a **server** (control plane + release worker),
- a **React Native client SDK** (`@codemagic/react-native-patch`) with an Expo config plugin,
- a **CLI** (`cmpatch`) for publishing and managing releases,
- a **web dashboard**, and
- a one-command **Docker Compose self-host** stack.

---

## Quickstart — try it locally

Evaluate the full service on your machine before provisioning domains or OAuth: the **local evaluation stack** runs the real server, worker, Postgres, MinIO, and dashboard, with sign-in replaced by a local one-click login. The only prerequisites are **Docker (with Compose v2)** and **Node.js ≥ 22** (for the CLI).

```bash
git clone https://github.com/codemagic-ci-cd/codemagic-patch.git
cd codemagic-patch
./scripts/local-eval/up.sh
```

The script brings up the stack, installs the `cmpatch` CLI globally, seeds a demo app, and prints a ready banner:

- **Dashboard** — <http://localhost:8080> (sign in with the prefilled one-click local login)
- **API** — <http://localhost:3000>
- A seeded **demo app** and API token

To see an update **apply on a running app** (iOS simulator / Android emulator), continue with the [on-device demo](examples/on-device-demo).

The evaluation stack is defined in `docker-compose.dev.yml` (not the self-host compose file). Tear everything down with:

```bash
docker compose -f docker-compose.dev.yml down -v
```

> ⚠️ **Evaluation only — not a deployment.** Authentication is disabled and all ports bind to localhost. For a production deployment, follow [Part 1 — Run the server (self-host)](#part-1--run-the-server-self-host).

---

## Table of contents

**Getting started**

1. [Quickstart — try it locally](#quickstart--try-it-locally)
2. [How it works](#how-it-works)
3. [Core concepts](#core-concepts)
4. [Requirements](#requirements)

**Production setup**

5. [Part 1 — Run the server (self-host)](#part-1--run-the-server-self-host)
6. [Part 2 — Install the CLI and sign in](#part-2--install-the-cli-and-sign-in)
7. [Part 3 — Create apps & deployments](#part-3--create-apps--deployments)
8. [Part 4 — Connect your React Native app](#part-4--connect-your-react-native-app)
9. [Part 5 — Publish your first release](#part-5--publish-your-first-release)

**Release management & operations**

10. [Managing releases](#managing-releases)
11. [Code signing (optional)](#code-signing-optional)
12. [Operations](#operations)
13. [Troubleshooting](#troubleshooting)

**Reference**

14. [How delivery works](#how-delivery-works)
15. [Configuration reference](#configuration-reference)
16. [CLI command reference](#cli-command-reference)
17. [Repository layout](#repository-layout)

---

## How it works

```
  Developer / CI                Self-host server                 Installed app
 ┌──────────────┐   release    ┌──────────────────┐   manifest  ┌──────────────┐
 │   cmpatch    │ ───────────► │  API + worker    │ ◄────────── │ react-native │
 │  release-... │   upload     │  (Fastify)       │   download  │  -patch SDK  │
 └──────────────┘              │  Postgres + S3   │ ──────────► │  swaps bundle│
                               └──────────────────┘   artifacts └──────────────┘
                                        ▲
                                        │ HTTPS, TLS, dashboard
                                   ┌────┴────┐
                                   │  Caddy  │
                                   └─────────┘
```

1. You publish a release with the CLI. It bundles your JS, computes a native **fingerprint**, resolves a target **binary version**, and uploads the bundle to the server, which stores the artifact and a manifest in object storage.
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

## Requirements

> These requirements apply to a production self-host deployment. The local [Quickstart](#quickstart--try-it-locally) requires only Docker and Node.js.

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

### 1.2 (Optional but recommended) Prepare Cloudflare in front of storage

By default clients download directly from the storage domain (`DELIVERY_ADAPTER=base-url`). For production deployments we recommend fronting the **storage domain** (only — the API domain stays direct) with Cloudflare: artifacts and manifests are then served from the edge, and after every release, promotion, rollback, and deployment clear the server purges the affected `meta.json`/`manifest.json` URLs so clients don't see stale manifests. Deleting a deployment also purges its public artifact URLs.

To prepare, collect two values:

- The storage domain must live in a Cloudflare zone. Copy the **Zone ID** from the *API* section of the zone's **Overview** page.
- Create an **API Token** at **My Profile → API Tokens** (user-owned) or **\<account\> → Manage Account → API Tokens** (account-owned, `cfat_…`). Use *Create Custom Token* with the single permission **Zone → Cache Purge → Purge**, and restrict *Zone Resources* to the zone containing the storage domain.

You pass both values to the installer in the next step, then finish the Cloudflare-side setup (DNS proxying and Cache Rules) in [§1.5](#15-finish-the-cloudflare-setup) once the stack is up.

### 1.3 Install

Clone the repo onto the server and run the installer:

```bash
git clone https://github.com/codemagic-ci-cd/codemagic-patch.git
cd codemagic-patch

scripts/selfhost/install.sh \
  --api-domain updates.example.com \
  --storage-domain storage.updates.example.com \
  --email admin@example.com \
  --github-oauth-client-id Iv1.xxxxxxxxxxxxxxxx \
  --github-oauth-client-secret <github_client_secret>
```

If you prepared Cloudflare in §1.2, add these flags to the same command:

```bash
  --cloudflare \
  --cloudflare-api-token <cf_cache_purge_token> \
  --cloudflare-zone-id <cf_zone_id>
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

### 1.4 Verify

```bash
curl -fsS https://updates.example.com/health
curl -fsS https://storage.updates.example.com/minio/health/ready

# Unauthenticated smoke test
scripts/selfhost/smoke.sh

# After you create an API token (Part 2), run the full publish smoke test
CODEMAGIC_PATCH_TOKEN=cm_pat_xxx scripts/selfhost/smoke.sh
```

### 1.5 Finish the Cloudflare setup

If you installed with the Cloudflare flags (§1.2–1.3), the server side is already active — releases request edge purges.

#### 1. Switch the DNS record to proxied

1. Keep the storage domain **DNS-only** (grey cloud) until the installer reports storage HTTPS as ready — Caddy needs to obtain its Let's Encrypt certificate first.
2. Switch the storage record to **Proxied** (orange cloud).
3. Set the zone's **SSL/TLS mode to Full (strict)**. The origin serves a valid Let's Encrypt certificate, so strict validation works; *Flexible* would connect to the origin over HTTP, which Caddy redirects back to HTTPS and can cause a redirect loop.

If a later certificate renewal fails while proxied, temporarily switch the record back to DNS-only, let Caddy renew, then re-enable the proxy.

#### 2. Add Cache Rules

Create two rules under **\<zone\> → Caching → Cache Rules** to make the storage-domain policy explicit and cache the manifests, in this order (when several rules match, the later one wins):

| # | Rule expression | Cache eligibility | Edge TTL |
| - | --------------- | ----------------- | -------- |
| 1 | `http.host eq "storage.updates.example.com"` | Eligible for cache | *Use cache-control header if present, bypass cache if not* |
| 2 | `http.host eq "storage.updates.example.com" and ends_with(http.request.uri.path, ".json")` | Eligible for cache | *Ignore cache-control header and use this TTL*: **2 hours** |

Rule 1 lets Cloudflare honor the artifacts' origin headers — bundles and patches are content-addressed and served with `Cache-Control: public, max-age=31536000, immutable`, so they remain fresh for up to one year without revalidation (although Cloudflare may evict an inactive object earlier). Rule 2 overrides the manifests' `no-cache` so `meta.json`/`manifest.json` are cached at the edge; the server automatically requests a purge for those URLs after releases, and the 2-hour TTL bounds staleness in the rare case a purge attempt fails. Two hours is the minimum Edge TTL on Cloudflare Free; Pro and higher plans may use 1 hour instead. Leave `MANIFEST_CACHE_CONTROL` at its default — it governs client revalidation, while the Cache Rule governs the edge.

#### 3. Verify

```bash
# Second request should return "cf-cache-status: HIT"
DEPLOYMENT_KEY=your-deployment-key
URL="https://storage.updates.example.com/codemagic-patch/${DEPLOYMENT_KEY}/meta.json"

curl -sI "$URL" | grep -i cf-cache-status
curl -sI "$URL" | grep -i cf-cache-status
```

After publishing a release, a successful purge makes the same URL briefly report `MISS` again. Purging is **best-effort**: a failed purge never fails the release — it is logged as a `delivery cache purge completed with failures` warning in the server logs, so watch for that warning if clients report stale updates.

#### Enabling Cloudflare on an existing install

Rerunning the installer with `--cloudflare` flags does **not** change an existing install — delivery configuration is only written on initial install, and the rerun prints a warning instead. To enable it later, edit `.env.selfhost`:

```bash
DELIVERY_ADAPTER=cloudflare
CLOUDFLARE_API_TOKEN=<cf_cache_purge_token>
CLOUDFLARE_ZONE_ID=<cf_zone_id>
```

Then rerun `scripts/selfhost/install.sh` — it re-reads the file, verifies the credentials, and restarts the stack. Finish with steps 1–3 above.

---

## Part 2 — Install the CLI and sign in

You can do everything from the dashboard, but CI and scripting use the CLI. The CLI is built from this repo (only the app SDK `@codemagic/react-native-patch` is on npm). Install it globally:

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

Create an API token for CI:

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
yarn add @codemagic/react-native-patch
```

The SDK is configured through four native values (injected at build time):

| App config key                  | Value                                                  |
| ------------------------------- | ------------------------------------------------------ |
| `CodemagicPatchDeploymentKey`   | the deployment key from `cmpatch deployment list`      |
| `CodemagicPatchDownloadBaseUrl` | your **Download base** URL (ends with `/codemagic-patch`) |
| `CodemagicPatchApiUrl`          | your **API** URL                                        |
| `CodemagicPatchPublicKey`       | *(optional)* PEM public key for code-signing enforcement |

> The snippets below use placeholder values (`ios-staging-deployment-key`, `https://updates.example.com`, …) — substitute your own deployment keys and URLs from Parts 1 and 3.

### Option A — Bare React Native

Wire the config and native bundle selection manually.

**iOS**

- Add `CodemagicPatchDeploymentKey`, `CodemagicPatchDownloadBaseUrl`, `CodemagicPatchApiUrl` to `ios/<YourApp>/Info.plist`:
  ```xml
  <key>CodemagicPatchDeploymentKey</key>
  <string>ios-staging-deployment-key</string>
  <key>CodemagicPatchDownloadBaseUrl</key>
  <string>https://storage.updates.example.com/codemagic-patch</string>
  <key>CodemagicPatchApiUrl</key>
  <string>https://updates.example.com</string>
  <!-- optional, only when enforcing code signing -->
  <key>CodemagicPatchPublicKey</key>
  <string>-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----</string>
  ```
- In your AppDelegate, prefer the OTA bundle before the embedded fallback:
  ```swift
  import CodemagicPatchClient
  // ...
  CodemagicPatch.bundleURL() ?? Bundle.main.url(forResource: "main", withExtension: "jsbundle")
  ```
  Reference: `client/plugin/src/withIosBundleURL.ts`

**Android**

- Add the same keys to `android/app/src/main/res/values/strings.xml`:
  ```xml
  <resources>
    <string name="CodemagicPatchDeploymentKey" translatable="false">android-staging-deployment-key</string>
    <string name="CodemagicPatchDownloadBaseUrl" translatable="false">https://storage.updates.example.com/codemagic-patch</string>
    <string name="CodemagicPatchApiUrl" translatable="false">https://updates.example.com</string>
    <!-- optional, only when enforcing code signing -->
    <string name="CodemagicPatchPublicKey" translatable="false">-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----</string>
  </resources>
  ```
- In `MainApplication.kt`, make `getJSBundleFile()` (or `getDefaultReactHost(..., jsBundleFilePath = ...)`) use the SDK:
  ```kotlin
  import io.codemagic.patch.CodemagicPatch
  // ...
  override fun getJSBundleFile(): String? = CodemagicPatch.getJSBundleFile(applicationContext)
  ```
  Reference: `client/plugin/src/withAndroidBundleFile.ts`

### Option B — Expo (prebuild)

Add the config plugin to `app.json` / `app.config.js`:

```json
{
  "expo": {
    "plugins": [
      [
        "@codemagic/react-native-patch",
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

The plugin injects the config keys (iOS `Info.plist`, Android `strings.xml`) **and** wires native bundle selection for you — the same wiring shown in Option A:

- **iOS** AppDelegate → prefers `CodemagicPatch.bundleURL()`, falling back to the embedded bundle.
- **Android** MainApplication → prefers `CodemagicPatch.getJSBundleFile(applicationContext)`.

### Run updates in app code

#### What `sync()` does

`sync()` is the one call most apps need. On each invocation it runs the whole update flow in order:

1. **`notifyAppReady()`** — marks the currently running bundle as healthy. This is the SDK's **rollback protection**: if a freshly installed bundle crashes *before* `sync()` (and therefore `notifyAppReady()`) runs, the next launch automatically reverts to the last known-good bundle. Because `sync()` calls it first, simply running `sync()` on every startup confirms the previous update and arms rollback for the next one — you don't have to call it yourself.
2. **Check** the server for an update matching this app's deployment key + binary version.
3. **Download** the new bundle (or a smaller binary **patch**, with automatic fallback to the full bundle).
4. **Install** it according to the chosen *install mode* (see below).

`sync()` **never throws** — it always resolves to a `SyncStatus` string, so you can branch on the result instead of wrapping it in `try/catch`.

#### Step 1 — Minimal integration (drop-in)

Call `sync()` once, as early as possible after your root component mounts. This is enough to get OTA updates working end to end.

```tsx
// App.tsx
import { useEffect } from "react";
import { sync } from "@codemagic/react-native-patch";

export default function App() {
  useEffect(() => {
    // Fire-and-forget: sync() handles its own errors and resolves to a status.
    void sync();
  }, []);

  return <YourApp />;
}
```

With no options, non-mandatory updates install on the **next app restart** and mandatory updates install **immediately**. The user gets the new bundle the next time they cold-start the app.

#### Step 2 — Choose how updates apply (install modes)

The **install mode** controls *when* a downloaded bundle becomes active. Mandatory releases (published with `--mandatory`) use `mandatoryInstallMode`; everything else uses `installMode`.

| Install mode        | When the new bundle becomes active                                                            |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `ON_NEXT_RESTART`   | On the next cold start *(default for non-mandatory)*. Least disruptive.                        |
| `ON_NEXT_RESUME`    | When the app returns to the foreground after being backgrounded for `minimumBackgroundDuration`. |
| `ON_NEXT_SUSPEND`   | When the app goes to the background (after `minimumBackgroundDuration`).                       |
| `IMMEDIATE`         | Right away — the JS bundle reloads as soon as install finishes *(default for mandatory)*.      |

```ts
void sync({
  installMode: "ON_NEXT_RESTART",   // optional updates: wait for a natural restart
  mandatoryInstallMode: "IMMEDIATE", // forced updates: reload now
  minimumBackgroundDuration: 60_000, // for ON_NEXT_RESUME/SUSPEND, in ms
});
```

> Re-running `sync()` when the app returns to the foreground catches updates published while the user had the app open. Wire it to `AppState`:
>
> ```ts
> import { AppState } from "react-native";
> import { sync } from "@codemagic/react-native-patch";
>
> AppState.addEventListener("change", (next) => {
>   if (next === "active") void sync();
> });
> ```

#### Step 3 — React to the result and show progress

`sync()` resolves to one of: `"up-to-date"`, `"update-installed"`, `"embedded-revert-applied"`, `"sync-in-progress"`, or `"error"`. The optional second argument is a progress callback (`{ receivedBytes, totalBytes }`) you can use to drive a UI.

```tsx
import { useEffect, useState } from "react";
import { sync, type SyncStatus } from "@codemagic/react-native-patch";

export function useOtaUpdate() {
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<SyncStatus>();

  useEffect(() => {
    void (async () => {
      const result = await sync(
        { installMode: "ON_NEXT_RESTART", mandatoryInstallMode: "IMMEDIATE" },
        ({ receivedBytes, totalBytes }) => {
          setProgress(totalBytes > 0 ? receivedBytes / totalBytes : 0);
        },
      );

      setStatus(result);

      switch (result) {
        case "update-installed":
          // Downloaded and staged. For ON_NEXT_RESTART it applies on the next launch.
          break;
        case "up-to-date":
        case "embedded-revert-applied":
        case "sync-in-progress":
          break;
        case "error":
          // Safe to ignore — the app keeps running the current bundle.
          break;
      }
    })();
  }, []);

  return { progress, status };
}
```

#### Step 4 — Manual control (advanced)

If you need to separate the steps — e.g. download silently but let the user decide when to restart, or gate updates behind a "What's new" prompt — use the lower-level functions instead of `sync()`:

```ts
import {
  checkForUpdate,
  downloadUpdate,
  installUpdate,
  notifyAppReady,
  restartApp,
  disallowRestart,
  allowRestart,
} from "@codemagic/react-native-patch";

// 1) Confirm the running bundle is healthy (arms rollback). Call this once on
//    startup if you are NOT using sync(), e.g. after your app finishes booting.
await notifyAppReady();

// 2) Check, then download with progress.
const check = await checkForUpdate();
if (check.action === "ota-update") {
  const local = await downloadUpdate(check.remotePackage, (p) =>
    console.log(p.receivedBytes, "/", p.totalBytes),
  );

  // 3) Install. With IMMEDIATE the bundle reloads now; with ON_NEXT_RESTART it
  //    waits for the next launch.
  await installUpdate(local, { installMode: "ON_NEXT_RESTART" });

  // 4) Optionally force a reload yourself (e.g. after the user taps "Update now").
  await restartApp(/* onlyIfUpdateIsPending */ true);
}

// Suppress restarts during a critical flow (checkout, video call, …), then re-enable.
disallowRestart();
// … later …
allowRestart();
```

> **If you do not use `sync()`, you must call `notifyAppReady()` yourself** once the app has booted successfully. Otherwise the SDK treats the new bundle as unverified and rolls it back on the next launch.

#### API summary

| Function | Purpose |
| --- | --- |
| `sync(options?, onProgress?)` | End-to-end: confirm → check → download → install. Returns a `SyncStatus`; never throws. |
| `checkForUpdate()` | Returns `{ action: "up-to-date" \| "ota-update" \| "embedded-revert", remotePackage? }`. |
| `downloadUpdate(remotePackage, onProgress?)` | Downloads (patch or full bundle) and returns a `LocalPackage`. |
| `installUpdate(target, options?)` | Stages/applies a downloaded package using an `installMode`. |
| `notifyAppReady()` | Confirms the running bundle as good (rollback protection). |
| `restartApp(onlyIfUpdateIsPending?)` | Reloads the JS bundle to apply a pending update. |
| `disallowRestart()` / `allowRestart()` | Block / unblock SDK-triggered restarts during critical flows. |

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
| `DELIVERY_ADAPTER`        | `base-url`                       | `base-url` or `cloudflare` (see §1.2 and §1.5)    |
| `CLOUDFLARE_API_TOKEN`    | —                                | Token scoped to Zone → Cache Purge (required with `cloudflare`) |
| `CLOUDFLARE_ZONE_ID`      | —                                | Zone containing the storage domain (required with `cloudflare`) |
| `CLOUDFLARE_API_BASE_URL` | `https://api.cloudflare.com/client/v4` | Cloudflare API endpoint override           |
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

## Repository layout

| Path               | Package                   | Description                                                          |
| ------------------ | ------------------------- | ------------------------------------------------------------------- |
| `server/`          | `@codemagic/patch-server` | Fastify API + release/manifest worker                               |
| `client/`          | `@codemagic/react-native-patch` | React Native SDK + Expo config plugin (`app.plugin.js`)             |
| `cli/`             | `codemagic-patch`         | The `cmpatch` CLI                                                    |
| `web-dashboard/`   | `web-dashboard`           | React SPA dashboard (served by Caddy)                               |
| `shared/`          | `@codemagic/patch-shared` | Types and helpers shared across packages                            |
| `deploy/selfhost/` | —                         | Caddyfile, MinIO bucket policy, dashboard image build               |
| `scripts/selfhost/`| —                         | `install.sh`, `backup.sh`, `restore.sh`, `upgrade.sh`, `smoke.sh`   |
| `scripts/local-eval/` | —                      | Local evaluation stack bootstrap (`up.sh`) and its smoke checks     |
| `examples/`        | —                         | Evaluation-stack seed data, bundle fixtures, and the [on-device demo app](examples/on-device-demo/README.md) |


## Feedback

Your feedback helps us improve Codemagic Patch. We'd love to hear what's working well, what's been challenging, and what features or improvements you'd like to see.

You can share your thoughts in any of the following ways:

💬 Start a discussion in [GitHub Discussions](https://github.com/codemagic-ci-cd/codemagic-patch/discussions)
📅 Book a [feedback call](https://calendly.com/zach-codemagic/30min)
📧 Send an email to: zach@codemagic.io

We appreciate your time and look forward to hearing from you!
