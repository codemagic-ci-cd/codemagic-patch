# On-device demo — watch an OTA update apply

A minimal React Native app, preconfigured against the [local evaluation stack](../../README.md#quickstart--try-it-locally), built for a single purpose: making an OTA update visible. It fills the screen with a version banner (**v1**, blue). You change one line, publish a release, relaunch — and the banner flips to **v2**, green. That flip is Codemagic Patch replacing the app's JS bundle, using the same client SDK, CLI, and server code paths as production.

The app uses the SDK's manual flow (`checkForUpdate` → `downloadUpdate` → `installUpdate`) so you can see each phase on screen — checking, download progress, installed — instead of it all happening silently inside `sync()`.

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

## Build and install the app (v1)

```bash
yarn demo:ios       # iOS Simulator
yarn demo:android   # Android emulator
```

Both build the **Release** configuration with `--no-packager` — deliberate: the app must boot from its *embedded* bundle, because that is the bundle an OTA update replaces. A debug build served by Metro would bypass the update mechanism entirely.

`demo:android` first runs `adb reverse tcp:3000 tcp:3000` and `adb reverse tcp:9100 tcp:9100`, so `localhost` inside the emulator reaches the stack's API and storage ports on your host.

On launch the app shows the blue **v1** banner and, after a moment, *"Up to date — you are running v1."*

## Publish an update and watch it apply

1. Edit [`App.tsx`](App.tsx) — change the marked line:

   ```ts
   const APP_VERSION = 'v1';   // → 'v2'
   ```

2. Publish it as an OTA release, from this directory:

   ```bash
   # iOS
   cmpatch release-react \
     --server-url http://localhost:3000 \
     --app demo-app --deployment staging-ios \
     --platform ios

   # Android
   cmpatch release-react \
     --server-url http://localhost:3000 \
     --app demo-app --deployment staging-android \
     --platform android
   ```

3. In the app, tap **Check again**. It finds the release, shows download progress, then offers **Update installed — Relaunch**. Tap it: the banner flips to the green **v2**.

The update was staged with the default `ON_NEXT_RESTART` install mode, so a manual cold start (or the Relaunch button, which calls `restartApp()`) is what boots the new bundle.

## How it's wired

The SDK is configured by three native values, already baked into the app:

| Key | iOS (`ios/PatchDemo/Info.plist`) | Android (`android/.../values/strings.xml`) |
| --- | --- | --- |
| `CodemagicPatchApiUrl` | `http://localhost:3000` | `http://localhost:3000` |
| `CodemagicPatchDownloadBaseUrl` | `http://localhost:9100/codemagic-patch` | `http://localhost:9100/codemagic-patch` |
| `CodemagicPatchDeploymentKey` | `dev_local_ios_deployment_key` | `dev_local_android_deployment_key` |

The matching `staging-ios` / `staging-android` deployments (and the `demo-app` app) are created by the evaluation stack's [seed data](../local-dev/seed.sql).

## Troubleshooting

- **"Local stack unreachable — is it running?"** — the evaluation stack isn't up (or was torn down). From the repo root, run `./scripts/local-eval/up.sh` and check again.
- **Android stops finding updates after an emulator restart** — `adb reverse` mappings don't survive the emulator or adb server restarting. Re-run `yarn demo:android`, or only the two `adb reverse` commands from [`package.json`](package.json).
- **`release-react` fails with a duplicate-release error** — you published the exact same bundle twice. Change `APP_VERSION` (or any other code) and publish again.
- **Reset the environment** — from the repo root, run `docker compose -f docker-compose.dev.yml down -v`, then `./scripts/local-eval/up.sh`; the seed recreates the app, deployments, and token.
