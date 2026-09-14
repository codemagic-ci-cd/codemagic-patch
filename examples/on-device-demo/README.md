# On-device demo: watch an OTA update apply

A React Native demo storefront, preconfigured against the [local evaluation stack](../../README.md#quickstart--try-it-locally). The product cards fail to load on purpose. The guided command fixes one line, publishes a release after your confirmation, and lets you watch the running app install the fix over the air, using the same client SDK, CLI, and server code paths as production.

The guided path is `cmpatch demo` once the evaluation stack is up. It checks the demo prerequisites before sign-in or installation and reports missing tools together. It builds this app, waits until you have seen the catalog error, shows the one-line fix it will make automatically, publishes the fix without rebuilding or reinstalling the native app, then automatically backgrounds and returns to the same app to check for the update. On iOS, Settings briefly appears; on Android, the Home screen appears. The app downloads and applies the update automatically, then reloads with working product cards. If automatic switching fails, the CLI guides you through switching manually. The manual walkthrough below is optional.

By default the app checks for updates on launch and resume. It downloads and installs updates without a confirmation alert, then reloads automatically. To try the optional confirmation flow, set `INSTALL_CONFIRMATION` to `true` in `App.tsx`.

## Prerequisites

- The local evaluation stack is **up**: `cmpatch selfhost local-eval` (install the CLI with `npm install -g @codemagic/patch-cli`), or `./scripts/local-eval/up.sh` from your own clone.
- Node.js ≥ 22.20 and Yarn (via Corepack).
- **iOS**: macOS with Xcode, an iOS Simulator, and CocoaPods or the Bundler version required by `Gemfile.lock`
- **Android**: an Android SDK with a running emulator, Java, and `adb` on PATH.

The guided command chooses a booted iPhone simulator when available, otherwise an available iPhone. On Android it prefers a connected emulator; set `ANDROID_SERIAL` to choose a particular connected device. The selected device is used throughout the walkthrough.

## Guided walkthrough

```bash
cmpatch demo
```

The command handles sign-in, dependency installation, building, and the source change. No separate clone is needed after `cmpatch selfhost local-eval`. If you used your own clone to start the stack, run the demo from inside it or pass `--checkout /path/to/codemagic-patch`. Use `--platform ios` or `--platform android` to choose explicitly.

After the app reloads, confirm that the product cards load and **Add to cart** works. Accept the CLI's offer to open the release in the dashboard. To continue with your own project, keep the stack running and follow [Try it with your own app](https://patch.codemagic.io/docs/#5-try-it-with-your-own-app).

## Manual walkthrough (optional)

Use these steps only if you want to run each stage yourself. Work from an editable repository clone, in `examples/on-device-demo`, and sign in with `cmpatch login --server-url http://localhost:3000`.

### One-time setup

From this directory:

```bash
yarn install
yarn demo:setup:ios   # iOS only — installs pods (Bundler with the pinned lockfile, falling back to `pod` on PATH)
```

### Build and install the app

```bash
yarn demo:ios       # iOS Simulator
yarn demo:android   # Android emulator
```

Both ship a Release binary that boots from its embedded bundle, because that is the bundle an OTA update replaces. A debug build served by Metro would bypass the update mechanism entirely. `demo:ios` compiles first, then opens Simulator.app to install; the simulator is not needed for the compile.

`demo:android` uses `--no-packager` and first runs `adb reverse tcp:3000 tcp:3000` and `adb reverse tcp:9100 tcp:9100`, so `localhost` inside the emulator reaches the stack's API and storage ports on your host.

On launch the app shows a storefront whose product cards fail to load ("Couldn't load product" / "Invalid product response"). The catalog response is `{ products: [...] }`, but the app treats the whole response as the product array. The response is a local fixture so the walkthrough does not depend on an external catalog API.

### Publish an update and watch it apply

1. Edit [`App.tsx`](App.tsx) — change the marked line:

   ```diff
   - const products = response;
   + const products = response.products;
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

3. In the running app, background it and bring it back (or relaunch). With the default settings the app checks on resume, downloads the update, and installs it automatically. The app reloads into your update: the product cards load, and **Add to cart** confirms the order.

The update was staged with the default `ON_NEXT_RESTART` install mode. After installation completes, the app calls `restartApp()` automatically so the new bundle boots.

## How it's wired

The SDK is configured by three native values, already baked into the app:

| Key | iOS (`ios/PatchDemo/Info.plist`) | Android (`android/.../values/strings.xml`) |
| --- | --- | --- |
| `CodemagicPatchApiUrl` | `http://localhost:3000` | `http://localhost:3000` |
| `CodemagicPatchDownloadBaseUrl` | `http://localhost:9100/codemagic-patch` | `http://localhost:9100/codemagic-patch` |
| `CodemagicPatchDeploymentKey` | `dev_local_ios_deployment_key` | `dev_local_android_deployment_key` |

The matching `demo-app-ios` / `demo-app-android` apps, each with a `staging` deployment, are created by the evaluation stack's [seed data](../local-dev/seed.sql). This mirrors the recommended production setup: one app per platform, so iOS and Android never share a deployment (see the [top-level README](../../README.md)). The React Native codebase itself stays a single cross-platform project — only the server-side apps are split.

## Troubleshooting

- **"Local stack unreachable — is it running?"** — the evaluation stack isn't up (or was torn down). Run `cmpatch selfhost local-eval` (or `./scripts/local-eval/up.sh` from the repo root of a clone) and check again.
- **Android stops finding updates after an emulator restart** — `adb reverse` mappings don't survive the emulator or adb server restarting. Re-run `yarn demo:android`, or only the two `adb reverse` commands from [`package.json`](package.json).
- **`release-react` fails with a duplicate-release error** — you published the exact same bundle twice. Change the catalog lookup (or any other code) and publish again.
- **Reset the environment** — restore `const products = response;`, uninstall the app so a previous OTA is not still active, clean the native Release outputs if needed, then run `cmpatch selfhost local-eval down --delete-data` and `cmpatch selfhost local-eval` (from a clone: `docker compose -f docker-compose.dev.yml down -v` and `./scripts/local-eval/up.sh` at the repo root). Confirm the product cards still show the load error before publishing again.
