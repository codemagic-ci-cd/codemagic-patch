# `@codemagic/patch-server`

Control-plane server for Codemagic Patch.

This package owns the API surface, release orchestration, and worker execution
path that produces OTA artifacts for the data plane. Supported self-hosting
runs API routes and worker logic together in `MODE=all`. Split deployments with
separate API and worker services are a work in progress.

## Requirements

- Node.js `>= 22.20.0`
- Yarn `4.12.0` via Corepack
- Docker Desktop or another local Docker runtime for Postgres-backed tests

The minimum Node version is declared via the `engines` field in the root `package.json`; Yarn is pinned via Corepack (the `packageManager` field). The published Docker images build on a fixed `node:22.20.0-alpine` base for reproducibility.

## Deployment Guides

For deployment, see [`docs/self-hosting-compose.md`](../docs/self-hosting-compose.md) —
the only supported path in the initial open-source release. Operators bringing
their own platform can consult the unsupported reference at
[`docs/custom-deployment.md`](../docs/custom-deployment.md).

## Install

From the repository root:

```bash
corepack enable
yarn install
```

## Run The Server Locally

API-capable modes (`MODE=all` and `MODE=api`) **require GitHub OAuth** — the
server refuses to boot without `GITHUB_OAUTH_CLIENT_ID`. Run Postgres, then start
the server with the OAuth env configured. From the repository root:

```bash
DATABASE_URL=postgresql://codemagic_patch:codemagic_patch@127.0.0.1:55432/codemagic_patch_test \
WORKER_SHARED_SECRET=replace-with-at-least-32-characters \
GITHUB_OAUTH_CLIENT_ID=<github-oauth-app-client-id> \
GITHUB_OAUTH_CLIENT_SECRET=<github-oauth-app-client-secret> \
OAUTH_CLI_AUTH_SECRET=<32+-char-random-secret> \
INITIAL_ADMIN_EMAILS=admin@example.com \
yarn workspace @codemagic/patch-server dev
```

Runtime defaults:

- `MODE=all`
- `HOST=0.0.0.0`
- `PORT=3000`
- `LOGGER=true`

### Health Endpoints

API-capable modes (`MODE=all` and `MODE=api`) expose two unauthenticated
health routes:

- `GET /health` — liveness. Always returns `200` with `{ "ok": true, "mode": "<mode>" }`
  while the process is up; it checks no dependencies, so container healthchecks
  and restart policies do not flap on transient database hiccups.
- `GET /health/ready` — readiness. Runs a time-bounded `SELECT 1` against
  Postgres and returns `200` with `{ "ok": true, "mode": "<mode>", "checks": { "db": "ok" } }`
  when the database is reachable, or `503` with `"db": "error"` otherwise. Use
  this for load-balancer/Kubernetes readiness probes. Like `/health`, the route
  is unauthenticated; it reveals only database up/down state.

`MODE=all` exposes registered `/v1` control-plane routes. People authenticate
through **browser OAuth sign-in** (the dashboard and `cmpatch login` share
it); machines/CI authenticate with personal
API tokens (`cm_pat_...`) stored as one-way hashes in Postgres and sent as
`Authorization: Bearer <token>`. `WORKER_SHARED_SECRET` must be non-empty after
trimming and at least 32 characters long when worker capabilities are enabled in
`MODE=all`.

The GitHub OAuth app needs an **Authorization callback URL**
(`https://<host>/auth/callback`) and a client secret. `GITHUB_OAUTH_SCOPES`
defaults to `read:user user:email`; `GITHUB_OAUTH_BASE_URL` and
`GITHUB_API_BASE_URL` default to GitHub.com. For custom deployments, provide the
same environment variables through your platform's secret/config system.

### First admin

There is no token-minting bootstrap step. The single team is provisioned on boot
as the fixed `default-team` (the name is not configurable); team creation is removed from
the CLI and dashboard. The first admin account is created the first time an email
listed in `INITIAL_ADMIN_EMAILS` signs in via GitHub OAuth (it is allowed past
invite-only registration). That email must match the **verified** primary email
of the admin's GitHub account — that first sign-in also makes the admin the
team's owner:

```bash
cmpatch login --server-url http://localhost:3000
```

To grant an existing user owner access to an already-seeded or internally created
team, the resource-level grant command still exists:

