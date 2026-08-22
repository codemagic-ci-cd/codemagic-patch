# Migrating from CodePush

This guide is for teams running `react-native-code-push` — against App Center
CodePush, a standalone `code-push-server`, or one of its forks — who are moving
to Codemagic Patch. It covers the two things that change on your side:

1. [Client SDK migration](#1-client-sdk-migration) — swapping
   `react-native-code-push` for `@codemagic/react-native-patch`
2. [CLI usage differences](#2-cli-usage-differences) — moving from the
   `code-push` CLI (or `appcenter codepush`) to `cmpatch`

Server setup is a prerequisite, not part of this guide. See
[`docs/self-hosting-compose.md`](self-hosting-compose.md) for a production
self-host ([Part 1 of the root README](../README.md#part-1--run-the-server-self-host)
is the condensed version), or the
[local quickstart](../README.md#quickstart--try-it-locally) to evaluate on a
laptop first.

## The mental model carries over

Apps, deployments, deployment keys, `Staging`/`Production`, `release-react`,
target binary versions, mandatory releases, rollout percentages, promote, and
rollback all exist in Codemagic Patch and mean what you expect. The structural
differences worth knowing before you start:

- **Two base URLs instead of one server URL.** Devices talk to the API server
  for manifest routing and download artifacts from static storage / a CDN.
  Your app configures both (`CodemagicPatchApiUrl` +
  `CodemagicPatchDownloadBaseUrl`)
- **All client configuration is native-resource-only.** There is no JS-side
  deployment key, server URL, or config API.
- **No OTA path across the migration.** Devices running the CodePush SDK can
  never receive a Codemagic Patch release — the swap ships as a regular
  store/binary release (see [§1.6](#16-ship-the-migration-as-a-binary-release)).
- **No server-side data import.** Apps, deployments, release history, and
  metrics are not migrated from a CodePush server. You recreate apps and
  deployments with the CLI and start a fresh release history.

## Prerequisites

- A running Codemagic Patch server you can reach.
- The `cmpatch` CLI installed and authenticated
  ([`cli/README.md`](../cli/README.md)):

  ```sh
  cmpatch login --server-url https://updates.example.com
  cmpatch config set server-url https://updates.example.com  # remember it for later commands
  cmpatch app create --name my-app        # creates Staging + Production
  cmpatch deployment list --app my-app    # note the new deployment keys
  ```

Deployment key **values** are new — CodePush keys cannot be reused. Everywhere
this guide says "deployment key", use the value printed by
`cmpatch deployment list`.

## 1. Client SDK migration

### 1.1 Swap the package

```sh
yarn remove react-native-code-push
yarn add @codemagic/react-native-patch
cd ios && pod install
```

Also remove CodePush-specific build wiring that has no Patch equivalent:

- Android: delete the
  `apply from: "../../node_modules/react-native-code-push/android/codepush.gradle"`
  line from `android/app/build.gradle`.
- Any multi-deployment build-config machinery that swapped
  `CodePushDeploymentKey` per build type keeps working conceptually — it just
  writes the new resource names below instead.

### 1.2 Replace native configuration resources

| CodePush (strings.xml / Info.plist) | Codemagic Patch | Notes |
| --- | --- | --- |
| `CodePushDeploymentKey` | `CodemagicPatchDeploymentKey` | New value, from `cmpatch deployment list` |
| Android: `CodePushServerUrl`<br>iOS: `CodePushServerURL` | `CodemagicPatchApiUrl` **and** `CodemagicPatchDownloadBaseUrl` | One URL becomes two: API origin + artifact origin |
| `CodePushPublicKey` | `CodemagicPatchPublicKey` | Optional; only for client-side signature enforcement |

The full resource contract (which URL carries a path prefix, what the SDK
appends) is in [`client/README.md` §Configuration](../client/README.md#configuration)
— follow it as written; this table is only the rename map.

### 1.3 Replace the native bundle wiring

The wiring shape is the same as CodePush — swap the class:

- **Android** (`MainApplication`): `CodePush.getJSBundleFile()` →
  `CodemagicPatch.getJSBundleFile(applicationContext)`. Remove the existing
  `com.microsoft.codepush.react.CodePush` import and add
  `import io.codemagic.patch.CodemagicPatch` (with a trailing semicolon in
  Java).
- **iOS** (`AppDelegate`): `[CodePush bundleURL]` / `CodePush.bundleURL()` →
  `[CodemagicPatch bundleURL]` / `CodemagicPatch.bundleURL()`. In Swift,
  remove `import CodePush` and add `import CodemagicPatchClient`.

Use the per-RN-version snippets in
[`client/README.md` §Configuration](../client/README.md#configuration) — they
cover the RN 0.82+ `reactHost` form on Android and the Objective-C++
forward-declaration needed on RN ≤ 0.76 iOS templates. Expo apps skip this
section entirely and use the bundled config plugin instead
([`client/README.md` §Expo apps](../client/README.md#expo-apps)) — something
CodePush never offered first-party.

### 1.4 Migrate the JS integration

There is no `codePush()` higher-order component and no decorator. Delete the
HOC wrapper and call `sync()` from your own lifecycle code (e.g. on mount, or
from an `AppState` listener if you want resume-triggered checks).

API mapping:

| `react-native-code-push` | `@codemagic/react-native-patch` | Notes |
| --- | --- | --- |
| `codePush(options)(App)` HOC | — | Call `sync()` explicitly |
| `codePush.sync(options, statusCb, progressCb, mismatchCb)` | `sync(options?, onProgress?)` | Returns a final `SyncStatus` promise; no per-transition status callback |
| `codePush.checkForUpdate(key?, mismatchCb?)` | `checkForUpdate()` | No JS deployment-key override. Binary mismatch callback is replaced by `isStoreUpdateAvailable` / `latestBinaryVersion` on the result |
| `remotePackage.download(progressCb)` | `downloadUpdate(remotePackage, onProgress?)` | Module function, not a method on the package object |
| `localPackage.install(installMode, minBackgroundDuration)` | `installUpdate(localPackage, { installMode, minimumBackgroundDuration })` | |
| `codePush.notifyAppReady()` / `notifyApplicationReady()` | `notifyAppReady()` | `sync()` still calls it internally |
| `codePush.restartApp(onlyIfUpdateIsPending?)` | `restartApp(onlyIfUpdateIsPending?)` | |
| `codePush.allowRestart()` / `disallowRestart()` | `allowRestart()` / `disallowRestart()` | |
| `codePush.getUpdateMetadata(updateState?)` | `getRunningBundleUpdateMetadata()` | Returns only `{ label, packageHash, releaseNotes }` for the running OTA bundle (`null` on the embedded bundle). No `UpdateState` argument — `PENDING` / `LATEST` lookups are not exposed; `checkForUpdate()` / `sync()` results carry remote package metadata |
| `codePush.clearUpdates()` | — | The server-driven `embedded-revert` action covers "return the fleet to the binary bundle" |
| JS-side key/server config (`setDeploymentKey`, sync `deploymentKey` option) | — | Configuration is native-resource-only ([§1.2](#12-replace-native-configuration-resources)) |

Option and enum mapping:

- **`InstallMode`** — numeric enum → string literals: `"IMMEDIATE"`,
  `"ON_NEXT_RESTART"`, `"ON_NEXT_RESUME"`, `"ON_NEXT_SUSPEND"`. Defaults are
  unchanged from CodePush: `installMode` defaults to `ON_NEXT_RESTART`,
  `mandatoryInstallMode` to `IMMEDIATE`.
- **`minimumBackgroundDuration` is now in milliseconds** (CodePush used
  seconds). A carried-over `minimumBackgroundDuration: 300` now means 300 ms —
  multiply by 1000.
- **`SyncStatus`** — numeric enum → strings. `sync()` resolves to
  `"up-to-date"`, `"update-installed"`, `"embedded-revert-applied"`,
  `"sync-in-progress"`, or `"error"`.
- **`updateDialog` is gone.** The SDK never shows UI. Build your own prompt
  from `checkForUpdate()` metadata (`releaseNotes`, `isMandatory`) and drive
  the manual flow.
- **`checkFrequency` is gone.** Sync timing is yours: call `sync()` when you
  want `ON_APP_START` / `ON_APP_RESUME` behavior.
- **New result kind: `embedded-revert`.** `checkForUpdate()` can return
  `{ action: "embedded-revert" }`, meaning the server wants the device back on
  the embedded bundle. `sync()` handles it automatically; a manual flow passes
  the result straight to `installUpdate()`.

The full API surface and option types live in
[`client/src/types.ts`](../client/src/types.ts).

### 1.5 Support floor

Codemagic Patch supports React Native 0.73+ (RN 0.73–0.75 on the Old
Architecture only; New Architecture support starts at RN 0.76) and Expo
SDK 52+ — see [`client/README.md` §Requirements](../client/README.md#requirements).
Apps on older RN versions must upgrade RN before (or with) the migration
binary.

### 1.6 Ship the migration as a binary release

The SDK swap itself cannot be delivered over the air. Plan the cutover as:

1. Ship a store/binary release containing `@codemagic/react-native-patch`,
   configured against your Patch server.
2. Keep the old CodePush server running (read-only is fine) until enough of
   the fleet has rotated onto the new binary — devices on old binaries still
   check the CodePush endpoint.
3. Publish subsequent OTA updates with `cmpatch release-react` targeting the
   new binary versions only.

Verify the integration end to end before shipping — the fastest loop is the
[on-device demo](../examples/on-device-demo/README.md), which runs the full
publish → sync → rollback cycle against the local evaluation stack.

## 2. CLI usage differences

Install: `cmpatch` ships as `@codemagic/patch-cli`
([`cli/README.md`](../cli/README.md)). Legacy commands below are the
standalone `code-push` CLI's; `appcenter codepush` subcommands map the same
way.

### 2.1 Authentication and identity

| Legacy | `cmpatch` | Notes |
| --- | --- | --- |
| `code-push register` | — | Accounts come from the server's sign-in (GitHub OAuth) or `cmpatch member invite` / `member provision` |
| `code-push login <serverUrl> --accessKey <key>` | `cmpatch login --server-url <url>` | In a terminal it first asks: browser sign-in (loopback redirect) or paste a token; `--token cm_pat_...` for headless machines |
| `code-push logout` | `cmpatch logout` | |
| `code-push whoami` | `cmpatch whoami` | |
| `code-push access-key add/ls/rm` | `cmpatch token create/list/revoke` | Token value shown once at creation |
| `code-push session ls/rm` | — | |

Credentials are stored per server under `~/.codemagic-patch/`. `login` itself
does not set a default server URL — store it once with
`cmpatch config set server-url <url>` (or `cmpatch init`, or the
`CODEMAGIC_PATCH_SERVER_URL` environment variable) instead of passing
`--server-url` per command.

### 2.2 App and deployment management

| Legacy | `cmpatch` | Notes |
| --- | --- | --- |
| `code-push app add/ls/rename/rm` | `cmpatch app create/list/rename/remove` | `app create` seeds `Staging` + `Production`, same as CodePush. Also new: `app show`, `app setting` (e.g. `--require-code-signing`) |
| `code-push app transfer` | — | OSS self-host runs a single team; use `member` roles instead |
| `code-push collaborator add/ls/rm` | `cmpatch member add/invite/list/update/remove` | Team-scoped roles (`viewer`/`developer`/`admin`/`owner`) instead of per-app collaborators |
| `code-push deployment add/ls/rename/rm/clear` | `cmpatch deployment create/list/rename/remove/clear` | `deployment list` prints deployment keys; metrics live in `cmpatch deployment metrics` |
| `code-push deployment history` | `cmpatch deployment history` | Alias for `release list --include metrics --limit 50` |

### 2.3 Releasing

| Legacy | `cmpatch` | Notes |
| --- | --- | --- |
| `code-push release-react <app> <platform>` | `cmpatch release-react --app <app> --platform <ios\|android>` | Positionals become flags; see the flag map below |
| `code-push release <app> <contents> <targetBinaryVersion>` | `cmpatch release create` | Pre-built bundle via `--bundle-path` (directory, zip, or `.cmpatch` artifact). `--platform` is required unless `--fingerprint` is given; a `.cmpatch` carries its own target version and fingerprint, so those flags are rejected with it |
| `code-push release-expo` | — | `release-react` auto-detects Expo (`--bundler auto\|metro\|expo`) |
| `code-push release-native` | — | Binary releases are not registered through the CLI |
| `code-push patch` | `cmpatch release patch` | Rollout, mandatory, description, target binary version |
| `code-push promote` | `cmpatch release promote` | |
| `code-push rollback` | `cmpatch release rollback` | |
| `code-push debug <platform>` | `cmpatch debug <ios\|android>` | Platform stays positional; streams device logs via `adb` / `xcrun` |
| — | `cmpatch release list/show/inspect`, `release disable/enable` | New: inspect worker status (`--wait`), pull a release from/back into static delivery |
| — | `cmpatch deployment metrics`, `cmpatch release metrics` | Replaces reading metrics off `deployment ls` |
| — | `cmpatch init`, `cmpatch context`, `cmpatch doctor`, `cmpatch fingerprint` | Project defaults wizard, effective-config dump, setup diagnosis, fingerprint tooling |

### 2.4 `release-react` flag map

| Legacy | `cmpatch release-react` | Notes |
| --- | --- | --- |
| `<appName>` positional | `--app` | Or a project default from `cmpatch init` |
| `<platform>` positional | `--platform` | Required |
| `--deploymentName` / `-d` | `--deployment` | |
| `--targetBinaryVersion` / `-t` | `--target-binary-version` | Auto-detection from `Info.plist` / `build.gradle` is preserved when omitted |
| `--description` | `--release-notes` | |
| `--mandatory` / `-m` | `--mandatory` | |
| `--rollout` / `-r` | `--rollout-percentage` | |
| `--disabled` / `-x` | `--disabled` | |
| `--entryFile` | `--entry-file` | |
| `--gradleFile` | `--gradle-file` | |
| `--plistFile` | `--plist-file` | |
| `--plistFilePrefix` | `--plist-file-prefix` | |
| `--sourcemapOutput` | `--sourcemap-output` | `release create` names the same thing `--sourcemap` |
| `--privateKeyPath` | `--private-key-path` | Code signing parity |
| `--noDuplicateReleaseError` | `--no-duplicate-release-error` | Byte-identical duplicates are rejected by default, as before |
| `--useHermes` | `--hermes auto\|true\|false` | `auto` reads the project config |
| `--extraHermesFlags` | `--extra-hermes-flag` | Repeatable |
| `--extraBundlerOption` | `--bundler-args` | Repeatable; use `--bundler-args=--reset-cache` for values starting with a dash |
| `--xcodeProjectFile` | `--xcode-project-file` | With `--xcode-target-name` / `--build-configuration-name`, steers the `project.pbxproj` lookup that iOS version detection falls back to when `Info.plist` holds `$(MARKETING_VERSION)` |
| `--xcodeTargetName` | `--xcode-target-name` | |
| `--buildConfigurationName` | `--build-configuration-name` | |
| `--development`, `--bundleName`, `--outputDir`, `--podFile`, `--buildNumber` | — | Dropped: releases are production bundles with platform-standard names |
| — | `--bundler`, `--dry-run`, `--yes`, `--non-interactive`, `--format json\|table` | New |

### 2.5 Behavioral differences to expect

- **Fingerprints are mandatory.** The server rejects a release upload that
  carries no fingerprint, and there is no CLI flag to skip it.
  `release-react` always computes the native-project fingerprint (via
  `@expo/fingerprint`) and fails with a validation error when it can't — run
  from the project root or pass `--project-root`. `release` computes it the
  same way, or accepts a precomputed value via `--fingerprint`. The
  fingerprint drives compatibility-based delivery across binary versions, a
  concept CodePush did not have.
- **Interactive confirmation.** In a terminal, release-producing commands
  print their mutation context and require user confirmation; CI passes
  `--yes`.
- **Project defaults.** `cmpatch init` writes
  `codemagic-patch.config.json` (app, deployment, platform overrides), so CI
  invocations need fewer flags; explicit flags always win. `cmpatch context`
  shows the effective result.
- **Scriptable output.** Most commands accept `--format json|table`; piped
  output defaults to JSON, so the CLI is directly scriptable
  ([`cli/README.md` §Output formats](../cli/README.md#output-formats)).

The complete command list lives in the root README's
[CLI command reference](../README.md#cli-command-reference); run
`cmpatch help` or `cmpatch <command> --help` for full flag semantics.
