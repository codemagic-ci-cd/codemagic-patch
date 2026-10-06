# `@codemagic/capacitor-patch`

Capacitor client SDK for [Codemagic Patch](https://github.com/codemagic-ci-cd/codemagic-patch) —
over-the-air web-asset updates for Capacitor, Ionic and Cordova-on-Capacitor apps.

This package is only the on-device side. You also need a Patch server (self-hosted) and
the [`cmpatch-capacitor` CLI](../cli-capacitor/README.md), which sets up apps and
deployments, publishes releases and operates them — the [monorepo](../README.md) has
both, plus a dashboard and a local evaluation stack. The React Native counterpart of this
SDK is [`@codemagic/react-native-patch`](../client/README.md).

> **Status: 0.x.** The package is on npm, but its API may still change between
> minor versions. See [Installation](#installation).

## Why this exists

Codemagic Patch's server, CLI and delivery protocol are framework-agnostic by design —
[`PROTOCOL.md`](../PROTOCOL.md) states plainly that "the server and client treat the
payload as an opaque directory tree." A Capacitor payload is exactly that: a directory of
web assets.

Capacitor also happens to be the easiest OTA target of any framework. `@capacitor/core`
ships the entire install mechanism (`WebView.setServerBasePath`, `getServerBasePath`,
`persistServerBasePath`), so applying an update means pointing the WebView at a
directory. There is no bundler to integrate, no bytecode, and no New Architecture matrix.

## How it relates to the rest of Patch

- **Same server.** The server needs no Capacitor-specific changes; this client speaks
  the published protocol against an unmodified deployment, and the dashboard shows a
  Capacitor app like any other.
- **Its own CLI.** [`cmpatch-capacitor`](../cli-capacitor/README.md) covers OTA operation
  from the command line — sign-in, apps, deployments, releases, promotion, rollback,
  metrics — and publishes the built web assets as they are, without analysing a native
  project. It computes no native
  fingerprint, so the native app version is what scopes a release — read
  [its note on that](../cli-capacitor/README.md#the-binary-version-is-the-compatibility-boundary)
  before your first release.
- **Same protocol.** No new manifest format, no new hashing scheme, no new wire
  contract. The delivery-protocol layer ([`src/protocol/`](src/protocol/README.md)) is a
  port of the React Native client's, and the native hashing, archive extraction and
  delta patching come from the same C libraries the React Native client vendors.
- **Not a CodePush plugin.** This targets the Patch protocol, not the retired CodePush
  one.

## What you get

- Binary patches when available, for smaller downloads (falls back once to a full
  bundle on any patch failure or hash mismatch)
- Signature verification when you configure a public key (RS256, skipped rather than
  silently passed when no key is configured)
- Automatic crash-loop rollback if a new package fails before the app reports ready,
  after a configurable number of launches (`maxLaunchAttempts`, default 3)
- Configuration via `capacitor.config.ts`, with a native-resource override for CI
- A one-call `start()` that checks on launch and, optionally, on every return to the
  foreground; CodePush-style `sync()`; or step-by-step APIs when you need control
- All four install modes: on next restart, immediately, on next resume, or while in the
  background

## Requirements

- Capacitor `7.0.0` or `8.x` — see [Support policy](#support-policy) below
- Android `minSdkVersion` 24+
- Android native build with CMake/NDK support (for the vendored C — package hashing,
  archive extraction, delta patching)
- iOS native build with either Swift Package Manager or CocoaPods, and mixed
  Swift/Objective-C++ compilation

### Support policy

The two most recent Capacitor majors are supported; the oldest is dropped once a new
major ships (currently 7 and 8 — CI runs the full suite against both). This tracks
Capacitor's own release cadence rather than a fixed calendar window.

## Installation

```sh
npm install @codemagic/capacitor-patch
npx cap sync
```

To try an unreleased build instead, build it from a clone of this repository and install
it by path:

```sh
# in your clone of this repository
corepack enable && yarn install
yarn workspace @codemagic/capacitor-patch build

# in your Capacitor app
npm install /path/to/codemagic-patch/client-capacitor
npx cap sync
```

`cap sync` copies the plugin into both native projects and regenerates their
dependency manifests (CocoaPods `Podfile`/SPM package list on iOS, Gradle module list
on Android) — no separate `pod install` step, unlike a bare React Native install.

## Quick start

Configuration lives in `capacitor.config.ts`, one block per platform:

```ts
// capacitor.config.ts
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.example.app',
  appName: 'Example',
  webDir: 'www',
  plugins: {
    CodemagicPatch: {
      ios: {
        deploymentKey: '<ios-deployment-key>',
        apiUrl: 'https://updates.example.com',
        downloadBaseUrl: 'https://storage.example.com/codemagic-patch',
        // publicKey: '-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----',
      },
      android: {
        deploymentKey: '<android-deployment-key>',
        apiUrl: 'https://updates.example.com',
        downloadBaseUrl: 'https://storage.example.com/codemagic-patch',
        // publicKey: '-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----',
      },
    },
  },
};

export default config;
```

Then run `npx cap sync` so both native projects pick up the change. See
[Configuration](#configuration) for where each value comes from and what each one means.

Call `start()` once your app has rendered its first screen:

```ts
import { CheckFrequency, start } from '@codemagic/capacitor-patch';

start({ checkFrequency: CheckFrequency.ON_APP_RESUME });
```

`start()` checks for an update, downloads and installs it when appropriate, and reports
the running bundle as healthy so a bad package can roll back. With
`CheckFrequency.ON_APP_RESUME` it checks again each time the app returns to the
foreground; the default, `ON_APP_START`, checks once. It is this SDK's counterpart of
the React Native SDK's `Patch.wrap(App)`, and takes the same options. It never throws,
and resolves to the first check's status (`'up-to-date'`, `'update-installed'`,
`'embedded-revert-applied'`, `'sync-in-progress'` or `'error'`).

**Call it after the first screen renders, not earlier in bootstrap.** Starting is what
marks the running bundle as healthy. If your app crashes before that point, the update
is rolled back after `maxLaunchAttempts` launches; if you call `start()` before your UI
has actually come up, a crash after that point no longer counts. See [Usage](#usage) for
the step-by-step APIs when you need more control.

## Configuration

| Key | Required | Meaning |
| --- | --- | --- |
| `deploymentKey` | yes | Deployment key for this app/platform/track. **Use a separate key per platform** — the manifest path carries no platform segment, so a shared key lets releases overwrite each other |
| `apiUrl` | yes | API server origin (the server's `SERVER_URL`), e.g. `https://updates.example.com`. The SDK appends `/v1/...` |
| `downloadBaseUrl` | yes | Artifact origin (the server's `PUBLIC_BASE_URL`), e.g. `https://storage.example.com/codemagic-patch`. May include a bucket/path prefix; the SDK appends manifest/artifact paths |
| `publicKey` | no | PEM public key (SPKI, `-----BEGIN PUBLIC KEY-----`); required only when enforcing client-side signature verification |
| `maxLaunchAttempts` | no | How many consecutive launches a newly installed update may boot without `notifyAppReady()` before it is rolled back as a crash. Positive integer, default `3`. An invalid value logs a warning and uses the default rather than blocking boot |

Each platform block is independent — configure at least one, and every block you
provide needs `deploymentKey`, `apiUrl`, and `downloadBaseUrl` (`publicKey` and
`maxLaunchAttempts` are optional). **Where the values come from:** the deployment key is the `DEPLOYMENT KEY`
column of `cmpatch-capacitor deployment list --app <app-name>` (or the
deployment's page in the dashboard); the API URL and download base URL are printed by
the self-host installer when the server is set up.

**Native resource override.** For teams injecting per-environment values in CI without
rewriting `capacitor.config.ts`, the same values can be set as native resources
instead — `CodemagicPatchDeploymentKey`/`CodemagicPatchApiUrl`/
`CodemagicPatchDownloadBaseUrl`/`CodemagicPatchPublicKey`/
`CodemagicPatchMaxLaunchAttempts` in Android `strings.xml` or iOS `Info.plist` (the same
names the React Native SDK reads). Precedence: **native resource >
`capacitor.config.ts`**.

**Catching config mistakes before they ship:** run
`npx codemagic-patch-check-config path/to/capacitor.config.json` in CI. It fails if both
platform blocks resolve to the same `deploymentKey` (the exact mistake the protocol
cautions against), or if a `maxLaunchAttempts` is not a positive integer, which the app
itself would only warn about at runtime. It reads JSON only: with a `capacitor.config.ts`, run it after
`npx cap sync` and point it at the resolved copy that writes, such as
`android/app/src/main/assets/capacitor.config.json`.

## Usage

The simplest integration is `start()` (see [Quick start](#quick-start)). Underneath it
is `sync()`, which checks for an update, downloads it, installs it and reports app
readiness in one call; call it yourself to check at moments of your own choosing
(`start()` can still run alongside, and overlapping calls resolve to
`'sync-in-progress'` rather than a second update cycle). Neither throws; both resolve to
a status string.

For finer control, drive the steps yourself and call `notifyAppReady()` once the app
has started successfully (so the update is not rolled back):

```ts
import {
  checkForUpdate,
  downloadUpdate,
  installUpdate,
  notifyAppReady,
} from '@codemagic/capacitor-patch';

await notifyAppReady();

const check = await checkForUpdate();
if (check.action === 'ota-update') {
  const localPackage = await downloadUpdate(check.remotePackage);
  await installUpdate(localPackage); // defaults to ON_NEXT_RESTART
}
```

To choose when an installed update takes effect, pass an `InstallMode` to `start()`,
`sync()` or `installUpdate()`. It is exported as a value as well as a type, matching the
React Native SDK. Plain strings (`'IMMEDIATE'`) still type-check:

```ts
import { InstallMode, start } from '@codemagic/capacitor-patch';

start({ installMode: InstallMode.ON_NEXT_RESUME, minimumBackgroundDuration: 60_000 });
```

| `InstallMode` | The update takes effect… |
| --- | --- |
| `ON_NEXT_RESTART` (default) | on the next cold start |
| `IMMEDIATE` (default for mandatory updates) | right away, by reloading the WebView |
| `ON_NEXT_RESUME` | when the app next returns to the foreground |
| `ON_NEXT_SUSPEND` | while the app is in the background |

For the last two, `minimumBackgroundDuration` (milliseconds) sets how long the app must
have been in the background first. Without it, a brief interruption counts: on iOS,
pulling down Notification Centre briefly takes the app out of the foreground too.
Mandatory updates use `mandatoryInstallMode` instead of `installMode`. Foreground and
background transitions come from the plugin's own native lifecycle events, so no other
plugin is needed.

`getRunningBundleUpdateMetadata()` reports the running OTA release (`{ label,
packageHash, releaseNotes }`, or `null` on the embedded bundle). `isNextVersionReady()`
answers a different question — whether a *different* package is already installed and
waiting for the next reload, so you can show an "Update ready" prompt without confusing
it with what's currently running:

```ts
import { isNextVersionReady, restartApp } from '@codemagic/capacitor-patch';

if (await isNextVersionReady()) {
  // show your own "Update ready — restart now?" prompt, then:
  await restartApp();
}
```

`restartApp`, `allowRestart`/`disallowRestart`, and `hydrate` are also exported for
controlling reload timing. See [`src/definitions.ts`](src/definitions.ts) and
[`src/protocol/types.ts`](src/protocol/types.ts) for the full API surface.

## Example app

[`example-app/`](example-app/README.md) is an Ionic + Angular reference app wired to this
plugin by path. It exercises the whole cycle on a device or simulator — check, download,
install, restart, and crash rollback — and is the quickest way to see the SDK working
against your own Patch server.

## Documentation

| Document | What it covers |
| --- | --- |
| [Root README](../README.md) | Running and self-hosting the Patch server, the dashboard, the local evaluation stack |
| [`cmpatch-capacitor`](../cli-capacitor/README.md) | The CLI: signing in, apps and deployment keys, publishing and operating releases, and what the target binary version has to guarantee |
| [`PROTOCOL.md`](../PROTOCOL.md) | The client ↔ server delivery contract this SDK implements |
| [Migrating from Appflow Live Updates](../docs/migrate-from-appflow.md) | Maps Appflow channels, config, and the JS API onto their Codemagic Patch equivalents |
| [`example-app/`](example-app/README.md) | Running the reference app against a Patch server |
| [`src/protocol/`](src/protocol/README.md) | How the delivery-protocol layer maps onto the React Native client's sources |

## Licence

Apache-2.0 — see [`LICENSE`](LICENSE). This matches the React Native client SDK and the
CLI; only `server/` carries the Codemagic Server License, and this package does not
depend on it.

Vendored third-party code keeps its own licence and attribution — see [`NOTICE`](NOTICE).
