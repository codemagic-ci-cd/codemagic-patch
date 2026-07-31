# Custom Deployment

> **Status: reference material — not supported in the initial open-source
> release.** The only supported deployment path is
> [`docs/self-hosting-compose.md`](self-hosting-compose.md).

This guide is for operators who want to run Codemagic Patch on their own
platform anyway. It is not a turnkey deployment path; it documents what the
server requires from its runtime so you can operate it yourself: you provide
the platform, reverse proxy, database, object storage, backups, upgrades, and
monitoring.

## Runtime Shape

Run one Codemagic Patch server process in `MODE=all`.

```text
Mobile devices --> public OTA artifact URL
CLI/operators  --> Codemagic Patch server API
Codemagic Patch server --> PostgreSQL
Codemagic Patch server --> object storage
```

Split deployments with separate API and worker services are a work in progress.

## Required Services

- One container or process running the server image in `MODE=all`.
- PostgreSQL for metadata, auth, release state, jobs, audit, and metrics.
- S3-compatible storage or GCS for OTA artifacts.
- A public HTTPS API URL for CLI and control-plane access.
- A public HTTPS artifact base URL for mobile devices.
- A private secret/config mechanism for database credentials, worker secret,
  storage credentials, and the OAuth sign-in settings.
- A backup and restore plan for PostgreSQL and object storage together.

## Required Server Configuration

Set these values in the server runtime environment:

```bash
MODE=all
HOST=0.0.0.0
PORT=3000
RUN_MIGRATIONS=true
DATABASE_URL=postgresql://...
WORKER_SHARED_SECRET=<32+-chars>
STORAGE_ADAPTER=s3
PUBLIC_BASE_URL=https://storage.example.com/codemagic-patch
MANIFEST_CACHE_CONTROL="no-cache, must-revalidate"
```

An OAuth sign-in provider is **required** for `MODE=all`/`MODE=api` — the
server refuses to boot without at least one of GitHub
(`GITHUB_OAUTH_CLIENT_ID`) or Bitbucket (`BITBUCKET_OAUTH_CLIENT_ID`)
configured. For GitHub, create a GitHub OAuth App (Authorization callback URL
`https://<host>/auth/callback`), then set:

```bash
GITHUB_OAUTH_CLIENT_ID=<github-oauth-app-client-id>
GITHUB_OAUTH_CLIENT_SECRET=<github-oauth-app-client-secret>
OAUTH_CLI_AUTH_SECRET=<32+-char-random-secret>
GITHUB_OAUTH_SCOPES="read:user user:email"
INITIAL_ADMIN_EMAILS=admin@example.com
```

Optionally add Bitbucket Cloud as a second dashboard sign-in provider (an
OAuth consumer with callback URL `https://<host>/auth/callback` and the
`account` + `email` scopes set on the consumer; both values are required
together):

```bash
BITBUCKET_OAUTH_CLIENT_ID=<bitbucket-consumer-key>
BITBUCKET_OAUTH_CLIENT_SECRET=<bitbucket-consumer-secret>
```

The built-in team/app/deployment management APIs are part of the `MODE=all`
control-plane surface. People authenticate through browser OAuth sign-in (the
CLI's `cmpatch login` opens the dashboard sign-in and finishes over a
localhost redirect); machines/CI authenticate with DB-backed personal API
tokens (`cm_pat_...`).

For S3-compatible storage, also provide:

```bash
S3_ENDPOINT=https://...
S3_BUCKET=codemagic-patch
S3_REGION=us-east-1
S3_FORCE_PATH_STYLE=true
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
```

For GCS storage, provide the GCS settings supported by the server runtime
instead of the S3 settings:

```bash
STORAGE_ADAPTER=gcs
PUBLIC_BASE_URL=https://storage.googleapis.com/<public-bucket>
GCS_PUBLIC_BUCKET=<public-bucket>
GCS_INTERNAL_BUCKET=<internal-bucket>
```

The GCS runtime uses Application Default Credentials from the deployment
environment.

## Storage Requirements

The artifact base URL in `PUBLIC_BASE_URL` must map to the storage prefix where
the server writes OTA files.

Public device reads must be allowed for OTA artifact paths such as manifests,
bundles, patches, and deployment metadata. Internal staging paths must not be
publicly readable.

At minimum:

- Allow anonymous `GET` for public OTA artifact keys under the configured
  public prefix.
- Deny anonymous reads for `_internal/*`.
- Deny anonymous bucket listing.
- Keep database state and object-storage state backed up as one logical
  deployment.

## Reverse Proxy And TLS

Terminate HTTPS before requests reach the server. The server listens on HTTP
inside the deployment boundary.

You need two public origins:

- API origin, for example `https://updates.example.com`.
- Artifact origin, for example `https://storage.updates.example.com/codemagic-patch`.

In the mobile app, the API origin is the `CodemagicPatchApiUrl` native resource and
the artifact origin is `CodemagicPatchDownloadBaseUrl` (which equals `PUBLIC_BASE_URL`);
see [`PROTOCOL.md`](../PROTOCOL.md) §Static Delivery Resource Contract.

The artifact origin may point directly at object storage, a CDN, or a reverse
proxy in front of object storage. Do not proxy artifact downloads through the
CodemagicPatch API server.

## First admin

There is no token-minting bootstrap step. The single team is provisioned on boot
as the fixed `default-team` (the name is not configurable); team creation is disabled in
the CLI and dashboard. The first admin account is created the first time an email
in `INITIAL_ADMIN_EMAILS` signs in via GitHub OAuth (allowed past invite-only
registration). That email must match the **verified** primary email of the
admin's GitHub account — that first sign-in also makes the admin the team owner.
The admin then mints tokens for CI as needed:

```bash
cmpatch login --server-url https://updates.example.com
cmpatch token create --server-url https://updates.example.com   # for CI/machines
```

If you are migrating from seeded or pre-existing data, grant owner access to the
team that the administrator should operate:

```bash
DATABASE_URL=postgresql://... \
yarn workspace @codemagic/patch-server auth:grant-team-owner \
  --team-id team_abc \
  --email admin@example.com
```

## Smoke Check

Run the same checks the Compose self-host smoke test runs, using your own
tooling. The repository's `scripts/selfhost/smoke.sh` helper is intended for the
Compose self-host path and depends on that local tooling, so custom deployments
should treat it as a reference rather than a ready-to-run command.

Your smoke must prove that:

- the API health check works;
- a release can be published;
- generated manifests and bundle URLs resolve through `PUBLIC_BASE_URL`;
- `_internal/*` is not anonymously readable;
- bucket listing is denied.

## Operations Checklist

- Back up PostgreSQL and object storage before upgrades.
- Restore PostgreSQL and object storage together from the same point in time.
- Keep `WORKER_SHARED_SECRET`, DB credentials, storage credentials, OAuth
  secrets, and API tokens out of logs and source control.
- Run smoke after deploys, restores, storage policy changes, and reverse-proxy
  changes.
- Monitor server health, PostgreSQL capacity, object storage errors, and public
  artifact availability.
- Keep the server and CLI versions aligned during upgrades.

## Not Included

This guide does not provide provider-specific infrastructure modules,
autoscaling, managed database setup, CDN configuration, DNS automation, or
certificate automation. The Pulumi/GCP automation in this repository is
maintainer reference material, not a self-hosting option.
