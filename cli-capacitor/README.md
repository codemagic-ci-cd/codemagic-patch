# `@codemagic/capacitor-patch-cli`

`cmpatch-capacitor` is the command line for over-the-air updates of Capacitor and Ionic
apps on a [Codemagic Patch](https://github.com/codemagic-ci-cd/codemagic-patch) server:
it signs you in, sets up apps and deployments, publishes the web assets your build
produced, and operates the releases afterwards — staged rollouts, promotion from Staging
to Production, rollback, adoption metrics. Apps that embed
[`@codemagic/capacitor-patch`](../client-capacitor/README.md) receive what it publishes.

It is the only command-line tool a Capacitor team needs for this.

> **Status: 0.x.** The package is on npm, but its flags may still change between minor
> versions.

## Commands

| | |
| --- | --- |
| `login`, `logout`, `whoami` | [Sign in](#sign-in) to a server, and check who you are signed in as |
| `token create \| list \| revoke` | Personal access tokens, for [CI](#in-ci) |
| `config list \| set \| unset` | This machine's [default server](#from-nothing-to-a-published-update) |
| `app create \| list \| show \| rename \| setting \| remove` | [Apps](#apps-and-deployments) — one per platform |
| `deployment create \| list \| rename \| remove \| clear \| metrics \| history` | Deployments, their **deployment keys**, and their adoption numbers |
| `release create` | [Publish](#publish-a-release) built web assets. A bare `release` means the same |
| `release list \| show \| inspect \| metrics` | [Look at releases](#operate-releases) and at how they are being adopted |
| `release patch \| disable \| enable \| promote \| rollback` | [Change what devices receive](#operate-releases) |

`cmpatch-capacitor --help` lists them, and `cmpatch-capacitor <command> --help` documents
every flag of one. The help is generated from the same definitions the parser uses, so it
is always current; this README explains the workflow rather than repeating it.

Two things to know before the first release:

- `release create` checks that the bundle is a **web root** — `index.html` at its top
  level — before uploading. A release is unpacked into the directory the WebView is
  pointed at, so a bundle that starts one folder too high installs fine and boots to a
  blank screen.
- It needs **no native project**, and computes no fingerprint of one: what ties a release
  to the native app is the binary version you name. Read
  [The binary version is the compatibility boundary](#the-binary-version-is-the-compatibility-boundary)
  — it decides what `--target-binary-version` means for you.

What it does not do: manage team members (that is the dashboard's Members page), or
install and maintain a Patch server. There is no project config file either — the
deployment is always named by flags, and the server by a flag, an environment variable or
[this machine's default server](#from-nothing-to-a-published-update); nothing is asked
interactively except the [confirmation](#confirmation) before a change; and the output is
`text` unless you pass `--format json`, whether or not it is piped.

## Requirements

- Node.js 20.19+ or 22.12+.
- A Patch server you can reach.

## Install

```sh
npm install -g @codemagic/capacitor-patch-cli
```

That puts `cmpatch-capacitor` on your `PATH`; `cmpatch-capacitor --version` confirms it.
With nvm, a global command belongs to the Node version it was installed under, so use the
same one in the terminal where you run it.

### From source

To run the CLI from a clone of this repository instead — it needs what the repository
needs, Node.js 22.20+ and Yarn 4 via Corepack:

```sh
corepack enable
yarn install
yarn workspace @codemagic/capacitor-patch-cli build
alias cmpatch-capacitor="node $PWD/cli-capacitor/dist/cmpatch-capacitor.js"
```

## From nothing to a published update

```sh
export CODEMAGIC_PATCH_SERVER_URL=https://patch.example.com
cmpatch-capacitor login                                   # opens the browser

cmpatch-capacitor app create --name MyApp-iOS             # each app gets Staging + Production
cmpatch-capacitor app create --name MyApp-Android
cmpatch-capacitor deployment list --app MyApp-iOS         # the keys for the SDK's config
cmpatch-capacitor deployment list --app MyApp-Android

ionic build                                               # or ng build, vite build, ...
cmpatch-capacitor release create --bundle-path www \
  --app MyApp-iOS --deployment Staging --target-binary-version 1.4.0
cmpatch-capacitor release inspect --app MyApp-iOS --deployment Staging --label v1 --wait

cmpatch-capacitor release promote --app MyApp-iOS \
  --source-deployment Staging --label v1 --dest-deployment Production --rollout-percentage 10
cmpatch-capacitor release inspect --app MyApp-iOS --deployment Production --label v1 --wait
cmpatch-capacitor release patch --app MyApp-iOS --deployment Production --label v1 \
  --rollout-percentage 100
```

A release can only be changed once the server has finished processing it, which is what
the two `release inspect --wait` lines wait for.

Every command that talks to the server needs it named: `--server-url <url>`, or
`CODEMAGIC_PATCH_SERVER_URL` as above. With neither, this machine's default server is
used, if it has one: `cmpatch-capacitor config set --server-url <url>` stores it (in
`~/.codemagic-patch/config.json`), `config list` shows it and `config unset --server-url`
forgets it. Signing in does not set a default server.

## Sign in

```sh
cmpatch-capacitor login --server-url https://patch.example.com
```

opens the server's sign-in page in your browser, waits for you to approve, and stores
the session on this machine. From then on commands need no token for that server, and a
session that has expired is renewed on its own. `whoami` shows the account in use.

- `logout` deletes the stored credential for the server. A browser session is also
  revoked on the server; a token stored with `login --token` is only forgotten locally —
  it stays valid until you revoke it with `token revoke` or on the dashboard.
- The session is stored in `~/.codemagic-patch/credentials-capacitor.json` (set
  `CODEMAGIC_PATCH_HOME` to move the directory), readable by your user only.
- `--no-browser` prints the sign-in URL instead of opening it. The page has to be opened
  on the machine the command runs on — it redirects to `127.0.0.1` — so over SSH, and on
  a server with no browser sign-in configured, use a token instead:
  `cmpatch-capacitor login --token <token>` checks the token with the server and stores
  it. Note that a token on the command line lands in your shell history.
- `--timeout-seconds <n>` changes how long `login` waits for the browser (default 300).
- In CI there is nothing to log in to: set `CODEMAGIC_PATCH_TOKEN` and skip this step.

What a command authenticates with, first match wins: `--token`, then
`CODEMAGIC_PATCH_TOKEN`, then the stored sign-in. If a login seems to have had no effect,
check that the variable is not set — `login` warns when it is.

## Apps and deployments

An **app** is one platform of your product, and a **deployment** is a release track of
that app. Create one app **per platform** — `MyApp-iOS` and `MyApp-Android` — and never
let iOS and Android share a deployment: a release's delivery path carries no platform, so
the two would overwrite each other.

`app create` gives the new app a `Staging` and a `Production` deployment.
`deployment list --app <name>` prints each deployment's **deployment key**, which is what
the SDK's `deploymentKey` setting takes (see
[Configuration](../client-capacitor/README.md#configuration) in the SDK README).
`deployment create` adds a track such as `Beta`; `deployment rename` leaves the key — and
so every installed app — untouched.

Things are selected by name or by id, whichever you have:

| To select | By name | By id |
| --- | --- | --- |
| an app | `--app <name>` | `--app-id <id>` |
| a deployment | `--app <name>` (or `--app-id`) with `--deployment <name>` | `--deployment-id <id>` |
| a release | a deployment, with `--label <label>` (`v12`) | `--release-id <id>` |

Names match case-insensitively. Ids need no lookups and survive renames, which makes them
the better choice in CI. `--team <name or id>` is only needed when your account can see
more than one team.

`app remove`, `deployment remove` and `deployment clear` delete releases for good and
ask first, like every command that changes what devices receive — see
[Confirmation](#confirmation).

## Publish a release

1. Build the web assets the way your project already does — `ionic build`,
   `ng build`, `vite build`, … The output directory is the `webDir` of your
   `capacitor.config` (`www/` for Ionic Angular, `dist/` for most Vite-based projects).
   `cmpatch-capacitor` ships that directory; it never runs the build, and it does not
   need `npx cap sync` to have run.
2. Release it to one deployment. The same `www/` usually goes to both platforms, as two
   releases:

   ```sh
   cmpatch-capacitor release create --bundle-path www \
     --app MyApp-iOS --deployment Staging --target-binary-version 1.4.0

   cmpatch-capacitor release create --bundle-path www \
     --app MyApp-Android --deployment Staging --target-binary-version 1.4.0
   ```

`--dry-run` does everything except the upload: it validates and archives the bundle and
prints the package hash the server would compute.

The upload creates the release and queues a processing job on the server; the release
becomes available to devices when that job finishes. `release inspect --wait` blocks
until it has, and fails if the job failed — put it after `release create` in a pipeline.

| `release create` flag | |
| --- | --- |
| `--bundle-path <dir\|zip>` | **Required.** The built web assets — the `webDir`, with `index.html` at its root — or a ZIP of that directory's contents |
| `--target-binary-version <version>` | **Required.** The exact native app version the release is for (`CFBundleShortVersionString` / `versionName`), e.g. `1.4.0`. Ranges and wildcards are rejected: the server matches versions exactly |
| the deployment | **Required.** See the table above |
| `--rollout-percentage <1-100>` | Share of devices offered the release. Default `100` |
| `--mandatory` | Mark the release as mandatory. The SDK's `start()` and `sync()` apply a mandatory update as soon as it is installed, reloading the web view, unless the app passes its own `mandatoryInstallMode` |
| `--disabled` | Upload the release without making it available; `release enable` publishes it later |
| `--release-notes <text>` | Notes stored with the release |
| `--private-key-path <path>` | Sign the release — see [Code signing](#code-signing) |
| `--no-duplicate-release-error` | Accept a bundle identical to the deployment's latest release, which is otherwise an error |
| `--dry-run` | Validate, archive and hash the bundle without uploading |

## Operate releases

```sh
cmpatch-capacitor release list --app MyApp-iOS --deployment Production --include metrics
cmpatch-capacitor release show --app MyApp-iOS --deployment Production --label v12
```

- **Staged rollout.** Publish with `--rollout-percentage 10`, watch
  `release metrics`, then `release patch … --rollout-percentage 50`, then `100`. The
  percentage can be raised, not lowered. `patch` also changes `--mandatory` /
  `--not-mandatory` and `--release-notes`.
- **Promote.** `release promote` creates a release in another deployment from the bundle
  of an existing one — shipping to Production exactly the bytes that were tested in
  Staging, with nothing re-uploaded. It takes its own `--rollout-percentage`,
  `--mandatory` / `--not-mandatory`, `--release-notes` and `--disabled`.
- **Take a release back.** `release disable` makes the deployment offer the release
  before it again — to devices already running the disabled one too, on their next check
  (the next launch, or every return to the foreground for an app that calls the SDK's
  `start({ checkFrequency: CheckFrequency.ON_APP_RESUME })`) — and `release enable`
  undoes that. `release rollback` does the same thing as a recorded
  step: it publishes a new release, with a label of its own, from the bundle of the
  previous one (or of `--label <label>`).
- **Adoption.** `release metrics` for one release, `deployment metrics` for all of a
  deployment's: active, downloaded, ready (installed, waiting to take effect), applied
  (running and reported healthy), failed.

## The binary version is the compatibility boundary

A web bundle calls into native code: Capacitor plugins, your own native classes, the
native configuration. A bundle built against one native build can break on another — it
calls `Camera.getPhoto()` on a binary that was shipped before `@capacitor/camera` was
added, say.

`cmpatch-capacitor` does **not** detect that for you. It computes no fingerprint of the
native project, and nothing on the server or the device compares native builds. What it
does is narrower: **a release is delivered to the `--target-binary-version` it names.**
The server's release format has a field for a native fingerprint; this CLI fills it with
a `binary-version:<version>` label, so the server is given nothing that would let it fan
the release out to other binary versions on its own.

So the native app version has to carry the compatibility promise:

- **Bump the native version whenever the native side changes** — a plugin added, removed
  or upgraded, native code edited, native configuration changed. Then release your web
  bundle to the new version only.
- Two store builds with the same version number must be interchangeable for the web
  bundle. If they are not, no OTA tool can tell them apart.
- To ship one web bundle to several binary versions, release it once per version.
- **A release cannot be moved to another binary version.** `release patch` and
  `release promote` accept `--target-binary-version`, but refuse it for releases this CLI
  uploaded: the label travels with the release, the server would record it against the
  new version, and from then on it would treat the two versions as the same native build
  and deliver releases for one to the other as well. Publish the bundle again for the
  other version instead. The guard is this CLI's: do not change the target binary version
  of these releases on the dashboard either.

Publish to a deployment with this CLI only. If a binary version of the deployment
already has a computed native fingerprint on record from another tool, a release from
this CLI is still accepted, with a warning that the two values differ.

## Code signing

An app created with `--require-code-signing` (or switched with
`app setting --require-code-signing=true`) only accepts signed releases, and an SDK
configured with a `publicKey` only installs them. Pass the RSA private key that matches
that public key:

```sh
cmpatch-capacitor release create --bundle-path www \
  --app MyApp-iOS --deployment Production --target-binary-version 1.4.0 \
  --private-key-path ./patch-private-key.pem
```

The signature is an RS256 JWT over the bundle's package hash, verified on-device by the
SDK. To create the key pair:

```sh
openssl genrsa -out patch-private-key.pem 2048
openssl rsa -in patch-private-key.pem -pubout -out patch-public-key.pem
```

Keep the private key out of the repository. The public half — the whole PEM text,
`-----BEGIN PUBLIC KEY-----` line included — goes in the plugin's `publicKey` setting; see
[Configuration](../client-capacitor/README.md#configuration) in the SDK README.

## Confirmation

Commands that change what devices receive, or delete something — `release create`,
`patch`, `disable`, `enable`, `promote`, `rollback`, `app remove`, `deployment remove`,
`deployment clear` — show what they are about to do and ask first. The question is only
asked on a terminal; anywhere else — a CI job (`CI` set to a non-empty value other than
`0` or `false`), stdin or stderr that is not a terminal, `--format json` — the command
refuses to run without `-y` / `--yes`.

## In CI

Create a token once — `cmpatch-capacitor token create --name ci --expires-in-days 365`,
or the dashboard's Tokens page — and give the pipeline `CODEMAGIC_PATCH_SERVER_URL` and
`CODEMAGIC_PATCH_TOKEN` as secrets:

```sh
npm install -g @codemagic/capacitor-patch-cli

cmpatch-capacitor release create \
  --bundle-path www \
  --deployment-id "$PATCH_DEPLOYMENT_ID" \
  --target-binary-version "$APP_VERSION" \
  --release-notes "$(git log -1 --pretty=%s)" \
  --yes --format json > release.json

cmpatch-capacitor release inspect --release-id "$(jq -r .release.id release.json)" --wait
```

Uploads, promotions and rollbacks carry an idempotency key and are retried on transient
failures, so a flaky network does not create a release twice.

`--format json` prints the server's response as it came; the default, `text`, is tables
and labelled fields for people. A few commands have no server response to pass on and
print a small object of their own: `release create --dry-run` (its report),
`release inspect` (the server's `release` and `job`, plus `inspection: { status,
terminal }`), the removals and `token revoke` (`{ "deleted": true, … }`), and a
`release patch`, `disable` or `enable` that found nothing to change
(`{ "changed": false, "id": … }`). A warning the server attaches to a release it accepted
is part of the result: the last lines of the text output, `warnings` in the JSON.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Server or runtime error (not found, duplicate release, network failure, …), or the confirmation was declined |
| 2 | Usage error, a missing `--yes`, not signed in, or a token given by `--token` or the environment that the server rejects |
| 3 | Validation error; a release that failed processing or did not finish within `inspect --wait`'s timeout; a stored sign-in that expired or was revoked (sign in again), or a credential store that cannot be read; a browser sign-in that was denied or timed out |
| 4 | Account disabled |
| 130 | Confirmation prompt aborted (Ctrl-C) |

## Licence

Apache-2.0 — see [`LICENSE`](LICENSE).
