# Migrating from Appflow Live Updates

This guide is for teams running Ionic Appflow's Live Updates (the `@capacitor/live-updates`
plugin, configured through the Appflow dashboard) who are moving to Codemagic Patch. It
covers the two things that change on your side:

1. [Client SDK migration](#1-client-sdk-migration) — swapping `@capacitor/live-updates`
   for `@codemagic/capacitor-patch`
2. [Dashboard/CLI differences](#2-dashboardcli-differences) — moving from the Appflow
   dashboard (and its build service) to the self-hosted Patch server and `cmpatch-capacitor`

Server setup is a prerequisite, not part of this guide. See
[`docs/self-hosting-compose.md`](self-hosting-compose.md) for a production self-host
([Part 1 of the root README](../README.md#part-1--run-the-server-self-host) is the
condensed version), or the [local quickstart](../README.md#quickstart--try-it-locally) to
evaluate on a laptop first.

> **0.x.** `@codemagic/capacitor-patch` and `cmpatch-capacitor` are 0.x releases; their API
> and flags may still change. Installation is the usual `npm install` — see the
> [SDK README's Installation section](../client-capacitor/README.md#installation).

## The mental model carries over

Apps, per-environment tracks, a public/private key pair for signed updates, checking for
an update and applying it, and rolling back a bad release all exist in Codemagic Patch
and mean roughly what you expect. The structural differences worth knowing before you
start:

- **Channel becomes deployment.** Appflow's `channel` (e.g. `Production`, `Staging`) is
  the same idea as a Patch **deployment** — a named release track with its own key. Each
  Capacitor platform gets its **own** deployment key (Appflow's `channel` string is
  shared across platforms; Patch's manifest path carries no platform segment, so
  **reusing one key for both platforms lets releases overwrite each other** — always
  configure two).
- **Two base URLs instead of one `appId`.** Appflow resolves everything from a single
  `appId` against Ionic's cloud. Patch devices talk to a self-hosted API server for
  manifest routing (`apiUrl`) and download artifacts from separate static storage/a CDN
  (`downloadBaseUrl`) — you configure both.
- **All client configuration is native-resource/`capacitor.config.ts`-only, resolved
  once.** Appflow's `getConfig()`/`setConfig()` let a running app read and rewrite its
  own Live Updates config at runtime; this SDK has **no equivalent** — configuration is
  resolved once, at plugin `load()`, from `capacitor.config.ts` or a native resource
  override (see the [SDK README's Configuration section](../client-capacitor/README.md#configuration)).
  A workflow that reconfigures channels at runtime needs restructuring, not a drop-in swap.
- **No OTA path across the migration.** A device running the old plugin can never
  receive a Codemagic Patch release — the swap ships as a regular store/binary release
  (see [§1.4](#14-ship-the-migration-as-a-binary-release)).
- **No server-side data import.** Apps, channels/deployments, and release history are
  not migrated from Appflow. You recreate apps and deployments with `cmpatch-capacitor` and start
  a fresh release history.

## Prerequisites

- A running Codemagic Patch server you can reach (self-hosted; see the links above).
- The `cmpatch-capacitor` CLI ([`cli-capacitor/README.md`](../cli-capacitor/README.md)),
  installed from npm. Keep iOS and Android in **separate apps** — that is what gives each
  platform its own deployment keys:

  ```sh
  npm install -g @codemagic/capacitor-patch-cli

  export CODEMAGIC_PATCH_SERVER_URL=<url>
  cmpatch-capacitor login
  cmpatch-capacitor app create --name my-app-ios        # each app is seeded with Staging + Production
  cmpatch-capacitor app create --name my-app-android
  cmpatch-capacitor deployment list --app my-app-ios       # note the new deployment keys
  cmpatch-capacitor deployment list --app my-app-android
  ```

Deployment key **values** are new — Appflow channel identifiers cannot be reused.
Everywhere this guide says "deployment key," use the value printed by
`cmpatch-capacitor deployment list`.

## 1. Client SDK migration

### 1.1 Swap the package

```sh
npm uninstall @capacitor/live-updates
npm install @codemagic/capacitor-patch
npx cap sync
```

### 1.2 Replace the Live Updates config block

| Appflow (`capacitor.config.ts` `plugins.LiveUpdates`) | Codemagic Patch (`plugins.CodemagicPatch.<platform>`) | Notes |
| --- | --- | --- |
| `appId` | — | No equivalent — a deployment key already identifies the app+platform+track |
| `channel` | `deploymentKey` | The direct analog: a named release track. Get the value from `cmpatch-capacitor deployment list`, **one per platform**, not one shared string |
| — | `apiUrl` | New: the API server origin. Appflow had no equivalent — self-hosting means you configure it |
| — | `downloadBaseUrl` | New: the artifact/storage origin, likewise implicit in Appflow's hosted service |
| `autoUpdateMethod: 'background' \| 'none'` | — | Not a config key: call `start()` for automatic checks, or don't for none — see [§1.3](#13-migrate-the-js-integration) |
| `maxVersions` | — | No equivalent — this SDK garbage-collects superseded packages on-device automatically, not a developer-tunable count |
| `key` (Self-hosted Live Updates) | `publicKey` | Optional. The same idea — the public half of your signing key pair, which the SDK uses to verify a release before installing it — but the value is the PEM text itself, not the name of a key file. Sign releases with `cmpatch-capacitor release --private-key-path` |
| — | `maxLaunchAttempts` | New, optional: how many launches a new update may fail to report ready before it is rolled back (default 3) |

See the [SDK README §Configuration](../client-capacitor/README.md#configuration) for the full contract
(required vs. optional keys, the native-resource override, and the same-key warning) —
this table is only the rename/rework map.

### 1.3 Migrate the JS integration

There is no `LiveUpdates.reload()`/`setConfig()` runtime API. Configuration is fixed at
`capacitor.config.ts` build time. Call `start()` once your first screen has rendered;
with `checkFrequency: CheckFrequency.ON_APP_RESUME` it also checks each time the app
returns to the foreground, so no resume listener of your own is needed.

| `@capacitor/live-updates` | `@codemagic/capacitor-patch` | Notes |
| --- | --- | --- |
| Automatic update on launch/resume (`autoUpdateMethod: 'background'`) | `start({ checkFrequency })` | Checks on start, and on foreground return with `ON_APP_RESUME` |
| `LiveUpdates.sync({ channel? })` | `sync(options?, onProgress?)` | Same name, same "check, download, install in one call" shape. No per-call `channel` override — the deployment key is fixed per platform build |
| `LiveUpdates.getConfig()` / `setConfig()` | — | No equivalent (config is resolved once, not runtime-readable/writable — see [above](#the-mental-model-carries-over)) |
| `LiveUpdates.reload()` | `restartApp()` | Applies a downloaded update immediately |
| — (Live Updates has no readiness call) | `notifyAppReady()` | New: confirms that a freshly installed package booted. Until it is called the package stays pending, and a package still unconfirmed after `maxLaunchAttempts` launches (default 3) is rolled back. `start()` and `sync()` call it internally, so only step-by-step integrations call it themselves |
| — | `checkForUpdate()`, `downloadUpdate()`, `installUpdate()` | Step-by-step equivalents of `sync()`'s single call, for apps that want to show their own progress/prompt UI — no Appflow Live Updates equivalent (its API is `sync()`-only) |
| — | `getRunningBundleUpdateMetadata()` | Reports the running OTA release (`{ label, packageHash, releaseNotes }`, or `null` on the embedded bundle) — Appflow's `getConfig()` exposes the active `channel`/version instead |
| — | `isNextVersionReady()` | Whether a different update is already installed and waiting for the next reload, for an "Update ready — restart?" prompt |
| — | `allowRestart()` / `disallowRestart()` | Suppress an automatic restart during a sensitive UI flow — no Appflow equivalent |

The full API surface and option types live in
[`client-capacitor/src/definitions.ts`](../client-capacitor/src/definitions.ts) and
[`client-capacitor/src/protocol/types.ts`](../client-capacitor/src/protocol/types.ts).

### 1.4 Ship the migration as a binary release

The SDK swap itself cannot be delivered over the air:

1. Ship a store/binary release containing `@codemagic/capacitor-patch`, configured
   against your Patch server.
2. Keep the old Appflow-configured build available (or Appflow itself running) until
   enough of the fleet has rotated onto the new binary.
3. Publish subsequent OTA updates with
   [`cmpatch-capacitor release create`](../cli-capacitor/README.md) targeting the new
   binary versions only.

Verify the integration end to end before shipping — the
[example app](../client-capacitor/example-app/README.md) runs the full publish → sync →
rollback cycle against a local evaluation stack.

## 2. Dashboard/CLI differences

Appflow's Live Updates are managed entirely through the Appflow web dashboard (plus
cloud builds triggered from it); there is no separate CLI for channels/releases the way
`cmpatch-capacitor` provides one. The closest equivalents:

| Appflow dashboard action | `cmpatch-capacitor` | Notes |
| --- | --- | --- |
| Create an app | `app create --name <name>` | Seeds `Staging` + `Production` deployments |
| Create/manage a channel | `deployment create/list/rename/remove --app <name>` | `deployment list` prints deployment keys |
| Upload a build to a channel | `release create --bundle-path <dir>` | Takes the pre-built web asset directory or a zip of it — Appflow instead builds your app in the cloud from a connected repo |
| Move a build between channels | `release promote` | Same bundle, nothing re-uploaded — e.g. Staging to Production |
| Roll a channel back | `release rollback` | |
| View release/adoption metrics | `deployment metrics` / `release metrics` | |

Codemagic Patch has no hosted build service — `cmpatch-capacitor release create` uploads
a bundle you already built (in your own CI, or locally), whereas Appflow's Live Updates are
typically populated by an Appflow cloud build. If your existing pipeline builds the web
assets already (most Capacitor CI does), point that same build output at
`cmpatch-capacitor` instead of Appflow's upload step:

```sh
npm install -g @codemagic/capacitor-patch-cli

export CODEMAGIC_PATCH_SERVER_URL=<url>
export CODEMAGIC_PATCH_TOKEN=<access token>    # `cmpatch-capacitor token create --name ci`.
                                               # On your own machine the `login` above is enough

cmpatch-capacitor release create \
  --bundle-path www \
  --app my-app-ios --deployment Production \
  --target-binary-version 1.2.0 \
  --yes    # a pipeline cannot answer the confirmation prompt; without this the command refuses to run there
```

Read the CLI README's section on the
[target binary version](../cli-capacitor/README.md#the-binary-version-is-the-compatibility-boundary)
before your first release: Appflow scoped a live update to a native build for you, and
here the native app version does that job, so bump it whenever the native side changes.

Run `cmpatch-capacitor --help`, or `cmpatch-capacitor <command> --help`, for every command
and flag.
