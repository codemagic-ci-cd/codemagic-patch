# Self-Hosting With Docker Compose

> **Just evaluating?** Don't start here. The [local evaluation
> stack](../README.md#quickstart--try-it-locally) runs the full product —
> dashboard included — on a laptop with one `docker compose` command and
> Docker as the only prerequisite. Deploying for real (this document) additionally needs public
> DNS, open ports 80/443, and an OAuth app on GitHub and/or Bitbucket.

This is the supported deployment path for Codemagic Patch — and in the initial
open-source release, the only one. It runs the Codemagic Patch server as a single
process in `MODE=all` on one Docker host with Caddy for HTTPS. By default the
stack bundles PostgreSQL and MinIO; either can instead be a service you
operate — your own PostgreSQL, and object storage on S3 or GCS — see
[External database and external storage](#external-database-and-external-storage).
Split deployments with separate API and worker services are a work in
progress.

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
- Sizing: at runtime the stack (the server, Caddy, and — with the default
  bundled modes — PostgreSQL and MinIO in one Compose project) fits in roughly
  **2 GB RAM** plus a few GB of disk that grows
  with the OTA artifacts you store. The memory peak is the **first install**,
  which builds the server and dashboard images on the host. The build itself
  fits within 2 GiB (measured peak ~1.6 GiB with both images building in
  parallel), but the OS and Docker daemon share that same memory, so headroom
  on a 2 GB host is thin — if the build is OOM-killed, add a few GB of swap or
  use a larger host, then rerun the installer.
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

The storage record applies to the default **bundled** storage only. With
external object storage (`--storage-mode s3`/`gcs`) there is no storage domain
— devices download from the bucket, or the CDN in front of it — so only the
API record is needed; see
[External database and external storage](#external-database-and-external-storage).

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
**Node.js 22.20+** and **Yarn 4** (via Corepack) — see
[Install the CLI](#install-the-cli). This can be the server host or any dev
machine; the server-host install itself does not need Node.

### Optional: Cloudflare CDN

To serve artifacts through Cloudflare with automatic cache purge on release, also
prepare a Cloudflare **API token** scoped to *Zone → Cache Purge* and the
**Zone ID** of the zone holding your storage domain (with external storage:
the `PUBLIC_BASE_URL` host) — see
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
  --github-oauth-client-id <client-id> \
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
  --github-oauth-client-id <client-id> \
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

## External database and external storage

The Compose stack runs in one of four shapes, selected by two flags in
`.env.selfhost`:

| `SELFHOST_DATABASE_MODE` \ `SELFHOST_STORAGE_MODE` | `bundled` (MinIO in the stack) | `s3` / `gcs` (external bucket) |
| --- | --- | --- |
| `bundled` (Postgres in the stack) | **Default** | Supported |
| `external` (your PostgreSQL) | Supported | Supported |

The two choices are independent. An env file without the flags runs
`bundled` × `bundled`, the shape the rest of this document describes unless
stated otherwise.

Both modes are fixed at install time: re-running the installer with mode flags
against an existing `.env.selfhost` ignores them with a warning, and moving a
live deployment between modes is a manual data migration — see
[Switching modes](#switching-modes).

### Mode flags and compose overlays

The maintenance scripts (`install.sh`, `backup.sh`, `restore.sh`,
`upgrade.sh`) read the flags from `.env.selfhost` and assemble the
`docker compose -f` file list from them. An unrecognized value fails hard
rather than falling back to bundled, since a typo'd flag would otherwise start
an empty bundled Postgres or MinIO alongside an external deployment.

`docker-compose.selfhost.yml` is the base file; the database and the object
storage each ship as a mode overlay in `deploy/selfhost/`:

| Flag value | Overlay merged after the base file |
| --- | --- |
| `SELFHOST_DATABASE_MODE=bundled` (or absent) | `deploy/selfhost/compose.bundled-db.yml` |
| `SELFHOST_DATABASE_MODE=external` | `deploy/selfhost/compose.external-db.yml` |
| `SELFHOST_STORAGE_MODE=bundled` (or absent) | `deploy/selfhost/compose.bundled-storage.yml` |
| `SELFHOST_STORAGE_MODE=s3` | `deploy/selfhost/compose.external-storage-s3.yml` |
| `SELFHOST_STORAGE_MODE=gcs` | `deploy/selfhost/compose.external-storage-gcs.yml` |

Compose commands run by hand need the overlays matching the env file's flags,
with `docker-compose.selfhost.override.yml` last when the deployment uses one.
For the default bundled stack:

```bash
docker compose --project-name codemagic-patch-selfhost --env-file .env.selfhost \
  -f docker-compose.selfhost.yml -f deploy/selfhost/compose.bundled-db.yml \
  -f deploy/selfhost/compose.bundled-storage.yml up -d
```

Omitting the overlays does not fail. The base file alone is a valid Compose
file describing only Caddy and the server, so it starts with no database and
no object storage: the server crash-loops without `DATABASE_URL`, and Caddy —
which waits on the server's health — follows it down. The data volumes are
untouched; rerunning with the overlays recovers the stack. Every command
naming `docker-compose.selfhost.yml` needs one database overlay and one
storage overlay.

### External database

`--database-mode external` connects the server to a PostgreSQL you operate
(for example RDS or Cloud SQL) instead of running one inside the stack.
`--database-url` is required with it and is recorded as `DATABASE_URL` in
`.env.selfhost`; the `POSTGRES_*` variables are then unused and not written.
Migrations run at server boot against that database, so the connecting role
must be allowed to create and alter tables.

```bash
./scripts/selfhost/install.sh \
  --api-domain updates.example.com \
  --storage-domain storage.updates.example.com \
  --email admin@example.com \
  --github-oauth-client-id <client-id> \
  --github-oauth-client-secret <client-secret> \
  --database-mode external \
  --database-url postgresql://user:password@db.example.com:5432/codemagic_patch
```

This example keeps the default bundled storage, so the storage domain still
applies. `--database-mode external` combines with `--storage-mode s3`/`gcs`.

### External object storage

`--storage-mode s3` or `--storage-mode gcs` connects the server to an
object-storage bucket you operate instead of running MinIO inside the stack.
Two things change compared to bundled storage:

- **There is no storage domain.** Caddy serves only the API domain
  (`deploy/selfhost/Caddyfile.api-only`), so the DNS prerequisite shrinks to
  the single API record — devices download artifacts from the bucket (or the
  CDN in front of it), never from this host. `--storage-domain` is rejected
  in these modes.
- **`--public-base-url` is required.** With bundled storage `PUBLIC_BASE_URL`
  is derived from the storage domain; with external storage you set it
  explicitly to the public **https** URL clients download release artifacts
  from — the bucket itself, or the CDN in front of it (see
  [CDN in front of external storage](#cdn-in-front-of-external-storage)). The
  installer rejects non-https values. This URL is embedded into shipped app
  binaries as `CodemagicPatchDownloadBaseUrl` (see
  [App configuration](#app-configuration)); apps already in the field keep
  downloading from the URL they were built with.

#### S3 (`--storage-mode s3`)

`--s3-bucket` is required. The rest is optional: `--s3-region` (the server
defaults to `us-east-1`), `--s3-endpoint` for S3-compatible providers such as
MinIO or R2 (empty means AWS), `--s3-force-path-style true|false` (the server
defaults to `false`), and `--s3-access-key-id` / `--s3-secret-access-key` —
set both, or neither to use the SDK's default credential chain (for example
EC2/ECS instance roles).

```bash
./scripts/selfhost/install.sh \
  --api-domain updates.example.com \
  --email admin@example.com \
  --github-oauth-client-id <client-id> \
  --github-oauth-client-secret <client-secret> \
  --storage-mode s3 \
  --s3-bucket my-ota-bucket \
  --s3-region eu-central-1 \
  --s3-access-key-id <access-key-id> \
  --s3-secret-access-key <secret-access-key> \
  --public-base-url https://my-ota-bucket.s3.eu-central-1.amazonaws.com
```

**Bucket policy.** The bucket serves public OTA artifacts anonymously and
keeps the `_internal/*` staging prefix private.
[`deploy/selfhost/aws-s3-bucket-policy.example.json`](../deploy/selfhost/aws-s3-bucket-policy.example.json)
is an AWS bucket policy with the same semantics as the bundled MinIO policy
([`deploy/selfhost/minio-bucket-policy.json`](../deploy/selfhost/minio-bucket-policy.json)):
anonymous `s3:GetObject` on the bucket's artifact keys, an explicit `Deny`
for everything under `_internal/*`, and no `s3:ListBucket` grant — a listable
bucket exposes every deployment key. Replace `YOUR_BUCKET_NAME` with the
bucket name and `YOUR_AWS_ACCOUNT_ID` with the AWS account the server's
credentials belong to. The `aws:PrincipalAccount` condition on the `Deny` is
required because an AWS bucket-policy `Deny` applies to every principal, not
only anonymous ones; without it the server is denied its own `_internal/*`
staging reads.

**Block Public Access.** For this bucket, turn off `BlockPublicPolicy` (S3
otherwise rejects the policy) and `RestrictPublicBuckets` (S3 otherwise
ignores the public grant, and anonymous downloads fail), and keep
`BlockPublicAcls` and `IgnorePublicAcls` on — the policy grants no ACL-based
access. Account-level settings override bucket-level ones, so both levels must
permit the policy.

**Verify the policy** after applying it and after any later storage change:
anonymous reads under `_internal/*` must be denied, and anonymous bucket
listing must fail.

```bash
# Must print 403 — never 200, and never an object body:
curl -s -o /dev/null -w '%{http_code}\n' \
  "https://YOUR_BUCKET_NAME.s3.<region>.amazonaws.com/_internal/probe"

# Must return AccessDenied — never an XML document listing keys:
curl -s "https://YOUR_BUCKET_NAME.s3.<region>.amazonaws.com/"
```

`scripts/selfhost/smoke.sh` performs the same two checks against the bucket
endpoint directly (the S3 REST endpoint, or `S3_ENDPOINT` when set), and
passes only on an explicit `401`/`403` denial. A `404` fails the check: it
means the probed object merely does not exist in a bucket anonymous readers
can see. The `PUBLIC_BASE_URL` probes run as well, as delivery-path checks
(see [Smoke](#smoke)).

#### GCS (`--storage-mode gcs`)

GCS uses two buckets instead of one bucket with a private prefix:
`--gcs-public-bucket` holds the public OTA artifacts, `--gcs-internal-bucket`
holds internal staging data. Both are required and must differ, since the
public bucket is world-readable and the internal one is not.
`--gcs-credentials-file` (also required) points at a service-account JSON key:
the installer copies it to `<repo root>/gcs-service-account.json`
(gitignored), and the gcs overlay bind-mounts that fixed path into the server
container. The Compose path does not support GCE metadata-server ADC; the
server always authenticates with the mounted key. Other credential mechanisms
require a `docker-compose.selfhost.override.yml`.

```bash
./scripts/selfhost/install.sh \
  --api-domain updates.example.com \
  --email admin@example.com \
  --github-oauth-client-id <client-id> \
  --github-oauth-client-secret <client-secret> \
  --storage-mode gcs \
  --gcs-public-bucket my-ota-public \
  --gcs-internal-bucket my-ota-internal \
  --gcs-credentials-file /path/to/service-account.json \
  --public-base-url https://storage.googleapis.com/my-ota-public
```

**Bucket IAM.** Grant the service account object read/write on both buckets
(for example `roles/storage.objectAdmin` per bucket). Make the public bucket
anonymously readable by granting `allUsers` the
**`roles/storage.legacyObjectReader`** role, which carries object reads
(`storage.objects.get`) only:

```bash
gcloud storage buckets add-iam-policy-binding gs://my-ota-public \
  --member=allUsers --role=roles/storage.legacyObjectReader
```

Do not grant `roles/storage.objectViewer` to `allUsers`: it also includes
`storage.objects.list`, which makes the bucket anonymously listable and
exposes every deployment key. The internal bucket takes no `allUsers` binding
of any kind and is reached only through the mounted service-account key.
Verify the split as with S3: an anonymous read from the internal bucket must
be denied, and anonymous listing of the public bucket
(`curl -s "https://my-ota-public.storage.googleapis.com/"`) must return
`AccessDenied` rather than a key listing. `scripts/selfhost/smoke.sh` probes
both buckets on `storage.googleapis.com` directly and requires an explicit
`401`/`403`; a `404` fails the check, since it means the bucket itself is
anonymously readable.

#### CDN in front of external storage

`--cloudflare` works in every storage mode. With external storage the CDN
fronts the **`PUBLIC_BASE_URL` host** rather than a storage domain on this
host: the installer verifies the purge credentials against that host, and on
every release the server purges the changed manifest/meta paths in the zone
named by `--cloudflare-zone-id`. Pass
`--public-base-url https://<cdn-domain>` — the CDN domain, not the raw bucket
endpoint — and set up the origin per adapter:

- **S3:** name the bucket exactly after the CDN domain (for example a bucket
  named `cdn.example.com`) and create a **proxied** CNAME from
  `cdn.example.com` to the bucket's virtual-hosted-style REST endpoint,
  `cdn.example.com.s3.<region>.amazonaws.com`. Set the zone's SSL/TLS mode to
  **Full**, not Full (strict): the REST endpoint serves a certificate for
  `*.s3.<region>.amazonaws.com`, which does not match a dotted bucket name,
  so strict validation fails. Do not use the S3 *website* endpoint as the
  origin either — it is HTTP-only.
- **GCS:** name the **public** bucket after the CDN domain (domain-named
  buckets require verifying domain ownership with Google) and create a
  **proxied** CNAME from `cdn.example.com` to `c.storage.googleapis.com`.
  SSL/TLS mode **Full** applies for the same certificate-mismatch reason. The
  internal bucket is never fronted.

Caching and purge then behave exactly as in the bundled setup — see
[Optional: front storage with Cloudflare CDN](#optional-front-storage-with-cloudflare-cdn)
for what gets purged, and add the Cache Rule from
[Add a Cache Rule](#add-a-cache-rule) so the `manifest.json` / `meta.json`
paths are actually cached; bundle and patch artifacts are content-addressed
and need no invalidation.

### Backups with external components

`backup.sh` records the deployment's modes in the backup's `backup-manifest`
and dumps **only the bundled components**: `postgres.dump` is written only in
the bundled database mode, `minio-codemagic-patch.tar.gz` only in the bundled
storage mode. External components are covered by your provider's tooling
instead (for example RDS snapshots or point-in-time recovery, bucket
versioning or replication). A coherent restore pairs `restore.sh` (bundled
components) with restoring each external component to the backup's
`created_at` timestamp, recorded in `versions.txt` and named in the backup's
skip warnings. With both components external the backup is configuration-only
— the env file, `backup-manifest`, and `versions.txt`, plus the compose
override and `gcs-service-account.json` when present — and the server keeps
running, since there is nothing to quiesce.

`restore.sh` refuses a backup whose `backup-manifest` modes differ from the
current deployment's flags (see [Switching modes](#switching-modes)). It also
cannot undo a database migration the new server image has already run against
an external database: after a failed upgrade, roll that database back with
your provider's mechanism (for example RDS point-in-time recovery), then
restore the remaining bundled components from the pre-upgrade backup.

The `gcs-service-account.json` key travels with the env file: `backup.sh`
copies it into the backup, and `restore.sh` reinstalls it whenever the
current one is missing (or always, with `--restore-env`).

### Switching modes

The scripts do not switch a deployment between modes: installer reruns ignore
mode flags with a warning, and `restore.sh` refuses cross-mode restores.
Moving an existing deployment onto (or off) an external component is a manual
migration:

1. Take a final backup (`backup.sh`), then stop the stack.
2. **Database:** dump the source database and import it into the target —
   for example `pg_dump -Fc` from the bundled Postgres, `pg_restore` into the
   external server (or the reverse direction).
3. **Storage:** mirror the bucket contents to the target — for example
   `mc mirror`, `aws s3 sync`, or `gcloud storage rsync` — and apply the
   target's bucket policy / IAM described above.
4. Edit `.env.selfhost`: change `SELFHOST_DATABASE_MODE` /
   `SELFHOST_STORAGE_MODE`, and add or remove the variables each mode uses
   (`DATABASE_URL` vs `POSTGRES_*`; `S3_*`/`GCS_*` plus an operator-set
   `PUBLIC_BASE_URL` vs `CODEMAGIC_PATCH_STORAGE_DOMAIN` plus
   `MINIO_ROOT_*`).
5. Restart the stack (`upgrade.sh`, or `docker compose up -d` with the
   matching overlay list).
6. Take a fresh backup immediately (`backup.sh`), so the deployment has a
   restorable backup in its new modes.

Step 6 matters because `restore.sh` refuses any backup whose
`backup-manifest` modes differ from the current flags, with no override flag.
Once step 4 lands, every backup taken before the switch — including backups
with no `backup-manifest`, which count as `bundled` × `bundled` — is no longer
restorable by `restore.sh`. Their `postgres.dump` and
`minio-codemagic-patch.tar.gz` remain ordinary `pg_restore` / `tar` artifacts
for manual recovery.

A storage-mode change also changes `PUBLIC_BASE_URL`. Shipped app binaries
embed it as `CodemagicPatchDownloadBaseUrl`, so apps in the field keep
requesting the old URL; keep that URL serving artifacts until the binaries
built against it are retired.

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
you its owner (which grants `iam.manage`, the permission needed to invite).

**3. Invite members.** Invite by email, or by GitHub handle if that is all you
know. The single `default-team` is resolved automatically, so no team flag is
needed:

```bash
# By email — matches the invitee's verified primary email on first sign-in.
cmpatch member invite \
  --server-url https://updates.example.com \
  --email coworker@example.com \
  --role developer

# By GitHub handle — resolved to the account's id at invite time.
cmpatch member invite \
  --server-url https://updates.example.com \
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
cmpatch member invite-list --server-url https://updates.example.com
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
| `CodemagicPatchDownloadBaseUrl` | the artifact origin (`PUBLIC_BASE_URL`; with bundled storage it ends in `/codemagic-patch`) | installer **Public base URL** |
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

A device looks up updates by deployment key and binary version; it does not send
its native fingerprint during an update check. The fingerprint is a
publication-time safety signal and an input to compatible binary-version
auto-expansion. The CLI blocks publication by default when its computed
fingerprint disagrees with the value already recorded for the explicit target
binary version. If a developer approves that disagreement, the release still
targets that binary version and can be delivered to its devices.

If an update never arrives, `cmpatch doctor --app MyApp --deployment Staging`
checks the local and deployment configuration, and
`cmpatch fingerprint --platform <ios|android>` prints the fingerprint the CLI
computes for the project. In **CI**, authenticate with a token instead of
interactive login (see
[Machine & CI access](#machine--ci-access)):

```bash
CODEMAGIC_PATCH_TOKEN=cm_pat_... cmpatch release-react \
  --server-url https://updates.example.com \
  --app MyApp --deployment Production --platform android --yes
```

CI, JSON output, `--non-interactive`, and `--yes` never approve a fingerprint
disagreement automatically. After independently verifying native compatibility,
pass `--allow-fingerprint-mismatch` to make that override explicit.

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
cmpatch token create --server-url https://updates.example.com --name <token-name>
```

**Provision a machine/service account.** Any team admin (anyone with
`iam.manage` on the team, such as the team owner) can create a dedicated account
and token in one command:

```bash
cmpatch member provision \
  --server-url https://updates.example.com \
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

The smoke check reuses the bootstrap `default-team` and a fixed app named
`selfhost-smoke` (created on first run and kept — nothing temporary is created
or deleted) with its `Staging` deployment, publishes a release, fetches
manifests and bundle URLs through `PUBLIC_BASE_URL`, verifies `_internal/*` is
not anonymously readable, and verifies bucket listing is denied.

Without `CODEMAGIC_PATCH_TOKEN` the script still runs, but only the unauthenticated
checks: API health, control-plane requests are rejected with 401, `_internal/*`
is not anonymously readable, and bucket listing is denied. The publish round
trip is skipped.

## Backup

Create a manual backup before upgrades or risky changes:

```bash
./scripts/selfhost/backup.sh
```

Note that the backup stops the server container while the dump runs to
quiesce writes and restarts it when done — expect a short API outage. The
upgrade script runs a backup first, so the same applies at the start of every
upgrade. (With both the database and storage external there is nothing to
dump: the backup is configuration-only and the server keeps running.)

The backup directory contains:

```text
env.selfhost
backup-manifest               (records the deployment's database/storage modes)
versions.txt                  (its created_at= line is the point-in-time anchor)
postgres.dump                 (bundled database mode only)
minio-codemagic-patch.tar.gz  (bundled storage mode only)
```

Deployments that use a `docker-compose.selfhost.override.yml` get that file
copied into the backup as well, as is `gcs-service-account.json` when present.
External components are never dumped — see
[Backups with external components](#backups-with-external-components).
Backups are written under `backups/` by default and are ignored by git.

## Restore

Restore the bundled components of one backup together:

```bash
CODEMAGIC_PATCH_TOKEN=cm_pat_... ./scripts/selfhost/restore.sh backups/codemagic-patch-selfhost-<timestamp>
```

The restore command validates the backup shape, asks for explicit confirmation,
replaces the local data volumes the backup's `backup-manifest` covers (both
PostgreSQL and MinIO in the default bundled modes), starts the stack, checks health,
and runs smoke — the full publish smoke when `CODEMAGIC_PATCH_TOKEN` is provided,
unauthenticated checks only otherwise. A smoke failure at this point means
post-restore validation failed; the volume restore itself has already
completed.

Use `--restore-env` only when you also want to replace the current
`.env.selfhost` with the copy from the backup.

A backup taken from a deployment with different mode flags is refused — see
[Switching modes](#switching-modes) — and external components are not
restored by this script: bring each one back to the backup's `created_at`
timestamp with your provider's tooling, as described in
[Backups with external components](#backups-with-external-components).

## Upgrade

> **Check your own compose invocations first.** The upgrade command assembles
> the compose file list itself, and an `.env.selfhost` without the
> `SELFHOST_*_MODE` flags keeps running the default bundled stack. Runbooks,
> monitoring checks, and automation that call
> `docker compose ... -f docker-compose.selfhost.yml` directly must pass the
> mode overlays themselves, or they bring up a stack with no database and no
> object storage. See
> [Mode flags and compose overlays](#mode-flags-and-compose-overlays).

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

With the default bundled modes, the durable self-host state lives in two
Compose volumes:

- PostgreSQL data.
- MinIO data.

An external database or external storage keeps the corresponding state with
your provider instead; reset it there. Do not reset only one of the two
components. The database and object storage represent one logical deployment
state.

## Storage Policy

With the bundled storage, MinIO is exposed on the storage domain so mobile
devices can fetch OTA artifacts directly. The Compose stack fixes the bucket
name to `codemagic-patch`. The bucket policy allows anonymous `GetObject` for
public OTA artifact keys and denies anonymous reads under `_internal/*`.
Bucket listing is not public.

External storage modes must uphold the same policy on the operator's bucket —
see the bucket policy and IAM guidance in
[External database and external storage](#external-database-and-external-storage).

The self-host smoke test treats unsafe `_internal/*` exposure as a failure.

## Optional: front storage with Cloudflare CDN

With the bundled storage, clients by default fetch artifacts straight from
MinIO on the storage domain (`DELIVERY_ADAPTER=base-url`). You can instead put
**Cloudflare CDN** in front of the storage origin: you proxy the *same*
storage domain through Cloudflare, so `PUBLIC_BASE_URL` is unchanged. On every
release the server then purges the edge cache for the paths that changed,
reducing stale-edge risk while preserving the release worker's best-effort
purge semantics. (For a CDN over **external** storage — where there is no
storage domain — see
[CDN in front of external storage](#cdn-in-front-of-external-storage); the
Cache Rule guidance below applies to both.)

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
  --github-oauth-client-id <client-id> \
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