```bash
DATABASE_URL=postgresql://codemagic_patch:codemagic_patch@127.0.0.1:55432/codemagic_patch_test \
yarn workspace @codemagic/patch-server auth:grant-team-owner \
  --team-id team_abc \
  --email admin@example.com
```

Useful variants:

```bash
PORT=4000 DATABASE_URL=postgresql://codemagic_patch:codemagic_patch@127.0.0.1:55432/codemagic_patch_test WORKER_SHARED_SECRET=replace-with-at-least-32-characters yarn workspace @codemagic/patch-server dev
LOGGER=false DATABASE_URL=postgresql://codemagic_patch:codemagic_patch@127.0.0.1:55432/codemagic_patch_test WORKER_SHARED_SECRET=replace-with-at-least-32-characters yarn workspace @codemagic/patch-server dev
```

Team/app/deployment management handlers are part of the API-capable runtime. In
the supported auth path, user-backed principals get owner membership on new
teams and route access is filtered by membership/RBAC.

Example release read:

```bash
curl -H "Authorization: Bearer ${CODEMAGIC_PATCH_TOKEN}" \
  http://127.0.0.1:3000/v1/releases/rel_123
```

Example release history:

```bash
curl -H "Authorization: Bearer ${CODEMAGIC_PATCH_TOKEN}" \
  "http://127.0.0.1:3000/v1/deployments/dpl_123/releases?limit=50&offset=0"
```

The release-history API currently supports `limit` and `offset` only. Metrics
inline expansion is deferred until metrics ingest exists, so `include=metrics`
returns a field-level `400 validation-error`.

Example team creation:

```bash
curl -X POST http://127.0.0.1:3000/v1/teams \
  -H "Authorization: Bearer ${CODEMAGIC_PATCH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"name":"example-team"}'
```

Example API token creation for the authenticated user:

```bash
curl -X POST http://127.0.0.1:3000/v1/auth/tokens \
  -H "Authorization: Bearer ${CODEMAGIC_PATCH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"display_name":"ci-main","expires_in_days":90}'
```

OTA manifest and download URLs are data-plane download URLs (object storage, optionally fronted by a CDN). They are
not protected by control-plane bearer tokens. Current user auth supports
DB-backed personal API tokens and OAuth session access tokens. The built-in
provider paths are GitHub and Bitbucket browser sign-in (shared by the
dashboard and `cmpatch login`); full user administration remains deferred.

## Run Tests

### Fast Path

Run the full server test suite:

```bash
yarn workspace @codemagic/patch-server test
```

Run only the database-focused test slice when `TEST_DATABASE_URL` is already set:

```bash
yarn workspace @codemagic/patch-server test:db
```

### Local Environment For All Server Tests

Some server tests use PostgreSQL. The repository includes a dedicated local test
database compose file at [`server/docker-compose.test.yml`](docker-compose.test.yml).

Default local test database settings:

- host: `127.0.0.1`
- port: `55432`
- database: `codemagic_patch_test`
- user: `codemagic_patch`
- password: `codemagic_patch`

Connection string:

```text
postgresql://codemagic_patch:codemagic_patch@127.0.0.1:55432/codemagic_patch_test
```

Recommended workflow:

```bash
yarn workspace @codemagic/patch-server db:test:up
yarn workspace @codemagic/patch-server s3:test:up
yarn workspace @codemagic/patch-server test:db:local
yarn workspace @codemagic/patch-server test:artifact-gate:local
yarn workspace @codemagic/patch-server test:full:local
```

Helpful companion commands:

```bash
yarn workspace @codemagic/patch-server db:test:logs
yarn workspace @codemagic/patch-server db:test:down
```

Notes:

- `test:db:local` hardcodes the local Docker Compose connection string above.
- `test:local` runs the full server suite with that same local Postgres connection string.
- The test helper creates a unique schema per run, so the same local database can be reused across repeated test executions.

## Storage Adapters

The server selects an object storage backend at boot via the `STORAGE_ADAPTER` environment variable.

| Value              | Description                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| `memory` (default) | In-memory map. Loses all data on restart. Suitable for tests and quick local exploration.                |
| `s3`               | S3-compatible backend (AWS S3, MinIO, Cloudflare R2, etc.). Requires `S3_*` environment variables below. |
| `gcs`              | Native Google Cloud Storage backend. Requires public/internal GCS buckets and Application Default Credentials. |

