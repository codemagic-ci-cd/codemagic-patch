# Capacitor example app

An Ionic + Angular reference app for [`@codemagic/capacitor-patch`](../README.md). It
consumes the plugin by path from this repository (`"@codemagic/capacitor-patch":
"file:.."`), so it always runs the SDK sources you have checked out, and it exercises the
whole update cycle on a simulator, emulator or device: check, download, install, restart,
and crash rollback.

This is a standalone npm project — it is deliberately **not** one of the monorepo's Yarn
workspaces, so it installs with `npm` from its own `package-lock.json`.

## Prerequisites

- Node.js ≥ 22.22.3 (or ≥ 24.15 / ≥ 26 — the range the Angular CLI this app pins accepts)
  and Yarn via Corepack for the plugin build.
- A Patch server you can reach. The [local evaluation stack](../../README.md#quickstart--try-it-locally)
  is the quickest: `./scripts/local-eval/up.sh` from the root of this clone.
- The [`cmpatch-capacitor` CLI](../../cli-capacitor/README.md) —
  `npm install -g @codemagic/capacitor-patch-cli`, or
  [built from this clone](../../cli-capacitor/README.md#from-source) — signed in to that
  server.
- **iOS**: macOS with Xcode and an iOS Simulator. The iOS project uses Swift Package
  Manager, so there is no `pod install` step.
- **Android**: an Android SDK with the NDK and CMake (the plugin compiles vendored C),
  JDK 21, and a running emulator or a connected device.

## 1. Build the plugin

From the repository root:

```sh
corepack enable
yarn install
yarn workspace @codemagic/capacitor-patch build
```

The app imports the plugin's compiled output (`client-capacitor/dist/`), so rebuild after
changing the SDK's TypeScript sources. Native sources (`ios/`, `android/`, `native/`) are
compiled by Xcode and Gradle directly from the checkout and need no rebuild step.

## 2. Point the app at your server

Keep iOS and Android in **separate apps**, so each platform gets its own deployment keys —
the manifest path carries no platform segment, and a key shared by both platforms lets
their releases overwrite each other:

```sh
export CODEMAGIC_PATCH_SERVER_URL=http://localhost:3000    # your server
cmpatch-capacitor login

cmpatch-capacitor app create --name CapacitorExample-iOS        # each app is seeded with Staging + Production
cmpatch-capacitor app create --name CapacitorExample-Android
cmpatch-capacitor deployment list --app CapacitorExample-iOS       # note the Staging key
cmpatch-capacitor deployment list --app CapacitorExample-Android
```

Then, in this directory, copy the config template and fill in the two `Staging` keys:

```sh
cp patch.config.example.json patch.config.local.json
```

`patch.config.local.json` is gitignored. [`capacitor.config.ts`](capacitor.config.ts)
reads it and stops `cap sync` with an explanatory error when it is missing, incomplete, or
still carries a template placeholder. The template's URLs match
the local evaluation stack — `localhost` for the iOS Simulator, and `10.0.2.2` for the
Android emulator, which is the emulator's alias for the host's loopback interface. For any
other server, set `apiUrl` to the server's `SERVER_URL` and `downloadBaseUrl` to its
`PUBLIC_BASE_URL`. If the app on the server requires code signing, add the PEM public key
as `publicKey` to each platform block.

## 3. Run it

```sh
npm ci
npm run build          # ng build → www/
npx cap sync           # copies www/ and the plugin config into both native projects
npx cap run ios        # or: npx cap open ios
npx cap run android    # or: npx cap open android
```

Re-run `npm run build && npx cap sync` after changing the web app or
`patch.config.local.json`.

## 4. Publish an update and watch it apply

Change something visible in `src/`, rebuild, and release the new `www/` to the deployment
whose key the running platform uses. `1.0` is the binary version both native projects are
built with, which is what the release has to name to reach them.

With the alias, server and sign-in from step 2, from this directory:

```sh
npm run build
cmpatch-capacitor release create \
  --bundle-path www \
  --app CapacitorExample-iOS --deployment Staging \
  --target-binary-version 1.0
```

`npx cap sync` is not needed for a release — it only copies `www/` into the native
projects for the next native build.

In the app, **sync()** checks for, downloads and installs the release; restart the app to
boot into it. The home page shows the running package's label and hash, so you can tell
the embedded bundle from an installed update at a glance.

## Notes

- `android:usesCleartextTraffic="true"` is set in the Android manifest only so the app
  can reach the plain-HTTP local evaluation stack. Never ship that in a real app.
- `npx cap sync` rewrites `android/capacitor.settings.gradle`,
  `android/app/capacitor.build.gradle` and `ios/App/CapApp-SPM/Package.swift`. Their
  plugin paths are relative to this directory's position inside `client-capacitor/`, so
  moving the app means re-running `npx cap sync` and committing the result.
