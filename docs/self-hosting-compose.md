# Self-Hosting With Docker Compose

> **Just evaluating?** Don't start here. The [local evaluation
> stack](../README.md#quickstart--try-it-locally) runs the full product —
> dashboard included — on a laptop with one `docker compose` command and
> Docker as the only prerequisite. Deploying for real (this document) additionally needs public
> DNS, open ports 80/443, and an OAuth app on GitHub and/or Bitbucket.

This is the supported deployment path for Codemagic Patch — and in the initial
open-source release, the only one. It runs the Codemagic Patch server as a single
process in `MODE=all` on one Docker host with bundled PostgreSQL, bundled
MinIO, and Caddy for HTTPS. Split deployments with separate API and worker
services are a work in progress.

Related material:

- [`docs/custom-deployment.md`](custom-deployment.md) describes what the
  server requires if you bring your own platform. It is reference material,
  not a supported deployment path in the initial open-source release.
- For evaluation on a workstation, use the
  [local quickstart](../README.md#quickstart--try-it-locally) instead of
  deploying.

## Requirements

Prepare everything below **before** running the installer. The pieces span two
roles: the **server host** that runs the stack, and the **release workstation**
you publish updates from. They can be the same machine, but their toolchains
differ.

### Server host

- A publicly reachable **Linux host with a public IP** — *not* behind NAT. Caddy
  obtains Let's Encrypt certificates over HTTP, so the host must be reachable from
  the internet on ports 80/443. A laptop behind NAT or a home router will fail at
  the certificate step.
- Sizing: at runtime the stack (PostgreSQL, MinIO, the server, and Caddy in one
  Compose project) fits in roughly **2 GB RAM** plus a few GB of disk that grows
  with the OTA artifacts you store. The memory peak, though, is the **first
  install**, which builds the server and dashboard images on the host — budget
  **~4 GB RAM (or add swap)** for that build; a 2 GB host with no swap risks an
  OOM-killed build.
- **Docker Engine** with **Docker Compose v2**.
- **TCP ports 80 and 443 open** to the internet (host firewall / cloud security
  group).
- Command-line tools `docker` and `curl` (used by the installer), plus `git` to
  clone this repository.
- **Outbound network access** from the host to the services below (these are
  services, not an exact firewall allowlist — only GitHub publishes stable
  hostnames):
  - **Let's Encrypt** (ACME) — TLS certificates.
  - **GitHub** (`github.com` / `api.github.com`) — OAuth token exchange when
    GitHub sign-in is configured, and the unauthenticated lookup used by
    handle invites.
  - **Bitbucket** (`bitbucket.org` / `api.bitbucket.org`) — OAuth token
    exchange when Bitbucket sign-in is configured.
  - **A container registry** (Docker Hub) — the PostgreSQL/MinIO images and the
    image build base layers.
  - **The Cloudflare API** — only if you enable the CDN.

### DNS — must resolve before you install

Point two records at the host and **let them propagate before running the
installer**: Caddy's certificate challenge needs them live, or the install stalls
at the HTTPS-readiness step.

```text
updates.example.com          A/AAAA  <server-ip>
storage.updates.example.com  A/AAAA  <server-ip>
```

The storage domain is intentionally separate. The API domain serves the control
plane, while the storage domain serves OTA artifacts from MinIO under
`/codemagic-patch`. (If you plan to front storage with Cloudflare, keep the storage
record **DNS-only** during install and switch it to proxied afterward — see
[Optional: front storage with Cloudflare CDN](#optional-front-storage-with-cloudflare-cdn).)

### OAuth sign-in provider — required

The server refuses to boot without at least one OAuth sign-in provider —
GitHub and/or Bitbucket — so create a GitHub OAuth App or a Bitbucket OAuth
consumer and have its **client ID** and **client secret** ready before
installing — full steps in [Required: OAuth sign-in](#required-oauth-sign-in)
and [Bitbucket sign-in](#bitbucket-sign-in). You sign in as the first admin
with the provider account whose **verified primary email** you pass as
`--email`, so decide that account up front.

### Release workstation — for the `cmpatch` CLI

Publishing updates uses the `cmpatch` CLI, which you build from this repo with
**Node.js 22.20+ (`<23`)** and **Yarn 4** (via Corepack) — see
[Install the CLI](#install-the-cli). This can be the server host or any dev
machine; the server-host install itself does not need Node.

### Optional: Cloudflare CDN

To serve artifacts through Cloudflare with automatic cache purge on release, also
prepare a Cloudflare **API token** scoped to *Zone → Cache Purge* and the
**Zone ID** of the zone holding your storage domain — see
[Optional: front storage with Cloudflare CDN](#optional-front-storage-with-cloudflare-cdn).

## Install

From the repository root:

```bash
./scripts/selfhost/install.sh
```

Non-interactive form:

```bash
./scripts/selfhost/install.sh \
  --api-domain updates.example.com \
  --storage-domain storage.updates.example.com \
  --email admin@example.com \
  --github-oauth-client-id Iv1.0123456789abcdef \
  --github-oauth-client-secret <client-secret>
```

The installer creates `.env.selfhost`, builds the server and caddy (web
dashboard) images, starts the Compose stack, and waits for HTTPS readiness.

**At least one OAuth sign-in provider is required** — GitHub and/or Bitbucket.
Create the GitHub OAuth App or Bitbucket OAuth consumer first (next sections)
and pass its client ID and client secret; the server refuses to boot without
one. For a Bitbucket-only install, pass `--bitbucket-oauth-client-id` and
`--bitbucket-oauth-client-secret` — the installer then skips the GitHub
prompts (see [Bitbucket sign-in](#bitbucket-sign-in)). The installer mints
**no** API token; the first admin signs in with a configured provider and
creates everything from there. Store `.env.selfhost` securely.

### Required: OAuth sign-in

People sign in through an OAuth provider: users open the web dashboard or run
`cmpatch login`, authorize on GitHub or Bitbucket, and get their own account —
there is no shared token to copy around. At least one provider must be
configured. This section walks through the GitHub OAuth App;
[Bitbucket sign-in](#bitbucket-sign-in) covers Bitbucket, both as a second
provider and as the only one. (Machine/CI access still uses personal access
tokens; see [Machine & CI access](#machine--ci-access).)

One OAuth App (or consumer) serves both sign-in paths:

- The web dashboard uses the **web authorization flow**, which needs an
  **Authorization callback URL** (`https://<api-domain>/auth/callback`) and a
  **client secret** generated on the OAuth App.
- `cmpatch login` opens that same dashboard sign-in in the browser and
  finishes over a localhost redirect, so it needs no extra OAuth App
  settings.

#### 1. Create a GitHub OAuth App

1. Go to GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**
   (use an organization's developer settings if the app should belong to a team).
2. **Application name**: anything, for example `Codemagic Patch (self-host)`.
3. **Homepage URL**: your API domain, for example `https://updates.example.com`.
4. **Authorization callback URL**: `https://<api-domain>/auth/callback`, for
   example `https://updates.example.com/auth/callback` — the web dashboard
   redirects here after the user authorizes on GitHub.
5. Click **Register application**.
6. On the app page, copy the **Client ID**, then click
   **Generate a new client secret** and copy the **client secret**.

#### 2. Run the installer with the Client ID and client secret

```bash
./scripts/selfhost/install.sh \
  --api-domain updates.example.com \
  --storage-domain storage.updates.example.com \
  --email admin@example.com \
  --github-oauth-client-id Iv1.0123456789abcdef \
  --github-oauth-client-secret <client-secret>
```

The interactive installer prompts for the GitHub Client ID and client secret
when they are not passed — unless Bitbucket OAuth is configured instead, in
which case the GitHub prompts are skipped (see
[Bitbucket sign-in](#bitbucket-sign-in)). The installer generates
`OAUTH_CLI_AUTH_SECRET` and writes these into `.env.selfhost` (the `GITHUB_*`
variables only when GitHub is configured):

| Variable | Purpose |
| --- | --- |
| `GITHUB_OAUTH_CLIENT_ID` | The OAuth App Client ID you copied. |
| `GITHUB_OAUTH_CLIENT_SECRET` | The OAuth App client secret. Used server-side for the web dashboard's code exchange. |
| `OAUTH_CLI_AUTH_SECRET` | Local random secret the server uses to sign the CLI browser-login authorization codes (auto-generated). |
| `GITHUB_OAUTH_SCOPES` | GitHub scopes requested at sign-in. Defaults to `read:user user:email` (used to read the user's identity and verified email). Override with `--github-oauth-scopes`. |
| `GITHUB_OAUTH_ALLOWED_REDIRECT_URIS` | Optional exact-match allowlist for the web flow's redirect URI. Set to `https://<api-domain>/auth/callback`. |
| `INITIAL_ADMIN_EMAILS` | Set to your `--email`. Lets that email create the admin account on first sign-in under invite-only registration. |

OAuth settings are only written on the initial install. To change them later,
edit `.env.selfhost` and recreate the stack (see [Upgrade](#upgrade)). Setting
a provider client id (`GITHUB_OAUTH_CLIENT_ID` or `BITBUCKET_OAUTH_CLIENT_ID`)
by hand also requires setting `OAUTH_CLI_AUTH_SECRET` (32+ chars), or the
server refuses to start.

The installer mints **no** bootstrap API token. The first admin is created when
the email in `INITIAL_ADMIN_EMAILS` signs in with a configured provider. See
[First admin & inviting members](#first-admin--inviting-members).

#### 3. How users sign in

In the browser, users sign in at the dashboard — see
[Web Dashboard](#web-dashboard). From the terminal:

```bash
cmpatch login --server-url https://updates.example.com
```

The CLI opens the dashboard sign-in in the default browser (printing the URL
as a fallback — `--no-browser` prints it without opening anything). The user
signs in with any configured provider, approves the "Sign in the CLI?" screen,
and the browser hands a short-lived, PKCE-bound sign-in code back to the CLI
over a `127.0.0.1` redirect. The CLI then stores the session in
`~/.codemagic-patch/credentials.json`. An **invited** user gets an account
created automatically on first sign-in. The provider account's email must be
**verified** — sign-in fails otherwise. On machines without a browser
(SSH, CI), use a personal access token instead: `cmpatch login --token`
(see [Machine & CI access](#machine--ci-access)).

> **Access control:** registration is **invite-only by default**. A
> sign-in only creates a new account if that email is in `INITIAL_ADMIN_EMAILS`
> or has a pending team invitation (or already has an account, which links on
> first sign-in). Uninvited users get a 403. Set `REGISTRATION_MODE=open` to
> instead let any user with a verified provider email self-register. This gate applies only to
> self-service sign-in; admins always add people with `member invite` /
> `member provision`.

### Bitbucket sign-in

Bitbucket Cloud can be configured as a second sign-in provider next to GitHub,
or as the only provider. The dashboard login page shows one button per
configured provider ("Continue with
GitHub" / "Continue with Bitbucket"), and either identity resolves to the same
kind of account — invitations, admin emails, and RBAC work identically.
`cmpatch login` signs in through the same dashboard page in the browser, so
Bitbucket users get the CLI signed in the same way — the provider choice
happens on the login page, not in the CLI.

#### 1. Create a Bitbucket OAuth consumer

1. Go to the Bitbucket workspace → **Settings → OAuth consumers → Add
   consumer**.
2. **Name**: anything, for example `Codemagic Patch (self-host)`.
3. **Callback URL**: `https://<api-domain>/auth/callback`, for example
   `https://updates.example.com/auth/callback`.
4. **Permissions**: check **Account: Read** and **Email** — Bitbucket scopes
   live on the consumer, not in the authorize request, so nothing else is
   configured server-side.
5. Save and copy the consumer's **Key** and **Secret**.

> **One consumer per dashboard origin:** Bitbucket matches callback URLs by
> prefix within the single configured URL, so a consumer cannot serve multiple
> dashboard origins. Run a second dashboard origin → create a second consumer.

#### 2. Configure the stack

On a fresh install, pass the consumer credentials to the installer:

```bash
./scripts/selfhost/install.sh \
  ... \
  --bitbucket-oauth-client-id <consumer-key> \
  --bitbucket-oauth-client-secret <consumer-secret>
```

Passing only the Bitbucket flags — no `--github-oauth-*` flags — runs a
**Bitbucket-only** install: the installer skips the interactive GitHub prompts
and writes no `GITHUB_*` variables, and the dashboard shows only the Bitbucket
button.

On an existing stack, add to `.env.selfhost` and recreate the stack (see
[Upgrade](#upgrade)):

```bash
BITBUCKET_OAUTH_CLIENT_ID=<consumer-key>
BITBUCKET_OAUTH_CLIENT_SECRET=<consumer-secret>
BITBUCKET_OAUTH_ALLOWED_REDIRECT_URIS=https://<api-domain>/auth/callback
```

Both values are required together — the server refuses to boot with a client
id but no secret. Any web provider also requires the CLI auth secret the
installer already generates (`OAUTH_CLI_AUTH_SECRET`; older installs carry it
as `OAUTH_DEVICE_POLL_TOKEN_SECRET`, which the server accepts permanently) —
the server refuses to boot without one so `cmpatch login` can never dead-end
after the browser sign-in. The user's
Bitbucket primary email must be **confirmed**; sign-in fails otherwise with a
"confirm the primary email" error.

## Web Dashboard

The stack serves a web dashboard **same-origin on the API domain**, for example
`https://updates.example.com/`. It is bundled into the caddy image —
`deploy/selfhost/Dockerfile.caddy` builds the SPA and Caddy serves it next to
the `/v1` API — so no extra domain, service, or host dependency is needed.

Sign-in shows one button per configured provider (GitHub and/or Bitbucket —
see [Bitbucket sign-in](#bitbucket-sign-in)):
the browser is sent to the provider and redirected back to
`https://<api-domain>/auth/callback`. The first
admin is the email in `INITIAL_ADMIN_EMAILS` (see
[First admin & inviting members](#first-admin--inviting-members)); after that,
admins add further members from the dashboard's **Members** screen (one
**Add member** flow: existing accounts get access immediately, everyone
else on their first sign-in, with an optional show-once API token for machine
accounts) — or with the CLI commands below.

If browser sign-in fails with a misconfiguration error, the web flow is not
fully configured — most commonly the provider's client secret
(`GITHUB_OAUTH_CLIENT_SECRET` / `BITBUCKET_OAUTH_CLIENT_SECRET`) is missing
from `.env.selfhost`, or the OAuth App/consumer lacks the callback URL.

## Install the CLI

The `cmpatch` CLI drives sign-in, app/deployment setup, and releases. Install it
from a clone of this repository:

```bash
yarn install
yarn cli:install-global
```

Run both at the repository root; `cmpatch` is then on your `PATH`. See
[`cli/README.md`](../cli/README.md) for details and how to uninstall.

## CLI login

People sign in with the browser flow (see
[How users sign in](#3-how-users-sign-in) above):

```bash
cmpatch login --server-url https://updates.example.com
```

The session is stored in `~/.codemagic-patch/credentials.json`, so later commands run
without re-authenticating.

For **machine/CI access** you use a personal access token instead of interactive
login — pass it per command via `--token` or the `CODEMAGIC_PATCH_TOKEN` environment
variable, or run `cmpatch login --token cm_pat_...` to store it. See
[Machine & CI access](#machine--ci-access) for how to mint one.

## First admin & inviting members

Registration is invite-only, so accounts are added by invitation rather than
self-service. The lifecycle is:

**1. The first admin signs in.** Because the `--email` you passed is written to
`INITIAL_ADMIN_EMAILS`, that email is allowed past invite-only and its account is
created on first sign-in.

```bash
cmpatch login --server-url https://updates.example.com
```

You **must** use the GitHub or Bitbucket account whose **verified primary email
matches `--email`**. The email must be verified with the provider — sign-in
fails otherwise.

> If you sign in with a different email, you get the invite-only 403 and stay
> locked out (no admin exists yet to invite you). Recover by adding the correct
> email to `INITIAL_ADMIN_EMAILS` in `.env.selfhost` and recreating the stack, or
> temporarily set `REGISTRATION_MODE=open`, sign in, then revert it.

**2. The team already exists.** Self-host provisions a single fixed team on boot
as the fixed `default-team` (the name is not configurable), and your first sign-in makes
you its owner (which grants `iam.manage`, the permission needed to invite). Team
creation, renaming, and deletion are disabled in the CLI and dashboard.

**3. Invite members.** Invite by email, or by GitHub handle if that is all you
know:

```bash
# By email — matches the invitee's verified primary email on first sign-in.
cmpatch member invite \
  --server-url https://updates.example.com \
  --team <team> \
  --email coworker@example.com \
  --role developer

# By GitHub handle — resolved to the account's id at invite time.
cmpatch member invite \
  --server-url https://updates.example.com \
  --team <team> \
  --github-handle coworker-gh \
  --role developer
```

The invitee then runs `cmpatch login` and signs in in the browser: because a
pending invitation matches them (their email, or their GitHub identity for a
handle invite), their account is created and the team role is granted
automatically. Uninvited users are rejected with a 403.

> **Handle invites bind to the account, not the string.** At invite time the
> server resolves the handle to GitHub's immutable numeric user id and stores
> that — so the invite is immune to a later handle rename, and a handle that
> does not exist is rejected (422) up front. The lookup is an unauthenticated
> call to the GitHub API; it needs outbound network access from the server.

Manage pending invitations with:

```bash
cmpatch member invite-list --server-url https://updates.example.com --team <team>
cmpatch member invite-revoke --server-url https://updates.example.com --invitation-id <id>
```

To grant a role to someone who already has an account, use `cmpatch member add`.

## Create your first app and deployment

Before you can wire the SDK or publish an update, create an **app** and read its
**deployment key**. The object model is:

```text
app  →  deployments (Staging, Production)  →  deployment key
```

**1. Create the app.** Creating an app automatically provisions two deployments,
`Staging` and `Production`:

```bash
cmpatch app create --server-url https://updates.example.com --name MyApp
```

The single `default-team` is resolved automatically, so no `--team` is needed.

**2. Read the deployment key.** List the app's deployments to see the key for
each:

```bash
cmpatch deployment list --server-url https://updates.example.com --app MyApp
```

Each row shows its deployment key — the `DEPLOYMENT_KEY` column in the default
table, or the `deployment_key` field under `--format json`. Pick the one for the
deployment you ship to — typically `Staging` while testing, `Production` for the
rollout — and that
string is the `CodemagicPatchDeploymentKey` the SDK needs. It is **not** a secret
and is safe to embed in the app binary. Deployment names match
case-insensitively.

**3. Wire it into the app.** Put the key together with the two installer URLs
into the app's native resources — see [App configuration](#app-configuration)
below and the client [integration guide](../client/README.md) — then publish
your first update in [Publish your first update](#publish-your-first-update).

> Need another environment beyond `Staging`/`Production`? `cmpatch deployment
> create --app MyApp --name <name>` adds one and prints its key.

## App configuration

Point your mobile app at this deployment by setting three native resources
(`strings.xml` on Android, `Info.plist` on iOS — or the Expo config plugin
props). Two of them are the URLs the installer prints when it finishes; the
third — the deployment key — is **not** an installer output. You mint it with the
CLI in [Create your first app and deployment](#create-your-first-app-and-deployment)
above.

| App resource | Value | Where it comes from |
| --- | --- | --- |
| `CodemagicPatchApiUrl` | the API origin (`SERVER_URL`) | installer **Server URL** |
| `CodemagicPatchDownloadBaseUrl` | the artifact origin (`PUBLIC_BASE_URL`, which includes the `/codemagic-patch` prefix) | installer **Public base URL** |
| `CodemagicPatchDeploymentKey` | the deployment key that tells the app which deployment to check for updates | `cmpatch deployment list` — see [Create your first app and deployment](#create-your-first-app-and-deployment) |

Use each value exactly as printed — `CodemagicPatchDownloadBaseUrl` must match
`PUBLIC_BASE_URL` byte-for-byte apart from a trailing slash. The deployment key
is not a secret; it is safe to embed in the app binary. See the client
[integration guide](../client/README.md) and [`PROTOCOL.md`](../PROTOCOL.md)
§Static Delivery Resource Contract for the contract.

## Publish your first update

With the app wired (deployment key + the two URLs) and a build of that binary
installed on a device or simulator, ship a JS-only update — a new JS bundle and
assets, not a native binary — with `release-react`. Run it from the React Native
project root:

```bash
cmpatch release-react \
  --server-url https://updates.example.com \
  --app MyApp \
  --deployment Staging \
  --platform ios
```

`release-react` bundles the app (auto-detecting Metro vs Expo) and uploads the
result. If you omit `--target-binary-version`, the CLI reads it from the native
project; pass it explicitly to target a specific binary version. Useful flags:

- `--rollout-percentage <1-100>` — release to a fraction of devices first.
- `--mandatory` — mark the update as required.
- `--dry-run` — build and validate without publishing.

Releases are processed asynchronously. Confirm one finished — using the label or
release id `release-react` printed — with:

```bash
cmpatch release inspect \
  --server-url https://updates.example.com \
  --app MyApp --deployment Staging --label <label> --wait
```

A device picks up the update only when its installed binary matches the release's
target version **and** fingerprint; a mismatch is a silent no-op rather than an
error. If an update never arrives, `cmpatch doctor --app MyApp --deployment Staging`
diagnoses the mismatch, and `cmpatch fingerprint --platform <ios|android>` prints
the fingerprint the CLI computes for that build. In **CI**, authenticate with a
token instead of interactive login (see
[Machine & CI access](#machine--ci-access)):

```bash
CODEMAGIC_PATCH_TOKEN=cm_pat_... cmpatch release-react \
  --server-url https://updates.example.com \
  --app MyApp --deployment Production --platform android
```

Publishing requires the `release.deploy` permission — the `developer` role or
higher (a `viewer` cannot publish).

## Machine & CI access

People sign in with browser OAuth (GitHub or Bitbucket), but machines (CI
pipelines, scripts, service
accounts) authenticate with a personal access token (`cm_pat_...`). There are
two ways to get one:

**Mint a token for yourself.** After signing in, create a token for
your own use (e.g. for CI or the smoke/upgrade scripts):

```bash
cmpatch token create --server-url https://updates.example.com
```

**Provision a machine/service account.** Any team admin (anyone with
`iam.manage` on the team, such as the team owner) can create a dedicated account
and token in one command:

```bash
cmpatch member provision \
  --server-url https://updates.example.com \
  --team <team> \
  --email ci-bot@example.com \
  --role developer
```

This creates the account, mints an API token, and grants the team role in a
single call, then prints a one-time `cm_pat_...` token. Hand it over a secure
channel — it is shown only once. The token is used with:

```bash
cmpatch login --server-url https://updates.example.com --token cm_pat_...
```

> Use an email **not** tied to a real GitHub or Bitbucket account for service
> accounts. Otherwise the owner of that email could sign in and link to the
> account.

Useful options:

- `--expires-in-days N` — expire the minted token after `N` days (default: no expiry).
- `--display-name <name>` / `--token-display-name <name>` — label the account and token.

`provision` only onboards **brand-new** accounts: because it hands back a usable
token, provisioning an email that already has an account is rejected (`409`) so
nobody can mint a token that impersonates an existing user. To grant a role to
someone who already has an account, use `cmpatch member add`; to revoke access,
remove their role binding with `cmpatch member remove`.

## Smoke

> The smoke check is an internal server self-test, **not** a release example: it
> publishes a synthetic fixture no real device will ever match. To ship a real
> update, use [Publish your first update](#publish-your-first-update).

The installer does not run a smoke check. To verify a publish/artifact round
trip manually, run it yourself with an API token:

```bash
CODEMAGIC_PATCH_TOKEN=cm_pat_... ./scripts/selfhost/smoke.sh
```

The smoke check creates a temporary team/app/deployment, publishes a release,
fetches manifests and bundle URLs through `PUBLIC_BASE_URL`, verifies
`_internal/*` is not anonymously readable, and verifies bucket listing is
denied.

Without `CODEMAGIC_PATCH_TOKEN` the script still runs, but only the unauthenticated
checks: API health, control-plane requests are rejected with 401, `_internal/*`
is not anonymously readable, and bucket listing is denied. The publish round
trip is skipped.

## Backup

Create a manual backup before upgrades or risky changes:

```bash
./scripts/selfhost/backup.sh
```

The backup directory contains:

```text
env.selfhost
postgres.dump
minio-codemagic-patch.tar.gz
versions.txt
```

Backups are written under `backups/` by default and are ignored by git.

## Restore

Restore PostgreSQL and MinIO together from one backup:

```bash
CODEMAGIC_PATCH_TOKEN=cm_pat_... ./scripts/selfhost/restore.sh backups/codemagic-patch-selfhost-<timestamp>
```

The restore command validates the backup shape, asks for explicit confirmation,
replaces the local PostgreSQL and MinIO volumes, starts the stack, checks health,
and runs smoke — the full publish smoke when `CODEMAGIC_PATCH_TOKEN` is provided,
unauthenticated checks only otherwise. A smoke failure at this point means
post-restore validation failed; the volume restore itself has already
completed.

Use `--restore-env` only when you also want to replace the current
`.env.selfhost` with the copy from the backup.

## Upgrade

> **Migrating from a pre-OAuth install:** OAuth sign-in is mandatory — a
> stack that ran with neither `GITHUB_OAUTH_CLIENT_ID` nor
> `BITBUCKET_OAUTH_CLIENT_ID` will refuse to boot after upgrading — and each
> configured provider additionally requires its client secret (the
> confidential web code exchange). The upgrade command checks this before
> touching anything and fails fast when no provider is configured in
> `.env.selfhost`, or when a configured provider's client id is missing its
> secret. Before upgrading, create a GitHub OAuth App or a Bitbucket OAuth
> consumer (callback URL `https://<api-domain>/auth/callback`, client secret
> generated) and add its client id and secret — `GITHUB_OAUTH_CLIENT_ID` /
> `GITHUB_OAUTH_CLIENT_SECRET` or `BITBUCKET_OAUTH_CLIENT_ID` /
> `BITBUCKET_OAUTH_CLIENT_SECRET` — to `.env.selfhost`.
> The other OAuth values migrate automatically: `OAUTH_CLI_AUTH_SECRET`
> is generated if missing (a manually set value must be 32+ chars; an
> existing `OAUTH_DEVICE_POLL_TOKEN_SECRET` keeps working as a permanent
> fallback),
> `INITIAL_ADMIN_EMAILS` is backfilled from `ACME_EMAIL` (the admin email given
> at install time), and `GITHUB_OAUTH_ALLOWED_REDIRECT_URIS` (when GitHub is
> configured) and
> `CODEMAGIC_PATCH_CADDY_IMAGE` are defaulted when missing. Existing API tokens keep
> working, and existing admins link to their provider identity on first sign-in
> (matching email). For the full upgrade smoke, get a `cm_pat_...` token — sign
> in with `cmpatch login`, then run `cmpatch token create`.

Rebuild from the checked-out source tree and recreate the stack:

```bash
./scripts/selfhost/upgrade.sh
```

Move to a specific server image:

```bash
./scripts/selfhost/upgrade.sh ghcr.io/example/codemagic-patch-server:v1.2.3
```

The upgrade command prints the current image, creates a fresh backup unless
`--i-have-a-backup` is passed, updates or rebuilds the server image, recreates
the stack, waits for health, and runs smoke. The caddy (web dashboard) image is
**always rebuilt** from the checked-out source — the dashboard ships inside the
caddy image, so this keeps it in step with the server even when a pinned server
image is pulled, and upgrades never ship a stale dashboard. Set
`CODEMAGIC_PATCH_TOKEN=cm_pat_...` to run the full publish/artifact smoke; without it
only unauthenticated checks run. In automation, make sure the token is actually
set if you rely on the full smoke — a missing token downgrades to the
unauthenticated checks with a warning instead of failing.

Automatic rollback is not built in. To roll back, restore a
known-good backup or set `CODEMAGIC_PATCH_SERVER_IMAGE` in `.env.selfhost` back to a
previous image and rerun the upgrade command. To roll back only the dashboard,
set `CODEMAGIC_PATCH_CADDY_IMAGE` to a previously built image and recreate the stack
(the upgrade command always rebuilds the caddy image from source).

## Reset

The durable self-host state lives in two Compose volumes:

- PostgreSQL data.
- MinIO data.

Do not reset only one of them. The database and object storage represent one
logical deployment state.

## Storage Policy

MinIO is exposed on the storage domain so mobile devices can fetch OTA
artifacts directly. The Compose stack fixes the bucket name to `codemagic-patch`.
The bucket policy allows anonymous `GetObject` for public OTA artifact keys and
denies anonymous reads under `_internal/*`. Bucket listing is not public.

The self-host smoke test treats unsafe `_internal/*` exposure as a failure.

## Optional: front storage with Cloudflare CDN

By default clients fetch artifacts straight from MinIO on the storage domain
(`DELIVERY_ADAPTER=base-url`). You can instead put **Cloudflare CDN** in front of
the storage origin: you proxy the *same* storage domain through Cloudflare, so
`PUBLIC_BASE_URL` is unchanged. On every release the server then purges the edge
cache for the paths that changed, reducing stale-edge risk while preserving the
release worker's best-effort purge semantics.

Only the JSON delivery files need purging — per-hash and fallback
`manifest.json` plus `meta.json`, all served `no-cache, must-revalidate`. Bundle
and patch artifacts are content-addressed (`max-age=1y, immutable`), so a new
release is a new path and never needs invalidation. Purge is best-effort: a
Cloudflare API failure is logged but never blocks a release.

### Enable it at install time

Create a Cloudflare **API Token** scoped to **Zone → Cache Purge** — either a
user-owned token (My Profile → API Tokens → Create Token) or an account-owned
token (*your account* → Manage Account → API Tokens, `cfat_…` format); *not* the
legacy Global API Key — and note the **Zone ID** of the zone holding your
storage domain. Pass them to the installer:

```bash
./scripts/selfhost/install.sh \
  --api-domain updates.example.com \
  --storage-domain storage.updates.example.com \
  --email admin@example.com \
  --github-oauth-client-id Iv1.0123456789abcdef \
  --github-oauth-client-secret <client-secret> \
  --cloudflare \
  --cloudflare-api-token <cf-token> \
  --cloudflare-zone-id <cf-zone-id>
```

The installer verifies the credentials with a harmless no-op URL purge against
the storage domain, confirming the token can actually purge that zone — the same
Zone → Cache Purge permission the server uses, so a correctly scoped token passes
without needing Zone Read, and both user-owned and account-owned tokens work.
`--skip-cloudflare-check` bypasses this,
and `--cloudflare-api-base-url <url>` overrides the API endpoint. The interactive
installer also offers this as a prompt, and passing the credentials alone implies
`--cloudflare`. It writes these to `.env.selfhost`:

| Variable | Purpose |
| --- | --- |
| `DELIVERY_ADAPTER` | `cloudflare` to enable edge purge (default `base-url`). |
| `CLOUDFLARE_API_TOKEN` | Token scoped to Zone → Cache Purge. |
| `CLOUDFLARE_ZONE_ID` | Zone containing the storage domain. |
| `CLOUDFLARE_API_BASE_URL` | Optional API endpoint override. |

### Certificate-ordering caveat

Caddy obtains the storage domain's Let's Encrypt certificate over HTTP, which
fails if Cloudflare already proxies (orange-cloud) that hostname. Keep the
storage domain **DNS-only (grey cloud)** until the install finishes and Caddy has
a certificate, **then switch it to proxied**. The installer prints this reminder
when Cloudflare is enabled.

### Add a Cache Rule

Purge does nothing unless Cloudflare is actually caching the manifest/meta JSON.
After proxying the storage domain, add a Cloudflare **Cache Rule** that makes the
`manifest.json` / `meta.json` paths eligible for caching — for example, a rule
whose expression is `ends_with(http.request.uri.path, "/manifest.json") or
ends_with(http.request.uri.path, "/meta.json")` with the cache status set to
Eligible for cache. Releases then purge exactly those paths automatically.

### Enable it on an existing install

Delivery config — like OAuth sign-in — is only written on the **initial** install;
re-running the installer with `--cloudflare` on an existing `.env.selfhost` is
ignored with a warning. To turn it on later, edit `.env.selfhost` by hand — set
`DELIVERY_ADAPTER=cloudflare` and the `CLOUDFLARE_*` values (see
[`.env.selfhost.example`](../.env.selfhost.example)) — then recreate the stack
with [`./scripts/selfhost/upgrade.sh`](#upgrade). Do the DNS-only → proxied and
Cache Rule steps above as well.