When `STORAGE_ADAPTER=s3` is set:

| Variable                 | Required | Default                     | Notes                                                                                                                                                                              |
| ------------------------ | -------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_BASE_URL`        | yes      | —                           | Client-facing base URL for public artifact keys. Required for `s3` because the API server does not serve OTA artifacts.                                                            |
| `S3_BUCKET`              | yes      | —                           | Bucket holding both staging and published artifacts.                                                                                                                               |
| `S3_REGION`              | no       | `us-east-1`                 | AWS region or any region literal accepted by the backend. MinIO ignores it.                                                                                                        |
| `S3_ENDPOINT`            | no       | —                           | Custom endpoint URL. Required for MinIO / R2 / non-AWS backends.                                                                                                                   |
| `S3_FORCE_PATH_STYLE`    | no       | `false`                     | Set to `true` for MinIO and other backends without virtual-host-style addressing.                                                                                                  |
| `S3_ACCESS_KEY_ID`       | no       | —                           | Static access key. Set together with `S3_SECRET_ACCESS_KEY` or omit both to use the AWS SDK's default credential chain. The server refuses to start if only one of the two is set. |
| `S3_SECRET_ACCESS_KEY`   | no       | —                           | Static secret key. Must be set together with `S3_ACCESS_KEY_ID`.                                                                                                                   |
| `MANIFEST_CACHE_CONTROL` | no       | `no-cache, must-revalidate` | Cache policy applied to mutable `manifest.json` and `meta.json` uploads.                                                                                                           |

Example (MinIO running on `localhost:9000`):

```bash
STORAGE_ADAPTER=s3 \
PUBLIC_BASE_URL=http://localhost:9000/codemagic-patch \
S3_ENDPOINT=http://localhost:9000 \
S3_BUCKET=codemagic-patch \
S3_FORCE_PATH_STYLE=true \
S3_ACCESS_KEY_ID=minio \
S3_SECRET_ACCESS_KEY=minio12345 \
yarn workspace @codemagic/patch-server dev
```

When `STORAGE_ADAPTER=gcs` is set:

| Variable                 | Required | Default                     | Notes                                                                                                                                                 |
| ------------------------ | -------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_BASE_URL`        | yes      | —                           | Client-facing base URL for public artifact keys. For direct GCS delivery, use `https://storage.googleapis.com/<public-bucket>`.                       |
| `GCS_PUBLIC_BUCKET`      | yes      | —                           | Bucket for public OTA manifests, bundles, patches, and `meta.json`.                                                                                   |
| `GCS_INTERNAL_BUCKET`    | yes      | —                           | Bucket for `_internal/*` upload staging and worker-private artifacts. Must differ from `GCS_PUBLIC_BUCKET`.                                            |
| `MANIFEST_CACHE_CONTROL` | no       | `no-cache, must-revalidate` | Cache policy applied to mutable `manifest.json` and `meta.json` uploads.                                                                              |

The GCS adapter uses the native `@google-cloud/storage` client and Application
Default Credentials. On GCP this normally means the Compute Engine service
account; locally use `GOOGLE_APPLICATION_CREDENTIALS` or `gcloud auth
application-default login` for manual GCS runs.

Example (direct GCS delivery for a custom or maintainer-operated deployment):

```bash
STORAGE_ADAPTER=gcs \
PUBLIC_BASE_URL=https://storage.googleapis.com/codemagic-patch-public \
GCS_PUBLIC_BUCKET=codemagic-patch-public \
GCS_INTERNAL_BUCKET=codemagic-patch-internal \
yarn workspace @codemagic/patch-server dev
```

### Serving artifacts from object storage

Object storage adapters only handle object persistence. The URL surfaced in
client manifests is still produced by `DeliveryAdapter`, which currently
concatenates `PUBLIC_BASE_URL` with the raw storage key. `PUBLIC_BASE_URL` is
required for S3/GCS-backed runtimes because the API server does not serve
manifests or artifacts.

For S3-compatible single-bucket deployments, two operational concerns still
matter before pointing clients at a real S3 / MinIO deployment:

