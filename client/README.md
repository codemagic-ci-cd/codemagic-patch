# `@codemagic/react-native-patch`

Client SDK for [Codemagic Patch](https://github.com/codemagic-ci-cd/codemagic-patch): a self-hosted CodePush successor for over-the-air updates on React Native and Expo apps. Download, verify, and boot JS/asset bundles on device so you can ship JS changes without a new store binary.

This package is only the on-device side. You also need a Patch server (self-hosted) and the [`cmpatch` CLI](https://github.com/codemagic-ci-cd/codemagic-patch/tree/main/cli) to publish releases. The monorepo has both, plus a dashboard and a local evaluation stack.

## What you get

From the [monorepo](https://github.com/codemagic-ci-cd/codemagic-patch):

- Full stack via Docker Compose (API, worker, Postgres, MinIO, dashboard)
- Web dashboard with RBAC and release management
- On-device demo app for trying OTA updates quickly

From this SDK:

- Binary patches when available, for smaller downloads (falls back to a full bundle)
- Signature verification when you configure a public key
- Automatic rollback if a new package fails before the app reports ready
- Expo config plugin for prebuild projects, plus bare React Native wiring
- CodePush-style `sync()`, or step-by-step APIs when you need control

  <img width="700" alt="the self-hosted Patch dashboard" src="https://github.com/user-attachments/assets/e48f2c99-78e9-48c0-ae75-5a5278581e7d" />

## Requirements

- React Native `0.73+` — New Architecture support starts at RN 0.76; RN 0.73–0.75 are supported on the Old (Paper) Architecture only
- Android `minSdkVersion` 23+ (the library follows the host's `rootProject.ext.minSdkVersion`; without one it builds at 23)
- Android native build with CMake/JNI support
- iOS native build with CocoaPods and mixed Swift/ObjC++ compilation
- Expo SDK 52+ (via the bundled config plugin — see [Expo apps](#expo-apps))
- **Expo Go is not supported** — the native module is not part of the Expo Go runtime

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

Configure at least one platform. Every block you provide needs `deploymentKey`, `downloadBaseUrl`, and `apiUrl` (`publicKey` is optional). Then run `expo prebuild`. See [Configuration](#configuration) for where each value comes from.

### Bare React Native

Add `CodemagicPatchDeploymentKey`, `CodemagicPatchApiUrl`, and `CodemagicPatchDownloadBaseUrl` (optional `CodemagicPatchPublicKey`) to Android `strings.xml` and iOS `Info.plist`, then point RN’s JS bundle path at `CodemagicPatch.getJSBundleFile` / `CodemagicPatch.bundleURL()` so boot order is pending package → current package → embedded bundle. Full snippets are in [Configuration](#configuration) below.

### Call `sync()`

```ts
import { sync } from "@codemagic/react-native-patch";

const status = await sync();
// "update-installed" | "up-to-date" | "embedded-revert-applied"
// | "sync-in-progress" | "error"
```

`sync()` never throws. It checks for an update, downloads and installs when appropriate, and reports app readiness so a bad package can roll back.

For check / download / install as separate steps, restart timing helpers (`restartApp`, `allowRestart` / `disallowRestart`), or `getRunningBundleUpdateMetadata()` to read which OTA release is running, see the [SDK types](https://github.com/codemagic-ci-cd/codemagic-patch/blob/main/client/src/types.ts).

## Configuration

Codemagic Patch is configured through **native resources**, not a JS API — the deployment key, URLs, public key, and binary version are read natively before the SDK initializes. Provide these values per host app:

| Resource | Required | Meaning |
| --- | --- | --- |
| `CodemagicPatchDeploymentKey` | yes | Deployment key for this app/track |
| `CodemagicPatchApiUrl` | yes | API server origin (the server's `SERVER_URL`), e.g. `https://updates.example.com`. The SDK appends `/v1/...` |
| `CodemagicPatchDownloadBaseUrl` | yes | Artifact origin (the server's `PUBLIC_BASE_URL`), e.g. `https://storage.example.com/codemagic-patch`. May include a bucket/path prefix; the SDK appends manifest/artifact paths |
| `CodemagicPatchPublicKey` | no | PEM public key; required only when enforcing client-side signature verification |

The two URLs point at different systems (API server vs. object storage / CDN), which is why one usually carries a path and the other does not.

**Where the values come from:** the deployment key is the `DEPLOYMENT_KEY` column of `cmpatch deployment list --app <app-name> --format table` (or the deployment's page in the dashboard); the API URL and download base URL are printed by the self-host installer when the server is set up. Use **separate apps — and therefore separate deployment keys — for iOS and Android**.

### Bare React Native

1. **Declare the resources.**

   iOS — `ios/<YourApp>/Info.plist`:

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

   Android — `android/app/src/main/res/values/strings.xml`:

   ```xml
   <resources>
     <string name="CodemagicPatchDeploymentKey" translatable="false">android-staging-deployment-key</string>
     <string name="CodemagicPatchDownloadBaseUrl" translatable="false">https://storage.updates.example.com/codemagic-patch</string>
     <string name="CodemagicPatchApiUrl" translatable="false">https://updates.example.com</string>
     <!-- optional, only when enforcing code signing -->
     <string name="CodemagicPatchPublicKey" translatable="false">-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----</string>
   </resources>
   ```

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

The package ships a bundled Expo config plugin (`app.plugin.js`). Add it to `app.json` with per-platform props and run `expo prebuild`:

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

The plugin writes the native resources and wires bundle selection automatically (Configuration steps 1–3). Configure **at least one platform**, and complete every block you provide — `deploymentKey`, `downloadBaseUrl`, and `apiUrl` are all required per block (`publicKey` is optional). The plugin resolves `expo/config-plugins` from your app's own Expo SDK, so there is nothing extra to install; `expo` is not a runtime or peer dependency of this package.

## Usage

The simplest integration is `sync()`, which checks for an update, downloads it, installs it, and reports app readiness in one call. It never throws — it resolves to a status string.

```ts
import { sync } from "@codemagic/react-native-patch";

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

`restartApp`, `allowRestart` / `disallowRestart`, and `hydrate` are also exported for controlling reload timing, and `getRunningBundleUpdateMetadata()` reports the running OTA release (`{ label, packageHash, releaseNotes }`, or `null` on the embedded bundle). See the [type definitions](https://github.com/codemagic-ci-cd/codemagic-patch/tree/main/client/src/types.ts) for the full API surface.

## Documentation

Full integration guide, update protocol, and self-hosting instructions live in the [Codemagic Patch repository](https://github.com/codemagic-ci-cd/codemagic-patch).

Coming from `react-native-code-push`? The [CodePush migration guide](https://github.com/codemagic-ci-cd/codemagic-patch/blob/main/docs/migrate-from-codepush.md) maps the native config resources, JS APIs, and CLI commands to their Codemagic Patch equivalents.

## License

[Apache-2.0](./LICENSE)
