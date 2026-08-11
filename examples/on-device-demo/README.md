# On-device demo: watch an OTA update apply

A React Native demo storefront, preconfigured against the [local evaluation stack](../../README.md#quickstart--try-it-locally). Checkout starts broken on purpose. You flip one line, publish a release, and watch the running app install the fix over the air, using the same client SDK, CLI, and server code paths as production.

By default the app checks for updates on launch and resume. With install confirmation on, it downloads in the background and shows an **Update Available** alert so you can choose **Install Now**.

## Prerequisites

- The local evaluation stack is **up**: from the repo root, run `./scripts/local-eval/up.sh`. It also installs the `cmpatch` CLI globally.
- You are signed in once: `cmpatch login --server-url http://localhost:3000` (the local stack approves the sign-in automatically).
- Node.js ≥ 22.20 and Yarn (via Corepack).
- **iOS**: macOS with Xcode and an iOS Simulator
- **Android**: an Android SDK with a running emulator, and `adb` on PATH.

## One-time setup

From this directory:

```bash
yarn install
yarn demo:setup:ios   # iOS only — installs pods (Bundler with the pinned lockfile, falling back to `pod` on PATH)
```

## Build and install the app

```bash
yarn demo:ios       # iOS Simulator
yarn demo:android   # Android emulator
```

Both build the **Release** configuration with `--no-packager` — deliberate: the app must boot from its *embedded* bundle, because that is the bundle an OTA update replaces. A debug build served by Metro would bypass the update mechanism entirely.

`demo:android` first runs `adb reverse tcp:3000 tcp:3000` and `adb reverse tcp:9100 tcp:9100`, so `localhost` inside the emulator reaches the stack's API and storage ports on your host.

On launch the app shows a fake storefront. Tap **Add to cart** on any product and you should see "Payment failed" / "Error 418: intentional bug".

## Publish an update and watch it apply

1. Edit [`App.tsx`](App.tsx) — change the marked line:

   ```ts
   const CHECKOUT_BROKEN = true;   // → false
   ```

2. Publish it as an OTA release, from this directory:

   ```bash
   # iOS
   cmpatch release-react \
     --server-url http://localhost:3000 \
     --app demo-app-ios --deployment staging \
     --platform ios

   # Android
   cmpatch release-react \
     --server-url http://localhost:3000 \
     --app demo-app-android --deployment staging \
     --platform android
   ```

3. In the running app, background it and bring it back (or relaunch). With the default settings the app checks on resume, downloads the update, and shows **Update Available**. Tap **Install Now**. The app reloads into your update: **Add to cart** now confirms the order.

The update was staged with the default `ON_NEXT_RESTART` install mode. After you confirm install, the app calls `restartApp()` so the new bundle boots.

## How it's wired

The SDK is configured by three native values, already baked into the app:

| Key | iOS (`ios/PatchDemo/Info.plist`) | Android (`android/.../values/strings.xml`) |
| --- | --- | --- |
| `CodemagicPatchApiUrl` | `http://localhost:3000` | `http://localhost:3000` |
| `CodemagicPatchDownloadBaseUrl` | `http://localhost:9100/codemagic-patch` | `http://localhost:9100/codemagic-patch` |
| `CodemagicPatchDeploymentKey` | `dev_local_ios_deployment_key` | `dev_local_android_deployment_key` |

The matching `demo-app-ios` / `demo-app-android` apps, each with a `staging` deployment, are created by the evaluation stack's [seed data](../local-dev/seed.sql). This mirrors the recommended production setup: one app per platform, so iOS and Android never share a deployment (see the [top-level README](../../README.md)). The React Native codebase itself stays a single cross-platform project — only the server-side apps are split.

## Troubleshooting

- **"Local stack unreachable — is it running?"** — the evaluation stack isn't up (or was torn down). From the repo root, run `./scripts/local-eval/up.sh` and check again.
- **Android stops finding updates after an emulator restart** — `adb reverse` mappings don't survive the emulator or adb server restarting. Re-run `yarn demo:android`, or only the two `adb reverse` commands from [`package.json`](package.json).
- **`release-react` fails with a duplicate-release error** — you published the exact same bundle twice. Change `CHECKOUT_BROKEN` (or any other code) and publish again.
- **Reset the environment** — set `CHECKOUT_BROKEN` back to `true`, uninstall the app so a previous OTA is not still active, clean the native Release outputs if needed, then from the repo root run `docker compose -f docker-compose.dev.yml down -v` and `./scripts/local-eval/up.sh`. Confirm **Add to cart** still shows the payment error before publishing again.
