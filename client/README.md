# `@codemagic/react-native-patch`

Client SDK for [Codemagic Patch](https://github.com/codemagic-ci-cd/codemagic-patch): a self-hosted CodePush successor for over-the-air updates on React Native and Expo apps. Download, verify, and boot JS/asset bundles on device so you can ship JS changes without a new store binary.

This package is only the on-device side. You also need a Patch server (self-hosted) and the [`cmpatch` CLI](https://github.com/codemagic-ci-cd/codemagic-patch/tree/main/cli) to publish releases. The monorepo has both, plus a dashboard and a local evaluation stack.

## What you get

From the [monorepo](https://github.com/codemagic-ci-cd/codemagic-patch):

- Full stack via Docker Compose (API, worker, Postgres, Silo, dashboard)
- Web dashboard with RBAC and release management
- On-device demo app for trying OTA updates quickly

From this SDK:

- Binary patches when available, for smaller downloads (falls back to a full bundle)
- Signature verification when you configure a public key
- Automatic rollback if a new package fails before the app reports ready
- Expo config plugin for prebuild projects, plus bare React Native wiring
- One-line `Patch.wrap(App)` root wrapper, CodePush-style `sync()`, or step-by-step APIs when you need control

  <img width="700" alt="the self-hosted Patch dashboard" src="https://github.com/user-attachments/assets/e48f2c99-78e9-48c0-ae75-5a5278581e7d" />

## Requirements

- React Native `0.73+` — New Architecture support starts at RN 0.76; RN 0.73–0.75 are supported on the Old (Paper) Architecture only
- Android `minSdkVersion` 23+ (the library follows the host's `rootProject.ext.minSdkVersion`; without one it builds at 23)
- Android native build with CMake/JNI support
- iOS native build with CocoaPods and mixed Swift/ObjC++ compilation
- Expo SDK 52+ (via the bundled config plugin — see [Expo apps](#expo-apps))
- **Expo Go is not supported** — the native module is not part of the Expo Go runtime

Reference fixture apps, including the Expo SDK 58 / RN 0.88.0 host, are listed in the [E2E fixture workspace](e2e/fixture-app/README.md).

## Installation

```sh
npm install @codemagic/react-native-patch
# or
yarn add @codemagic/react-native-patch
```

`react` (`>=18`) and `react-native` (`>=0.73`) are peer dependencies. On iOS, install the native pod:

```sh
cd ios && pod install
```
## Quick start

Configuration lives in **native resources** (deployment key, API URL, download base URL, optional public key), not in a JS config object. The Expo plugin writes those for you; bare apps set them in `Info.plist` / `strings.xml` and wire bundle selection.

### Expo (config plugin)

If you maintain native projects manually, follow [manual native setup](https://patch.codemagic.io/docs/setup/native-setup#option-a-bare-react-native).

```json
{
  "plugins": [
    ["@codemagic/react-native-patch", {
      "ios": {
        "deploymentKey": "<key>",
        "downloadBaseUrl": "<url>",
        "apiUrl": "<url>",
        "publicKey": "<pem>"
      },
      "android": {
        "deploymentKey": "<key>",
        "downloadBaseUrl": "<url>",
        "apiUrl": "<url>",
        "publicKey": "<pem>"
      }
    }]
  ]
}
```

Configure at least one platform. Every block you provide needs `deploymentKey`, `downloadBaseUrl`, and `apiUrl` (`publicKey` and `maxLaunchAttempts` are optional). Then run `expo prebuild`. See [Configuration](#configuration) for where each value comes from.

### Bare React Native

Add `CodemagicPatchDeploymentKey`, `CodemagicPatchApiUrl`, and `CodemagicPatchDownloadBaseUrl` (optional `CodemagicPatchPublicKey`) to Android `strings.xml` and iOS `Info.plist`, then point RN’s JS bundle path at `CodemagicPatch.getJSBundleFile` / `CodemagicPatch.bundleURL()` so boot order is pending package → current package → embedded bundle. Full snippets are in [Configuration](#configuration) below.

### Wrap the root component

```tsx
import * as Patch from "@codemagic/react-native-patch";

function App() {
  return <AppNavigator />;
}

export default Patch.wrap(App);
```

`wrap()` renders your app right away and runs `sync()` once the root has mounted. With no options, ordinary updates install on the next restart and mandatory updates install immediately; pass `WrapOptions` as the second argument to change that (`Patch.wrap(App, { installMode: Patch.InstallMode.ON_NEXT_RESUME })`).

Set `checkFrequency: "ON_APP_RESUME"` to check on mount and on foreground return; the default `"ON_APP_START"` checks only on mount. For example: `Patch.wrap(App, { checkFrequency: Patch.CheckFrequency.ON_APP_RESUME, installMode: Patch.InstallMode.ON_NEXT_RESTART })`. For manual checks, use the direct APIs without `wrap()`. `Patch.CheckFrequency` and `Patch.InstallMode` provide named constants; existing string literals remain supported.

`wrap()` forwards props and refs to your root component. It does not copy custom static properties, such as `App.navigationOptions`, onto the wrapper.

Mounting the wrapped root is what reports the app as ready: `sync()` calls `notifyAppReady()` first, which confirms the running package and arms rollback for the next one. If your app has to finish an asynchronous bootstrap (authentication, database migration) before it can vouch for the running bundle, skip `wrap()` and call `sync()` yourself at that point:

```ts
import { sync } from "@codemagic/react-native-patch";
import { bootstrapApp } from "./bootstrap"; // Your app's initialization routine.

await bootstrapApp(); // If initialization fails, do not confirm the bundle.
const status = await sync();
// "update-installed" | "up-to-date" | "embedded-revert-applied"
// | "sync-in-progress" | "error"
```

`sync()` never throws. It checks for an update, downloads and installs when appropriate, and reports app readiness so a bad package can roll back.

For check / download / install as separate steps, restart timing helpers (`restartApp`, `allowRestart` / `disallowRestart`), `getRunningBundleUpdateMetadata()` to read which OTA release is running, or `isNextVersionReady()` to learn whether an installed update is waiting for the next reload, see the [SDK types](https://github.com/codemagic-ci-cd/codemagic-patch/blob/main/client/src/types.ts).

## Configuration

Codemagic Patch is configured through **native resources**, not a JS API — the deployment key, URLs, public key, and binary version are read natively before the SDK initializes. Provide these values per host app:

| Resource | Required | Meaning |
| --- | --- | --- |
| `CodemagicPatchDeploymentKey` | yes | Deployment key for this app/track |
| `CodemagicPatchApiUrl` | yes | API server origin (the server's `SERVER_URL`), e.g. `https://updates.example.com`. The SDK appends `/v1/...` |
| `CodemagicPatchDownloadBaseUrl` | yes | Artifact origin (the server's `PUBLIC_BASE_URL`), e.g. `https://storage.example.com/codemagic-patch`. May include a bucket/path prefix; the SDK appends manifest/artifact paths |
| `CodemagicPatchPublicKey` | no | PEM public key; required only when enforcing client-side signature verification |
| `CodemagicPatchMaxLaunchAttempts` | no | Positive integer; consecutive launches a pending update may boot without `notifyAppReady()` before crash rollback. Default `2`; see [`notifyAppReady()`](https://patch.codemagic.io/docs/reference/sdk-reference#notifyappready) |

The two URLs point at different systems (API server vs. object storage / CDN), which is why one usually carries a path and the other does not.

**Where the values come from:** the deployment key is the `DEPLOYMENT_KEY` column of `cmpatch deployment list --app <app-name> --format table` (or the deployment's page in the dashboard); the API URL and download base URL are printed by the self-host installer when the server is set up. Use **separate apps — and therefore separate deployment keys — for iOS and Android**.

### Bare React Native

1. **Declare the resources.**

   iOS — `ios/<YourApp>/Info.plist`:

   ```xml
   <key>CodemagicPatchDeploymentKey</key>
   <string>ios-staging-deployment-key</string>
   <key>CodemagicPatchDownloadBaseUrl</key>
   <string>https://storage-updates.example.com/codemagic-patch</string>
   <key>CodemagicPatchApiUrl</key>
   <string>https://updates.example.com</string>
   <!-- optional, only when enforcing code signing -->
   <key>CodemagicPatchPublicKey</key>
   <string>-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----</string>
   <!-- optional, defaults to 2 -->
   <key>CodemagicPatchMaxLaunchAttempts</key>
   <integer>2</integer>
   ```

   Android — `android/app/src/main/res/values/strings.xml`:

   ```xml
   <resources>
     <string name="CodemagicPatchDeploymentKey" translatable="false">android-staging-deployment-key</string>
     <string name="CodemagicPatchDownloadBaseUrl" translatable="false">https://storage-updates.example.com/codemagic-patch</string>
     <string name="CodemagicPatchApiUrl" translatable="false">https://updates.example.com</string>
     <!-- optional, only when enforcing code signing -->
     <string name="CodemagicPatchPublicKey" translatable="false">-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----</string>
     <!-- optional, defaults to 2 -->
     <string name="CodemagicPatchMaxLaunchAttempts" translatable="false">2</string>
   </resources>
   ```

   Release builds with resource shrinking keep these strings: from 0.5.2 the SDK ships a keep rule (`res/raw/codemagic_patch_keep.xml`) that merges into the app. On older versions, add the same file to the app as `android/app/src/main/res/raw/codemagic_patch_keep.xml` (not `keep.xml`, which React Native's bundle task overwrites); [Troubleshooting](https://patch.codemagic.io/docs/troubleshooting#release-published-but-app-finds-no-update) has the contents.

2. **Wire native bundle selection** before the RN bridge starts, so boot order is **pending package → current package → embedded bundle**.

   Android — feed `CodemagicPatch.getJSBundleFile(applicationContext)` into React Native in `MainApplication`. On RN ≤ 0.81 (`ReactNativeHost`), override `getJSBundleFile()`:

   ```kotlin
   override fun getJSBundleFile(): String? =
       CodemagicPatch.getJSBundleFile(applicationContext)
   ```

   On RN 0.82+ (new-arch `reactHost`), pass it as `jsBundleFilePath`:

   ```kotlin
   override val reactHost: ReactHost by lazy {
     getDefaultReactHost(
       context = applicationContext,
       packageList = PackageList(this).packages,
       jsBundleFilePath = CodemagicPatch.getJSBundleFile(applicationContext),
     )
   }
   ```

   iOS — import `CodemagicPatchClient` and override `bundleURL()` / `sourceURL(for:)` in `AppDelegate` with the same selection order. Keep the `DEBUG` branch pointing at Metro so local development keeps working:

   ```swift
   import CodemagicPatchClient

   class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
     override func sourceURL(for bridge: RCTBridge) -> URL? {
       self.bundleURL()
     }

     override func bundleURL() -> URL? {
   #if DEBUG
       RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
   #else
       CodemagicPatch.bundleURL() ?? Bundle.main.url(forResource: "main", withExtension: "jsbundle")
   #endif
     }
   }
   ```

   On RN ≤ 0.76, where the app template still ships an Objective-C++ `AppDelegate.mm`, override `sourceURLForBridge:` with the same selection. The native module is a Swift pod exposed to Objective-C as `@objc(CodemagicPatch)`; its generated `-Swift.h` is not on the host target's header search paths and `@import` is unavailable in ObjC++, so forward-declare the surface you call:

   ```objc
   // CodemagicPatch is a Swift pod exposed as @objc(CodemagicPatch); forward-declare it —
   // the implementation links in from the pod's static library.
   @interface CodemagicPatch : NSObject
   + (NSURL *_Nullable)bundleURL;
   @end

   - (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
   {
   #if DEBUG
     return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
   #else
     return [CodemagicPatch bundleURL] ?: [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
   #endif
   }
   ```

   Expected embedded bundle names are `index.android.bundle` (Android) and `main.jsbundle` (iOS). If the SDK cannot determine a non-blank binary version (`versionName` / `CFBundleShortVersionString`), it no-ops and falls back to the embedded bundle.

   > **Debug builds load JS from Metro**, so OTA updates are not picked up there — that is expected, not a wiring problem. To see an update apply, run a release-style build.

3. **Register the native module** for your architecture — the TurboModule (New Architecture) or the bridge module/package (Old Architecture). Autolinking handles this in most apps.

### Expo apps

For projects using Prebuild, use the bundled config plugin (`app.plugin.js`) as shown in [Quick start](#expo-config-plugin). Native projects maintained manually use the native configuration and bundle-selection steps instead. The plugin configuration is:

```json
{
  "plugins": [
    ["@codemagic/react-native-patch", {
      "ios":     { "deploymentKey": "<key>", "downloadBaseUrl": "<url>", "apiUrl": "<url>", "publicKey": "<pem>" },
      "android": { "deploymentKey": "<key>", "downloadBaseUrl": "<url>", "apiUrl": "<url>", "publicKey": "<pem>" }
    }]
  ]
}
```

The plugin writes the native resources and wires bundle selection automatically (Configuration steps 1–3). Configure **at least one platform**, and complete every block you provide — `deploymentKey`, `downloadBaseUrl`, and `apiUrl` are all required per block (`publicKey` and `maxLaunchAttempts` are optional). The plugin resolves `expo/config-plugins` from your app's own Expo SDK, so there is nothing extra to install; `expo` is not a runtime or peer dependency of this package.

## Usage

The simplest integration is `Patch.wrap(App)`, which renders your root component immediately and runs `sync()` after it mounts. `sync()` checks for an update, downloads it, installs it, and reports app readiness in one call. It never throws — it resolves to a status string. Call it directly when you need to pick the moment yourself, for example after an asynchronous bootstrap:

```ts
import { sync } from "@codemagic/react-native-patch";
import { bootstrapApp } from "./bootstrap"; // Your app's initialization routine.

await bootstrapApp(); // If initialization fails, do not confirm the bundle.
const status = await sync();
// "update-installed" | "up-to-date" | "embedded-revert-applied"
// | "sync-in-progress" | "error"
```

For finer control, drive the steps yourself and call `notifyAppReady()` once the app has started successfully (so the update is not rolled back):

```ts
import {
  checkForUpdate,
  downloadUpdate,
  installUpdate,
  notifyAppReady,
} from "@codemagic/react-native-patch";
```

`restartApp`, `allowRestart` / `disallowRestart`, and `hydrate` are also exported for controlling reload timing, `getRunningBundleUpdateMetadata()` reports the running OTA release (`{ label, packageHash, releaseNotes }`, or `null` on the embedded bundle), and `isNextVersionReady()` reports whether a newer package is installed and waiting for the next reload. See the [type definitions](https://github.com/codemagic-ci-cd/codemagic-patch/tree/main/client/src/types.ts) for the full API surface.

## Testing

The SDK resolves its TurboModule when it is imported, so under Jest, where there is no native binary, a suite that imports it fails before any test runs. The package ships a fake of that native module for Jest. The real SDK runs on top of it, so `sync()`, `checkForUpdate()` and the rest behave as they would in an app.

Keep the preset you already use, add the setup file, and add `@codemagic` to the allowlist your `transformIgnorePatterns` already has:

```js
// jest.config.js
module.exports = {
  preset: '@react-native/jest-preset', // or 'react-native' on older RN, or 'jest-expo'
  setupFiles: ['@codemagic/react-native-patch/jest-setup'],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@codemagic)/)',
  ],
};
```

The allowlist entry is needed because under the `react-native` export condition this package resolves to its TypeScript source, as React Native itself does, and Jest does not transform `node_modules` by default.

The setup file installs the default scenario: the app runs the store binary and the server has no update. That is enough for tests that only need the SDK to load. For another scenario, install a fake with a seed and load the SDK after it:

```ts
import { installPatchFake, loadSdk } from '@codemagic/react-native-patch/jest';

test('reports the running release', async () => {
  installPatchFake({ running: { label: 'v4' } });
  const Patch = await loadSdk();
  expect(await Patch.getRunningBundleUpdateMetadata()).toMatchObject({ label: 'v4' });
});

test('an update is ready for the next launch', async () => {
  installPatchFake({ server: { release: { label: 'v5' } } });
  const Patch = await loadSdk();
  const status = await Patch.sync({
    installMode: Patch.InstallMode.ON_NEXT_RESTART,
    mandatoryInstallMode: Patch.InstallMode.ON_NEXT_RESTART,
  });
  expect(status).toBe('update-installed');
  expect(await Patch.isNextVersionReady()).toBe(true);
});
```

The seed also takes `binaryVersion`, `runningUnconfirmed` with `previous`, `failedInstall`, and `server.latestBinaryVersion` / `server.error`; `fake.fail(method, error)` makes one native call reject and `fake.setServer()` changes the server answer. See [`src/fake/types.ts`](https://github.com/codemagic-ci-cd/codemagic-patch/tree/main/client/src/fake/types.ts).

Isolation rules:

- The SDK reads the native module and boot state once per module instance. `installPatchFake()` only affects SDK instances imported after it, so install before importing the code under test, or call `loadSdk()` after installing.
- `loadSdk()` calls `jest.resetModules()` and imports a fresh SDK, cancelling the previous `loadSdk()` instance's pending `ON_NEXT_SUSPEND` reload. Require anything else that uses the SDK (your components, for example) after it, so they share that instance.
- `loadSdk()` does not reset the fake: failures, server answers and downloaded packages stay. Start each scenario with a new `installPatchFake()`.
- `sync()` confirms an unconfirmed running package first; use `checkForUpdate()` / `downloadUpdate()` / `installUpdate()` to keep it unconfirmed. `restartApp()` resolves without reloading JS.

On Vitest, add the plugin and the setup file, then use `installPatchFake` / `loadSdk` from `@codemagic/react-native-patch/vitest` the same way. The plugin points the package at its TypeScript source so Vitest's module mocks reach the SDK. The adapter replaces `react-native` with a mock that only has what the SDK uses (`TurboModuleRegistry`, `AppState`, `DeviceEventEmitter`), so render components with `react-dom` in a `jsdom` environment. As under Jest, import your own modules that use the SDK after `loadSdk()`; React itself is not reset, so the test's React and the SDK's stay the same.

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import { codemagicPatch } from '@codemagic/react-native-patch/vitest-plugin';

export default defineConfig({
  plugins: [codemagicPatch()],
  test: { setupFiles: ['@codemagic/react-native-patch/vitest-setup'] },
});
```

Not covered yet: code signing (the fake reports no signing key), download progress, rollout percentages, and inspecting the metric events the SDK sends.

## Documentation

Full integration guide, update protocol, and self-hosting instructions live in the [Codemagic Patch repository](https://github.com/codemagic-ci-cd/codemagic-patch).

Coming from `react-native-code-push`? The [CodePush migration guide](https://github.com/codemagic-ci-cd/codemagic-patch/blob/main/docs/migrate-from-codepush.md) maps the native config resources, JS APIs, and CLI commands to their Codemagic Patch equivalents.

## License

[Apache-2.0](./LICENSE)