1. **`_internal/` keys must not be reachable through `PUBLIC_BASE_URL`.** The bucket holds both public release artifacts (`{deployment_key}/{binary_version}/...`) and private staging / worker-internal objects under `_internal/`. Exposing the bucket root directly leaks those internal objects. Use one of:
   - a reverse proxy in front of the bucket that only forwards public-prefix paths and rejects `_internal/*`, or
   - a bucket policy / CDN rule that explicitly denies anonymous reads under `_internal/*` (recommended; example below).
2. **Mutable JSON cache behavior is explicit but conservative by default.** The worker uploads `manifest.json` and `meta.json` with `Cache-Control: no-cache, must-revalidate` unless `MANIFEST_CACHE_CONTROL` overrides it. If you put a CDN in front of object storage, choose a short mutable-object TTL that matches your purge behavior.

For GCS, the intended safety boundary is two buckets: `GCS_PUBLIC_BUCKET`
receives only public OTA keys, while `GCS_INTERNAL_BUCKET` receives `_internal/*`
staging and worker-private keys. Point `PUBLIC_BASE_URL` at the public bucket
only, and grant anonymous object reads only there if direct public bucket
delivery is desired.

#### Recommended bucket policy (option 1.b)

The dev stack at [`docker-compose.dev.yml`](../docker-compose.dev.yml) ships a working reference at [`examples/local-dev/minio-bucket-policy.json`](../examples/local-dev/minio-bucket-policy.json). That file hard-codes the literal bucket name `codemagic-patch` because that is what the dev compose creates; **for any other bucket you must replace `codemagic-patch` in both `Resource` ARNs before applying** (or use the parametrized template below). The same policy shape works on AWS S3, MinIO, Cloudflare R2, and any backend that evaluates IAM-style policies; the explicit `Deny` wins over the broader `Allow` for overlapping resources, so `_internal/*` stays private even when the bucket root is anonymously readable:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowPublicReadOnPublicArtifacts",
      "Effect": "Allow",
      "Principal": "*",
      "Action": ["s3:GetObject"],
      "Resource": ["arn:aws:s3:::<bucket>/*"]
    },
    {
      "Sid": "DenyPublicReadOnInternalPrefix",
      "Effect": "Deny",
      "Principal": "*",
      "Action": ["s3:GetObject"],
      "Resource": ["arn:aws:s3:::<bucket>/_internal/*"]
    }
  ]
}
```

Replace `<bucket>` with the value of `S3_BUCKET`. Apply with whichever tool the backend uses — `aws s3api put-bucket-policy`, MinIO's `mc anonymous set-json`, or your CDN's equivalent.

The cache-header default is intentionally conservative for direct object-storage deployments. High-traffic CDN deployments can set `MANIFEST_CACHE_CONTROL` to a short positive TTL such as `public, max-age=60, must-revalidate` after validating their purge behavior.

### Running The Adapter Test Slice

The fake-backed GCS adapter tests require no live credentials:

```bash
yarn workspace @codemagic/patch-server test test/adapters/gcs-storage.test.ts
```

The S3 adapter tests are skipped when no S3 credentials are exported:

```bash
TEST_S3_ENDPOINT=http://localhost:9000 \
TEST_S3_BUCKET=codemagic-patch-test \
TEST_S3_ACCESS_KEY_ID=minio \
TEST_S3_SECRET_ACCESS_KEY=minio12345 \
yarn workspace @codemagic/patch-server test test/adapters/s3-storage.test.ts
```

A throwaway MinIO container suitable for local runs:

```bash
docker run --rm -d -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=minio \
  -e MINIO_ROOT_PASSWORD=minio12345 \
  quay.io/minio/minio server /data --console-address ":9001"

mc alias set local http://localhost:9000 minio minio12345
mc mb --ignore-existing local/codemagic-patch-test
```

To run the artifact correctness gate without DB/S3 skips, including
`test/delivery/public-path.e2e.test.ts`, run
`yarn workspace @codemagic/patch-server test:artifact-gate:local`. To run the broader
server suite with DB/S3-backed tests enabled, run
`yarn workspace @codemagic/patch-server test:full:local`.

## Common Commands

From the repository root:

```bash
yarn workspace @codemagic/patch-server build
yarn workspace @codemagic/patch-server lint
yarn workspace @codemagic/patch-server typecheck
yarn workspace @codemagic/patch-server test
yarn workspace @codemagic/patch-server test:artifact-gate:local
yarn workspace @codemagic/patch-server test:full:local
```
