#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/selfhost/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

API_DOMAIN="${CODEMAGIC_PATCH_API_DOMAIN:-}"
STORAGE_DOMAIN="${CODEMAGIC_PATCH_STORAGE_DOMAIN:-}"
ADMIN_EMAIL="${ACME_EMAIL:-}"
GITHUB_OAUTH_CLIENT_ID="${GITHUB_OAUTH_CLIENT_ID:-}"
GITHUB_OAUTH_CLIENT_SECRET="${GITHUB_OAUTH_CLIENT_SECRET:-}"
GITHUB_OAUTH_SCOPES="${GITHUB_OAUTH_SCOPES:-}"
BITBUCKET_OAUTH_CLIENT_ID="${BITBUCKET_OAUTH_CLIENT_ID:-}"
BITBUCKET_OAUTH_CLIENT_SECRET="${BITBUCKET_OAUTH_CLIENT_SECRET:-}"
CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"
CLOUDFLARE_ZONE_ID="${CLOUDFLARE_ZONE_ID:-}"
CLOUDFLARE_API_BASE_URL="${CLOUDFLARE_API_BASE_URL:-}"
# Empty means "not given": prompt_database/prompt_storage resolve the defaults
# (bundled) after the interactive prompts have had their chance, and the reuse
# path uses emptiness to detect flags that must be warned about and ignored.
DATABASE_MODE="${SELFHOST_DATABASE_MODE:-}"
DATABASE_URL="${DATABASE_URL:-}"
STORAGE_MODE="${SELFHOST_STORAGE_MODE:-}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-}"
S3_BUCKET="${S3_BUCKET:-}"
S3_REGION="${S3_REGION:-}"
S3_ENDPOINT="${S3_ENDPOINT:-}"
S3_FORCE_PATH_STYLE="${S3_FORCE_PATH_STYLE:-}"
S3_ACCESS_KEY_ID="${S3_ACCESS_KEY_ID:-}"
S3_SECRET_ACCESS_KEY="${S3_SECRET_ACCESS_KEY:-}"
GCS_PUBLIC_BUCKET="${GCS_PUBLIC_BUCKET:-}"
GCS_INTERNAL_BUCKET="${GCS_INTERNAL_BUCKET:-}"
GCS_CREDENTIALS_FILE="${GCS_CREDENTIALS_FILE:-}"
USE_CLOUDFLARE=0
case "${CLOUDFLARE_ENABLED:-}" in
  1 | true | yes) USE_CLOUDFLARE=1 ;;
esac
SKIP_CLOUDFLARE_CHECK=0
ASSUME_YES=0
SKIP_PUBLIC_CHECK=0

usage() {
  cat <<'USAGE'
Usage: scripts/selfhost/install.sh [options]

Prerequisites: a public DNS A/AAAA record for the API domain (and, with the
default bundled storage, the storage domain) pointing at this host, ports
80/443 open to the internet (Let's Encrypt), and at least one
OAuth sign-in provider — a GitHub OAuth App and/or a Bitbucket OAuth
consumer. Create it (with Authorization callback URL
https://<api-domain>/auth/callback) before running, and pass its client ID
and a generated client secret. The admin signs in via the web dashboard or
`cmpatch login`; the first sign-in by --email creates the admin account.

Options:
  --api-domain <domain>        Public API domain, for example updates.example.com.
  --storage-domain <domain>    Public storage domain for the bundled MinIO,
                               for example storage.updates.example.com.
                               Bundled storage only; rejected with
                               --storage-mode s3/gcs (external storage has
                               no storage domain).
  --email <email>              Admin and ACME email. Must match the verified
                               primary email of the admin's GitHub or
                               Bitbucket account.
  --github-oauth-client-id <id>
                               GitHub OAuth App Client ID. Required unless
                               Bitbucket OAuth is configured instead.
  --github-oauth-client-secret <secret>
                               GitHub OAuth App client secret — generate one
                               on the same OAuth App; required together with
                               the client ID (the web dashboard needs it).
  --github-oauth-scopes <s>    OAuth scopes (default: read:user user:email).
  --bitbucket-oauth-client-id <key>
                               Bitbucket OAuth consumer key — adds
                               "Continue with Bitbucket" to the dashboard,
                               or serves as the sole provider when GitHub
                               OAuth is not configured.
                               Requires --bitbucket-oauth-client-secret.
  --bitbucket-oauth-client-secret <secret>
                               OPTIONAL. Bitbucket OAuth consumer secret. The
                               consumer needs callback URL
                               https://<api-domain>/auth/callback and the
                               account + email scopes (set on the consumer).
  --database-mode <mode>       bundled (default) runs Postgres inside the
                               stack; external connects the server to an
                               existing PostgreSQL via --database-url. Fixed
                               at install time — switching later is a manual
                               migration the scripts do not perform.
  --database-url <url>         PostgreSQL connection URL, for example
                               postgresql://user:password@host:5432/db.
                               Required with --database-mode external;
                               rejected with the bundled database.
  --storage-mode <mode>        bundled (default) runs MinIO inside the stack
                               behind the storage domain; s3 or gcs connect
                               the server to an existing object-storage
                               bucket instead (no MinIO, no storage domain).
                               Fixed at install time — switching later is a
                               manual migration the scripts do not perform.
  --public-base-url <url>      Public https URL clients download release
                               artifacts from — the bucket, or the CDN in
                               front of it — for example
                               https://cdn.example.com/codemagic-patch.
                               Required with --storage-mode s3/gcs; rejected
                               with bundled storage (there it is derived
                               from the storage domain).
  --s3-bucket <name>           S3 bucket name (required with --storage-mode s3).
  --s3-region <region>         S3 region (optional; the server defaults to
                               us-east-1).
  --s3-endpoint <url>          S3 endpoint URL for S3-compatible providers
                               such as MinIO or R2 (optional; empty = AWS).
  --s3-force-path-style <bool> Use path-style S3 addressing, true or false
                               (optional; the server defaults to false).
  --s3-access-key-id <id>      S3 access key id. Set together with
                               --s3-secret-access-key, or omit both to use
                               the SDK's default credential chain (e.g.
                               EC2/ECS instance roles).
  --s3-secret-access-key <secret>
                               S3 secret access key (see --s3-access-key-id).
  --gcs-public-bucket <name>   GCS bucket for public release artifacts
                               (required with --storage-mode gcs).
  --gcs-internal-bucket <name> GCS bucket for internal artifacts (required
                               with --storage-mode gcs; must differ from the
                               public bucket).
  --gcs-credentials-file <path>
                               GCS service-account JSON key file; copied to
                               <repo root>/gcs-service-account.json and
                               mounted into the server container (required
                               with --storage-mode gcs). GCE metadata-server
                               ADC is not supported by the Compose path; a
                               docker-compose.selfhost.override.yml is the
                               escape hatch.
  --cloudflare                 Front the storage domain (or, with external
                               storage, the PUBLIC_BASE_URL host) with
                               Cloudflare CDN and purge the edge cache after
                               each release.
  --cloudflare-api-token <t>   Cloudflare API Token scoped to Zone > Cache Purge
                               — an API Token, not the Global API Key
                               (required with --cloudflare).
  --cloudflare-zone-id <id>    Cloudflare zone id containing the CDN domain
                               (required with --cloudflare).
  --cloudflare-api-base-url <url>
                               Cloudflare API base URL override (optional).
  --skip-cloudflare-check      Do not verify the Cloudflare token/zone via the API.
  --skip-public-check          Do not wait for public HTTPS DNS/TLS readiness.
  -y, --yes                    Use defaults for non-destructive prompts.
  -h, --help                   Show this help.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --api-domain) API_DOMAIN="${2:-}"; shift 2 ;;
    --storage-domain) STORAGE_DOMAIN="${2:-}"; shift 2 ;;
    --email) ADMIN_EMAIL="${2:-}"; shift 2 ;;
    --github-oauth-client-id) GITHUB_OAUTH_CLIENT_ID="${2:-}"; shift 2 ;;
    --github-oauth-client-secret) GITHUB_OAUTH_CLIENT_SECRET="${2:-}"; shift 2 ;;
    --github-oauth-scopes) GITHUB_OAUTH_SCOPES="${2:-}"; shift 2 ;;
    --bitbucket-oauth-client-id) BITBUCKET_OAUTH_CLIENT_ID="${2:-}"; shift 2 ;;
    --bitbucket-oauth-client-secret) BITBUCKET_OAUTH_CLIENT_SECRET="${2:-}"; shift 2 ;;
    --database-mode) DATABASE_MODE="${2:-}"; shift 2 ;;
    --database-url) DATABASE_URL="${2:-}"; shift 2 ;;
    --storage-mode) STORAGE_MODE="${2:-}"; shift 2 ;;
    --public-base-url) PUBLIC_BASE_URL="${2:-}"; shift 2 ;;
    --s3-bucket) S3_BUCKET="${2:-}"; shift 2 ;;
    --s3-region) S3_REGION="${2:-}"; shift 2 ;;
    --s3-endpoint) S3_ENDPOINT="${2:-}"; shift 2 ;;
    --s3-force-path-style) S3_FORCE_PATH_STYLE="${2:-}"; shift 2 ;;
    --s3-access-key-id) S3_ACCESS_KEY_ID="${2:-}"; shift 2 ;;
    --s3-secret-access-key) S3_SECRET_ACCESS_KEY="${2:-}"; shift 2 ;;
    --gcs-public-bucket) GCS_PUBLIC_BUCKET="${2:-}"; shift 2 ;;
    --gcs-internal-bucket) GCS_INTERNAL_BUCKET="${2:-}"; shift 2 ;;
    --gcs-credentials-file) GCS_CREDENTIALS_FILE="${2:-}"; shift 2 ;;
    --cloudflare) USE_CLOUDFLARE=1; shift ;;
    --cloudflare-api-token) CLOUDFLARE_API_TOKEN="${2:-}"; shift 2 ;;
    --cloudflare-zone-id) CLOUDFLARE_ZONE_ID="${2:-}"; shift 2 ;;
    --cloudflare-api-base-url) CLOUDFLARE_API_BASE_URL="${2:-}"; shift 2 ;;
    --skip-cloudflare-check) SKIP_CLOUDFLARE_CHECK=1; shift ;;
    --skip-public-check) SKIP_PUBLIC_CHECK=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail_selfhost "unknown option: $1" ;;
  esac
done

prompt_required() {
  local var_name="$1"
  local prompt="$2"
  local current="$3"
  local answer

  if [ -n "$current" ]; then
    printf -v "$var_name" '%s' "$current"
    return
  fi

  [ -t 0 ] || fail_selfhost "${prompt} is required in non-interactive mode"
  printf '%s: ' "$prompt"
  read -r answer
  [ -n "$answer" ] || fail_selfhost "${prompt} is required"
  printf -v "$var_name" '%s' "$answer"
}

# DR3: reject malformed domains early. A scheme, path/slash, or whitespace here
# silently breaks the Caddy site address and the OAuth redirect allowlist (which
# is built as https://<domain>/auth/callback).
validate_domain() {
  local label="$1"
  local value="$2"
  case "$value" in
    '') fail_selfhost "${label} must not be empty" ;;
    *://*) fail_selfhost "${label} must be a bare domain without a scheme — use updates.example.com, not ${value}" ;;
    */*) fail_selfhost "${label} must be a bare domain without a path or slash (got ${value})" ;;
    *[[:space:]]*) fail_selfhost "${label} must not contain whitespace (got '${value}')" ;;
  esac
  case "$value" in
    *.*) ;;
    *) fail_selfhost "${label} must be a fully-qualified domain like updates.example.com (got ${value})" ;;
  esac
  case "$value" in
    .* | *.) fail_selfhost "${label} must not start or end with a dot (got ${value})" ;;
    *[!A-Za-z0-9.-]*) fail_selfhost "${label} may contain only letters, digits, dots, and hyphens (got ${value})" ;;
  esac
}

# The external-DB overlay hands DATABASE_URL to the server verbatim, so assert
# only the shape that separates it from a non-Postgres URL: a postgres scheme
# with a non-empty remainder. Anything stricter (host/port/db parsing) would
# reject URLs the server accepts, e.g. ?sslmode=... params or socket hosts.
validate_database_url() {
  local label="$1"
  local value="$2"
  case "$value" in
    postgresql://?* | postgres://?*) ;;
    *) fail_selfhost "${label} must be a PostgreSQL URL like postgresql://user:password@host:5432/db (got ${value})" ;;
  esac
}

# Free-form operator values (connection URLs, tokens, secrets) are written
# single-quoted into .env.selfhost: compose's dotenv parser expands $ sequences
# in unquoted values — silently mangling e.g. a password containing $ while
# every script-side check still sees the intact value — whereas a
# single-quoted value stays literal for both compose and load_selfhost_env.
# The one thing that format cannot represent is an embedded single quote (and
# a raw newline would split the entry), so reject those up front.
validate_env_file_literal() {
  local label="$1"
  local value="$2"
  case "$value" in
    *"'"*) fail_selfhost "${label} must not contain a single quote: the value is stored single-quoted in .env.selfhost (so docker compose does not expand \$ sequences inside it), and the dotenv format cannot escape an embedded single quote" ;;
  esac
  case "$value" in
    *$'\n'*) fail_selfhost "${label} must not contain a newline" ;;
  esac
}

prompt_database() {
  # The database mode is fixed at install time (switching later is a manual
  # migration the scripts do not perform), so resolve it before the env file
  # is written. DR27: -y/--yes takes the default ("no" = bundled) for this
  # non-destructive prompt without asking.
  if [ -z "$DATABASE_MODE" ] && [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ]; then
    if prompt_yes_no \
      "Use an external PostgreSQL database instead of the bundled one?" \
      no; then
      DATABASE_MODE=external
    fi
  fi
  DATABASE_MODE="${DATABASE_MODE:-bundled}"

  case "$DATABASE_MODE" in
    bundled)
      # Reject rather than ignore: a silently dropped URL would boot a fresh
      # bundled Postgres while the operator believes their external one is in use.
      if [ -n "$DATABASE_URL" ]; then
        fail_selfhost "--database-url (or the DATABASE_URL environment variable) is set but the database mode is bundled; pass --database-mode external to use it, or unset it to run the bundled database"
      fi
      ;;
    external)
      prompt_required DATABASE_URL \
        "External PostgreSQL URL (postgresql://user:password@host:5432/db)" \
        "$DATABASE_URL"
      validate_database_url "--database-url" "$DATABASE_URL"
      ;;
    *)
      fail_selfhost "--database-mode must be bundled or external (got ${DATABASE_MODE})"
      ;;
  esac
}

# Extract the host from a URL (https://host/path or https://host). Used to
# derive the CDN/purge hostname from PUBLIC_BASE_URL in every storage mode.
url_host() {
  local value="$1"
  value="${value#*://}"
  printf '%s' "${value%%/*}"
}

# The server embeds PUBLIC_BASE_URL into every client download URL, so reject
# anything that is not an https URL with a real host early — an http:// value
# would point OTA downloads at plain HTTP, and an authority-less value like
# https:///path passes a bare scheme check while every derived URL (and the
# Cloudflare purge hostname) comes out empty.
validate_public_base_url() {
  local label="$1"
  local value="$2"
  case "$value" in
    https://?*) ;;
    http://*) fail_selfhost "${label} must be an https:// URL, not http:// (got ${value})" ;;
    *) fail_selfhost "${label} must be an https:// URL like https://cdn.example.com/codemagic-patch (got ${value})" ;;
  esac
  case "$value" in
    *[[:space:]]*) fail_selfhost "${label} must not contain whitespace (got '${value}')" ;;
  esac
  local authority host port
  authority="$(url_host "$value")"
  case "$authority" in
    *@*) fail_selfhost "${label} must not contain userinfo before the host (got ${value})" ;;
  esac
  host="${authority%%:*}"
  port=""
  case "$authority" in
    *:) fail_selfhost "${label} has an empty port (got ${authority})" ;;
    *:*) port="${authority#*:}" ;;
  esac
  case "$host" in
    '') fail_selfhost "${label} must include a host after https:// (got ${value})" ;;
    *[!A-Za-z0-9.-]*) fail_selfhost "${label} host may contain only letters, digits, dots, and hyphens (got '${host}')" ;;
    .* | *.) fail_selfhost "${label} host must not start or end with a dot (got ${host})" ;;
  esac
  if [ -n "$port" ]; then
    case "$port" in
      *[!0-9]*) fail_selfhost "${label} port must be numeric (got ${authority})" ;;
    esac
  fi
  case "$value" in
    *'?'* | *'#'*) fail_selfhost "${label} must not contain a query or fragment — the server appends artifact paths to it (got ${value})" ;;
  esac
}

# The gcs overlay bind-mounts this key file into the server container.
# Validate just enough to catch pointing at the wrong file — it must exist, be
# readable, and look like a JSON object (a service-account key is one). No
# deeper parsing: the Google SDK validates the rest at server boot.
validate_gcs_credentials_file() {
  local value="$1"
  [ -f "$value" ] || fail_selfhost "--gcs-credentials-file ${value} does not exist"
  [ -r "$value" ] || fail_selfhost "--gcs-credentials-file ${value} is not readable"
  local head_chunk
  head_chunk="$(head -c 64 "$value" | LC_ALL=C tr -d '[:space:]')"
  case "$head_chunk" in
    '{'*) ;;
    *) fail_selfhost "--gcs-credentials-file ${value} does not look like a JSON service-account key (it does not start with '{')" ;;
  esac
}

s3_values_given() {
  [ -n "$S3_BUCKET" ] || [ -n "$S3_REGION" ] || [ -n "$S3_ENDPOINT" ] ||
    [ -n "$S3_FORCE_PATH_STYLE" ] || [ -n "$S3_ACCESS_KEY_ID" ] ||
    [ -n "$S3_SECRET_ACCESS_KEY" ]
}

gcs_values_given() {
  [ -n "$GCS_PUBLIC_BUCKET" ] || [ -n "$GCS_INTERNAL_BUCKET" ] ||
    [ -n "$GCS_CREDENTIALS_FILE" ]
}

prompt_storage() {
  # The storage mode is fixed at install time (switching later is a manual
  # data migration the scripts do not perform), so resolve it before the env
  # file is written. DR27: -y/--yes takes the default ("no" = bundled) for
  # this non-destructive prompt without asking.
  if [ -z "$STORAGE_MODE" ] && [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ]; then
    if prompt_yes_no \
      "Use external object storage (S3 or GCS) instead of the bundled MinIO?" \
      no; then
      prompt_required STORAGE_MODE "Storage adapter (s3 or gcs)" "$STORAGE_MODE"
    fi
  fi
  STORAGE_MODE="${STORAGE_MODE:-bundled}"

  case "$STORAGE_MODE" in
    bundled | s3 | gcs) ;;
    *) fail_selfhost "--storage-mode must be bundled, s3, or gcs (got ${STORAGE_MODE})" ;;
  esac

  # Reject rather than ignore cross-mode values: a silently dropped bucket or
  # URL would boot a stack pointing somewhere other than where the operator
  # believes their artifacts live.
  if [ "$STORAGE_MODE" != "s3" ] && s3_values_given; then
    fail_selfhost "--s3-* options (or S3_* environment variables) are set but the storage mode is ${STORAGE_MODE}; pass --storage-mode s3 to use them, or unset them"
  fi
  if [ "$STORAGE_MODE" != "gcs" ] && gcs_values_given; then
    fail_selfhost "--gcs-* options (or GCS_* environment variables) are set but the storage mode is ${STORAGE_MODE}; pass --storage-mode gcs to use them, or unset them"
  fi

  case "$STORAGE_MODE" in
    bundled)
      if [ -n "$PUBLIC_BASE_URL" ]; then
        fail_selfhost "--public-base-url (or the PUBLIC_BASE_URL environment variable) is set but the storage mode is bundled; bundled storage derives PUBLIC_BASE_URL from the storage domain — pass --storage-mode s3 or gcs to set it directly, or unset it"
      fi
      prompt_required STORAGE_DOMAIN "Public storage domain" "$STORAGE_DOMAIN"
      ;;
    s3 | gcs)
      # External storage has no storage domain: caddy serves only the API
      # domain (Caddyfile.api-only) and there is no MinIO behind it.
      if [ -n "$STORAGE_DOMAIN" ]; then
        fail_selfhost "--storage-domain (or the CODEMAGIC_PATCH_STORAGE_DOMAIN environment variable) is set but the storage mode is ${STORAGE_MODE}; external storage has no storage domain — unset it, or use the bundled storage"
      fi
      ;;
  esac

  case "$STORAGE_MODE" in
    s3)
      prompt_required S3_BUCKET "S3 bucket name" "$S3_BUCKET"
      # Static credentials are all-or-nothing: the server requires the key id
      # and secret to be set together (both empty means the SDK's default
      # credential chain), so catch a half pair here, not at server boot.
      if [ -n "$S3_ACCESS_KEY_ID" ] && [ -z "$S3_SECRET_ACCESS_KEY" ]; then
        fail_selfhost "--s3-access-key-id requires --s3-secret-access-key (set both, or neither to use the SDK's default credential chain)"
      fi
      if [ -z "$S3_ACCESS_KEY_ID" ] && [ -n "$S3_SECRET_ACCESS_KEY" ]; then
        fail_selfhost "--s3-secret-access-key requires --s3-access-key-id (set both, or neither to use the SDK's default credential chain)"
      fi
      ;;
    gcs)
      prompt_required GCS_PUBLIC_BUCKET "GCS public bucket" "$GCS_PUBLIC_BUCKET"
      prompt_required GCS_INTERNAL_BUCKET "GCS internal bucket" "$GCS_INTERNAL_BUCKET"
      # The server refuses to boot with the same bucket for both: the public
      # bucket is world-readable, the internal one must never be.
      if [ "$GCS_PUBLIC_BUCKET" = "$GCS_INTERNAL_BUCKET" ]; then
        fail_selfhost "--gcs-public-bucket and --gcs-internal-bucket must differ (the public bucket is world-readable, the internal one must not be); got ${GCS_PUBLIC_BUCKET} for both"
      fi
      prompt_required GCS_CREDENTIALS_FILE \
        "GCS service-account JSON key file path" "$GCS_CREDENTIALS_FILE"
      validate_gcs_credentials_file "$GCS_CREDENTIALS_FILE"
      ;;
  esac

  if [ "$STORAGE_MODE" != "bundled" ]; then
    prompt_required PUBLIC_BASE_URL \
      "Public download base URL (https://... — the bucket, or the CDN in front of it)" \
      "$PUBLIC_BASE_URL"
    validate_public_base_url "--public-base-url" "$PUBLIC_BASE_URL"
  fi
}

# The gcs overlay bind-mounts <repo root>/gcs-service-account.json into the
# server container; copy the operator's key there. GCE metadata-server ADC is
# not supported by the Compose path — a compose override is the escape hatch.
install_gcs_credentials() {
  [ "$STORAGE_MODE" = "gcs" ] || return 0
  local dest="$SELFHOST_GCS_KEY_FILE"
  # Subshell umask so the copy is never world-readable, even for an instant;
  # the chmod normalizes a pre-existing destination's mode too.
  (umask 077 && cp "$GCS_CREDENTIALS_FILE" "$dest") ||
    fail_selfhost "could not copy ${GCS_CREDENTIALS_FILE} to ${dest}"
  chmod 600 "$dest"
  log_selfhost "copied GCS service-account key to ${dest}"
}

prompt_github_oauth() {
  # At least one OAuth provider (GitHub or Bitbucket) is mandatory. Bitbucket
  # is flags/env-only, so when it is configured and no GitHub value was given,
  # skip the GitHub prompts and run Bitbucket-only. Otherwise reuse
  # prompt_required so non-interactive runs fail fast when
  # --github-oauth-client-id or --github-oauth-client-secret is missing.
  if [ -n "$BITBUCKET_OAUTH_CLIENT_ID" ] &&
    [ -z "$GITHUB_OAUTH_CLIENT_ID" ] && [ -z "$GITHUB_OAUTH_CLIENT_SECRET" ]; then
    return 0
  fi
  prompt_required GITHUB_OAUTH_CLIENT_ID \
    "GitHub OAuth App Client ID" "$GITHUB_OAUTH_CLIENT_ID"
  prompt_required GITHUB_OAUTH_CLIENT_SECRET \
    "GitHub OAuth App client secret (web dashboard)" "$GITHUB_OAUTH_CLIENT_SECRET"
}

validate_bitbucket_oauth() {
  # Bitbucket is optional (flags/env only, no prompt) but all-or-nothing: the
  # server refuses to boot with a client id and no secret, so catch it here.
  if [ -n "$BITBUCKET_OAUTH_CLIENT_ID" ] && [ -z "$BITBUCKET_OAUTH_CLIENT_SECRET" ]; then
    fail_selfhost "--bitbucket-oauth-client-id requires --bitbucket-oauth-client-secret (Bitbucket has no secret-less flow)"
  fi
  if [ -z "$BITBUCKET_OAUTH_CLIENT_ID" ] && [ -n "$BITBUCKET_OAUTH_CLIENT_SECRET" ]; then
    fail_selfhost "--bitbucket-oauth-client-secret requires --bitbucket-oauth-client-id"
  fi
}

prompt_cloudflare() {
  # Cloudflare CDN is optional. Passing credentials implies enabling it even
  # without --cloudflare; otherwise ask once (interactive) defaulting to no.
  if [ "$USE_CLOUDFLARE" -eq 0 ] &&
    { [ -n "$CLOUDFLARE_API_TOKEN" ] || [ -n "$CLOUDFLARE_ZONE_ID" ]; }; then
    USE_CLOUDFLARE=1
  fi

  # The CDN domain differs by storage mode: bundled fronts the storage domain,
  # external storage fronts the PUBLIC_BASE_URL host (the CDN in front of the
  # bucket). prompt_storage has already resolved both by the time this runs —
  # keep the call order in main() that way.
  local cdn_host cdn_desc
  if [ "$STORAGE_MODE" = "bundled" ]; then
    cdn_host="$STORAGE_DOMAIN"
    cdn_desc="the storage domain ${cdn_host}"
  else
    cdn_host="$(url_host "$PUBLIC_BASE_URL")"
    cdn_desc="${cdn_host} (the PUBLIC_BASE_URL host, in front of the bucket)"
  fi

  # DR27: -y/--yes takes the default ("no") for this non-destructive prompt
  # without asking, matching the documented flag behavior.
  if [ "$USE_CLOUDFLARE" -eq 0 ] && [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ]; then
    if prompt_yes_no \
      "Front ${cdn_desc} with Cloudflare CDN (enables automatic cache purge on release)?" \
      no; then
      USE_CLOUDFLARE=1
    fi
  fi

  [ "$USE_CLOUDFLARE" -eq 1 ] || return 0

  # API Tokens and the legacy Global API Key sit side by side in the Cloudflare
  # dashboard; only a scoped API Token works here (Bearer auth). Point users at
  # the right one before prompting so they don't paste the Global API Key.
  if [ -z "$CLOUDFLARE_API_TOKEN" ] && [ -t 0 ]; then
    log_selfhost "Create the token at Cloudflare > My Profile > API Tokens (user-owned) or <account> > Manage Account > API Tokens (account-owned, cfat_…) — NOT the Global API Key — scoped to Zone > Cache Purge for the zone containing ${cdn_host}."
  fi

  prompt_required CLOUDFLARE_API_TOKEN \
    "Cloudflare API Token (scoped to Zone > Cache Purge, not the Global API Key)" "$CLOUDFLARE_API_TOKEN"
  prompt_required CLOUDFLARE_ZONE_ID \
    "Cloudflare Zone ID for ${cdn_host}" "$CLOUDFLARE_ZONE_ID"
}

verify_cloudflare() {
  [ "$USE_CLOUDFLARE" -eq 1 ] || return 0

  if [ "$SKIP_CLOUDFLARE_CHECK" -eq 1 ]; then
    warn_selfhost "skipping Cloudflare credential verification"
    return 0
  fi

  local api_base
  api_base="$(strip_trailing_slash \
    "${CLOUDFLARE_API_BASE_URL:-https://api.cloudflare.com/client/v4}")"

  # Validate the token's actual capability, nothing else. The runtime only
  # ever calls POST /zones/{id}/purge_cache, which needs just Zone > Cache
  # Purge — a token scoped to that permission CANNOT read the zone (GET
  # /zones/{id} requires Zone Read), so a zone lookup would reject correctly
  # scoped tokens. Token-verify endpoints don't work as a gate either: they
  # are split by ownership (/user/tokens/verify for user-owned tokens,
  # /accounts/{account_id}/tokens/verify for account-owned `cfat_…` tokens)
  # and the installer never collects an account id, so a single verify call
  # would reject one valid kind or the other. Instead exercise purge_cache
  # itself: purging a synthetic URL is harmless at the edge, yet Cloudflare
  # still validates the token, its cache-purge permission on this zone, the
  # zone id, and that the URL hostname belongs to the zone while using the
  # same URL-purge request shape the runtime uses — for both token kinds. The
  # purge hostname is PUBLIC_BASE_URL's host in every storage mode (bundled
  # derives PUBLIC_BASE_URL from the storage domain, so it is the same host);
  # the call site runs after load_selfhost_env, so PUBLIC_BASE_URL is the
  # env-file value on initial installs and reruns alike.
  local purge_host
  purge_host="$(url_host "$PUBLIC_BASE_URL")"

  log_selfhost "verifying Cloudflare cache-purge access for zone ${CLOUDFLARE_ZONE_ID}"
  local purge_data purge_body
  purge_data="$(printf '{"files":["https://%s/.codemagic-patch-install-check"]}' \
    "$purge_host")"
  purge_body="$(curl -sS -X POST \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "content-type: application/json" \
    --data "$purge_data" \
    "${api_base}/zones/${CLOUDFLARE_ZONE_ID}/purge_cache" 2>/dev/null || true)"
  case "$purge_body" in
    *'"success":true'*) ;;
    *)
      # Surface Cloudflare's own error so the failure points at the real cause
      # (wrong scope vs. wrong zone vs. domain not in zone) instead of guessing.
      local cf_error
      cf_error="$(printf '%s' "$purge_body" |
        grep -o '"message":"[^"]*"' | head -n1 |
        sed 's/"message":"\([^"]*\)"/\1/' || true)"
      fail_selfhost "Cloudflare cache-purge check failed for zone ${CLOUDFLARE_ZONE_ID}${cf_error:+ (Cloudflare: ${cf_error})}. Ensure CLOUDFLARE_API_TOKEN is scoped to Zone > Cache Purge for this zone, CLOUDFLARE_ZONE_ID is correct, and ${purge_host} is in that zone — or pass --skip-cloudflare-check to bypass."
      ;;
  esac

  log_selfhost "Cloudflare credentials verified"
}

check_tooling() {
  require_command_selfhost docker
  require_command_selfhost curl
  docker compose version >/dev/null || fail_selfhost "Docker Compose v2 is required"
}

# US36: state the network prerequisites up front. Caddy obtains Let's Encrypt
# certificates during install, which needs public DNS + ports 80/443 reachable —
# otherwise the install hangs at the HTTPS readiness wait with a late, opaque
# failure. Informational only (no active DNS probe: a Cloudflare-proxied storage
# domain resolves to Cloudflare, not this host, so a "points here?" check would
# false-positive).
print_prerequisites() {
  # Runs before the prompts, so the storage mode is only known when it came in
  # via flags/environment: name just the API domain for a known-external mode,
  # and otherwise note the storage domain is a bundled-storage-only need.
  case "$STORAGE_MODE" in
    s3 | gcs)
      cat <<'EOF'
[selfhost] Before continuing, make sure:
  - DNS: an A/AAAA record for the API domain points to THIS host's public IP
    (Let's Encrypt validates over HTTP on port 80). External object storage
    is in use, so no storage domain terminates on this host.
  - Ports 80 and 443 are open to the internet and free on this host.
  - An OAuth sign-in provider exists — a GitHub OAuth App and/or a Bitbucket
    OAuth consumer — with an Authorization callback URL
    https://<API domain>/auth/callback and a generated client secret.
  (No DNS yet? Re-run later, or pass --skip-public-check to skip the HTTPS wait.)
EOF
      ;;
    *)
      cat <<'EOF'
[selfhost] Before continuing, make sure:
  - DNS: A/AAAA records for BOTH the API and storage domains point to THIS
    host's public IP (Let's Encrypt validates over HTTP on port 80). The
    storage domain is only needed for the default bundled storage; external
    object storage (--storage-mode s3/gcs) needs the API domain only.
  - Ports 80 and 443 are open to the internet and free on this host.
  - An OAuth sign-in provider exists — a GitHub OAuth App and/or a Bitbucket
    OAuth consumer — with an Authorization callback URL
    https://<API domain>/auth/callback and a generated client secret.
  (No DNS yet? Re-run later, or pass --skip-public-check to skip the HTTPS wait.)
EOF
      ;;
  esac
}

check_port_hint() {
  local port="$1"

  if command -v ss >/dev/null 2>&1; then
    if ss -ltn "( sport = :${port} )" | awk 'NR > 1 { found = 1 } END { exit found ? 0 : 1 }'; then
      warn_selfhost "TCP port ${port} already appears to be in use"
    fi
    return
  fi

  if command -v lsof >/dev/null 2>&1; then
    if lsof -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; then
      warn_selfhost "TCP port ${port} already appears to be in use"
    fi
    return
  fi

  warn_selfhost "could not check whether TCP port ${port} is already in use"
}

write_env_file() {
  local worker_secret
  worker_secret="$(random_selfhost_secret)"

  # Bundled storage derives the public download URL from the storage domain;
  # external modes record the operator's --public-base-url instead.
  if [ "$STORAGE_MODE" = "bundled" ]; then
    PUBLIC_BASE_URL="https://${STORAGE_DOMAIN}/codemagic-patch"
  fi

  # Every value written single-quoted below must be representable (see
  # validate_env_file_literal). Validate before the first write so a rejected
  # value never leaves a partial env file behind.
  validate_env_file_literal "PUBLIC_BASE_URL" "$PUBLIC_BASE_URL"
  validate_env_file_literal "--database-url" "$DATABASE_URL"
  validate_env_file_literal "--s3-endpoint" "$S3_ENDPOINT"
  validate_env_file_literal "--s3-access-key-id" "$S3_ACCESS_KEY_ID"
  validate_env_file_literal "--s3-secret-access-key" "$S3_SECRET_ACCESS_KEY"
  validate_env_file_literal "--cloudflare-api-token" "$CLOUDFLARE_API_TOKEN"
  validate_env_file_literal "--cloudflare-api-base-url" "$CLOUDFLARE_API_BASE_URL"
  validate_env_file_literal "--github-oauth-client-secret" "$GITHUB_OAUTH_CLIENT_SECRET"
  validate_env_file_literal "--bitbucket-oauth-client-secret" "$BITBUCKET_OAUTH_CLIENT_SECRET"

  umask 077
  # DR2: build into a temp file in the same directory, then atomically rename, so
  # an interrupted write never leaves a partial .env.selfhost that the reuse path
  # would silently load. The .XXXXXX suffix matches the .env.selfhost.* gitignore.
  local env_tmp
  env_tmp="$(mktemp "${SELFHOST_ENV_FILE}.XXXXXX")"
  trap 'rm -f "$env_tmp"' EXIT INT TERM
  printf 'CODEMAGIC_PATCH_API_DOMAIN=%s\n' "$API_DOMAIN" >"$env_tmp"
  # No storage domain in external modes: caddy serves only the API domain
  # (Caddyfile.api-only), and a stray value here would feed the bundled
  # Caddyfile's storage site if the mode flag were ever hand-edited.
  if [ "$STORAGE_MODE" = "bundled" ]; then
    printf 'CODEMAGIC_PATCH_STORAGE_DOMAIN=%s\n' "$STORAGE_DOMAIN" >>"$env_tmp"
  fi
  cat >>"$env_tmp" <<EOF
ACME_EMAIL=${ADMIN_EMAIL}

# Stack shape, fixed at install time. Switching a mode later means migrating
# data by hand; the selfhost scripts do not perform it.
SELFHOST_DATABASE_MODE=${DATABASE_MODE}
SELFHOST_STORAGE_MODE=${STORAGE_MODE}

SERVER_URL=https://${API_DOMAIN}
PUBLIC_BASE_URL='${PUBLIC_BASE_URL}'

CODEMAGIC_PATCH_SERVER_IMAGE=codemagic-patch-server:selfhost
CODEMAGIC_PATCH_CADDY_IMAGE=codemagic-patch-caddy:selfhost
EOF

  # Bundled DB gets generated Postgres credentials; external mode records the
  # operator's DATABASE_URL instead (a POSTGRES_* block would be dead config
  # inviting the belief that it configures the external server).
  if [ "$DATABASE_MODE" = "external" ]; then
    cat >>"$env_tmp" <<EOF

DATABASE_URL='${DATABASE_URL}'
EOF
  else
    local postgres_password
    postgres_password="$(random_selfhost_secret)"
    cat >>"$env_tmp" <<EOF

POSTGRES_DB=codemagic_patch
POSTGRES_USER=codemagic_patch
POSTGRES_PASSWORD=${postgres_password}
EOF
  fi

  # Bundled storage gets generated MinIO credentials and the bundled S3
  # wiring; external modes record only the operator's adapter values (no
  # MINIO_ROOT_* — there is no MinIO to credential — and no STORAGE_ADAPTER
  # line: the s3/gcs overlay pins it literally, so a line here would be dead
  # config inviting the belief that editing it switches the adapter).
  if [ "$STORAGE_MODE" = "bundled" ]; then
    local minio_password
    minio_password="$(random_selfhost_secret)"
    cat >>"$env_tmp" <<EOF

MINIO_ROOT_USER=codemagicpatchminio
MINIO_ROOT_PASSWORD=${minio_password}

WORKER_SHARED_SECRET=${worker_secret}

MODE=all
RUN_MIGRATIONS=true
LOGGER=true

STORAGE_ADAPTER=s3
S3_REGION=us-east-1
S3_FORCE_PATH_STYLE=true
MANIFEST_CACHE_CONTROL="no-cache, must-revalidate"
EOF
  else
    cat >>"$env_tmp" <<EOF

WORKER_SHARED_SECRET=${worker_secret}

MODE=all
RUN_MIGRATIONS=true
LOGGER=true

MANIFEST_CACHE_CONTROL="no-cache, must-revalidate"
EOF
    if [ "$STORAGE_MODE" = "s3" ]; then
      # Only what the operator provided: the omitted optionals fall through
      # to the s3 overlay's own defaults.
      {
        printf '\nS3_BUCKET=%s\n' "$S3_BUCKET"
        if [ -n "$S3_REGION" ]; then
          printf 'S3_REGION=%s\n' "$S3_REGION"
        fi
        if [ -n "$S3_ENDPOINT" ]; then
          printf "S3_ENDPOINT='%s'\n" "$S3_ENDPOINT"
        fi
        if [ -n "$S3_FORCE_PATH_STYLE" ]; then
          printf 'S3_FORCE_PATH_STYLE=%s\n' "$S3_FORCE_PATH_STYLE"
        fi
        if [ -n "$S3_ACCESS_KEY_ID" ]; then
          printf "S3_ACCESS_KEY_ID='%s'\n" "$S3_ACCESS_KEY_ID"
          printf "S3_SECRET_ACCESS_KEY='%s'\n" "$S3_SECRET_ACCESS_KEY"
        fi
      } >>"$env_tmp"
    else
      cat >>"$env_tmp" <<EOF

GCS_PUBLIC_BUCKET=${GCS_PUBLIC_BUCKET}
GCS_INTERNAL_BUCKET=${GCS_INTERNAL_BUCKET}
EOF
    fi
  fi

  # Delivery / CDN. Default base-url serves the PUBLIC_BASE_URL host directly;
  # cloudflare fronts it with Cloudflare and purges the edge cache after
  # releases (bundled: the storage domain; external: the CDN over the bucket).
  if [ "$USE_CLOUDFLARE" -eq 1 ]; then
    {
      printf '\nDELIVERY_ADAPTER=cloudflare\n'
      printf "CLOUDFLARE_API_TOKEN='%s'\n" "$CLOUDFLARE_API_TOKEN"
      printf 'CLOUDFLARE_ZONE_ID=%s\n' "$CLOUDFLARE_ZONE_ID"
      if [ -n "$CLOUDFLARE_API_BASE_URL" ]; then
        printf "CLOUDFLARE_API_BASE_URL='%s'\n" "$CLOUDFLARE_API_BASE_URL"
      fi
    } >>"$env_tmp"
  else
    printf '\nDELIVERY_ADAPTER=base-url\n' >>"$env_tmp"
  fi

  # At least one OAuth provider (GitHub or Bitbucket) is mandatory; the
  # server refuses to boot without one. Each client secret powers the web
  # dashboard's confidential code exchange, and each redirect allowlist pins
  # the browser callback to the API domain.
  # OAUTH_CLI_AUTH_SECRET signs the CLI browser-login authorization codes.
  # INITIAL_ADMIN_EMAILS lets the admin's first OAuth sign-in create the
  # admin account under invite-only registration.
  local cli_auth_secret
  cli_auth_secret="$(random_selfhost_secret)"
  cat >>"$env_tmp" <<EOF

OAUTH_CLI_AUTH_SECRET=${cli_auth_secret}
INITIAL_ADMIN_EMAILS=${ADMIN_EMAIL}
EOF

  if [ -n "$GITHUB_OAUTH_CLIENT_ID" ]; then
    cat >>"$env_tmp" <<EOF

GITHUB_OAUTH_CLIENT_ID=${GITHUB_OAUTH_CLIENT_ID}
GITHUB_OAUTH_CLIENT_SECRET='${GITHUB_OAUTH_CLIENT_SECRET}'
GITHUB_OAUTH_SCOPES="${GITHUB_OAUTH_SCOPES:-read:user user:email}"
GITHUB_OAUTH_ALLOWED_REDIRECT_URIS=https://${API_DOMAIN}/auth/callback
EOF
  fi

  # Bitbucket sign-in is written only when provided (see
  # .env.selfhost.example for the consumer setup notes).
  if [ -n "$BITBUCKET_OAUTH_CLIENT_ID" ]; then
    cat >>"$env_tmp" <<EOF

BITBUCKET_OAUTH_CLIENT_ID=${BITBUCKET_OAUTH_CLIENT_ID}
BITBUCKET_OAUTH_CLIENT_SECRET='${BITBUCKET_OAUTH_CLIENT_SECRET}'
BITBUCKET_OAUTH_ALLOWED_REDIRECT_URIS=https://${API_DOMAIN}/auth/callback
EOF
  fi

  chmod 600 "$env_tmp"
  mv "$env_tmp" "$SELFHOST_ENV_FILE"
  trap - EXIT INT TERM
  log_selfhost "created ${SELFHOST_ENV_FILE}"
}

main() {
  check_tooling
  if [ ! -f "$SELFHOST_ENV_FILE" ]; then
    print_prerequisites
  fi
  check_port_hint 80
  check_port_hint 443

  if [ ! -f "$SELFHOST_ENV_FILE" ]; then
    prompt_required API_DOMAIN "CodemagicPatch API domain" "$API_DOMAIN"
    prompt_required ADMIN_EMAIL "Admin email" "$ADMIN_EMAIL"
    # Validate Bitbucket first: prompt_github_oauth skips the GitHub prompts
    # when Bitbucket is configured, so a half-configured Bitbucket flag pair
    # must fail before it can silently suppress the GitHub prompts.
    validate_bitbucket_oauth
    prompt_github_oauth
    prompt_database
    # prompt_storage before prompt_cloudflare: the Cloudflare prompts name the
    # CDN domain, which is the storage domain (bundled, prompted in
    # prompt_storage) or the PUBLIC_BASE_URL host (external).
    prompt_storage
    prompt_cloudflare
    # DR3/DR4: validate before writing so we never persist a broken env file that
    # the reuse path would then keep loading.
    validate_domain "API domain" "$API_DOMAIN"
    if [ "$STORAGE_MODE" = "bundled" ]; then
      validate_domain "storage domain" "$STORAGE_DOMAIN"
      if [ "$API_DOMAIN" = "$STORAGE_DOMAIN" ]; then
        fail_selfhost "the API domain and storage domain must differ (they map to separate Caddy sites); got ${API_DOMAIN} for both"
      fi
    fi
    install_gcs_credentials
    write_env_file
  else
    log_selfhost "reusing existing ${SELFHOST_ENV_FILE}"
    if [ -n "$GITHUB_OAUTH_CLIENT_ID" ] || [ -n "$GITHUB_OAUTH_CLIENT_SECRET" ]; then
      warn_selfhost "ignoring --github-oauth-client-id/--github-oauth-client-secret; OAuth is only written on initial install"
      warn_selfhost "edit GITHUB_OAUTH_CLIENT_ID/GITHUB_OAUTH_CLIENT_SECRET in ${SELFHOST_ENV_FILE} to change them, then rerun"
    fi
    if [ -n "$BITBUCKET_OAUTH_CLIENT_ID" ] || [ -n "$BITBUCKET_OAUTH_CLIENT_SECRET" ]; then
      warn_selfhost "ignoring --bitbucket-oauth-client-id/--bitbucket-oauth-client-secret; OAuth is only written on initial install"
      warn_selfhost "edit BITBUCKET_OAUTH_CLIENT_ID/BITBUCKET_OAUTH_CLIENT_SECRET in ${SELFHOST_ENV_FILE} to change them, then rerun"
    fi
    if [ "$USE_CLOUDFLARE" -eq 1 ] ||
      [ -n "$CLOUDFLARE_API_TOKEN" ] || [ -n "$CLOUDFLARE_ZONE_ID" ]; then
      warn_selfhost "ignoring --cloudflare/--cloudflare-api-token/--cloudflare-zone-id; delivery config is only written on initial install"
      warn_selfhost "edit DELIVERY_ADAPTER/CLOUDFLARE_* in ${SELFHOST_ENV_FILE} to change them, then rerun"
    fi
    if [ -n "$DATABASE_MODE" ] || [ -n "$DATABASE_URL" ]; then
      warn_selfhost "ignoring --database-mode/--database-url; the database mode is only written on initial install"
      warn_selfhost "SELFHOST_DATABASE_MODE in ${SELFHOST_ENV_FILE} stays authoritative — switching between the bundled and an external database is a manual data migration the selfhost scripts do not perform"
    fi
    if [ -n "$STORAGE_MODE" ] || [ -n "$PUBLIC_BASE_URL" ] ||
      s3_values_given || gcs_values_given; then
      warn_selfhost "ignoring --storage-mode/--public-base-url/--s3-*/--gcs-*; the storage mode is only written on initial install"
      warn_selfhost "SELFHOST_STORAGE_MODE in ${SELFHOST_ENV_FILE} stays authoritative — switching between the bundled MinIO and external object storage is a manual data migration the selfhost scripts do not perform"
    fi
  fi

  # Reset so detection below reflects the env file, not flags or the ambient
  # environment. load_selfhost_env repopulates them from the file.
  GITHUB_OAUTH_CLIENT_ID=""
  GITHUB_OAUTH_CLIENT_SECRET=""
  BITBUCKET_OAUTH_CLIENT_ID=""
  BITBUCKET_OAUTH_CLIENT_SECRET=""
  USE_CLOUDFLARE=0
  CLOUDFLARE_API_TOKEN=""
  CLOUDFLARE_ZONE_ID=""
  CLOUDFLARE_API_BASE_URL=""
  DATABASE_MODE=""
  DATABASE_URL=""
  STORAGE_MODE=""
  PUBLIC_BASE_URL=""
  S3_BUCKET=""
  S3_REGION=""
  S3_ENDPOINT=""
  S3_FORCE_PATH_STYLE=""
  S3_ACCESS_KEY_ID=""
  S3_SECRET_ACCESS_KEY=""
  GCS_PUBLIC_BUCKET=""
  GCS_INTERNAL_BUCKET=""
  GCS_CREDENTIALS_FILE=""
  load_selfhost_env

  # Read the modes back from the env file via the same authority
  # compose_selfhost uses, so a hand-edited file is judged consistently with
  # the stack that will actually be assembled.
  DATABASE_MODE="$(selfhost_mode_from_env_file SELFHOST_DATABASE_MODE)"
  STORAGE_MODE="$(selfhost_mode_from_env_file SELFHOST_STORAGE_MODE)"

  # DR29: a reused or hand-edited env file may be missing required values (e.g.
  # truncated by an interrupted write). Assert them before building so the install
  # fails clearly here instead of booting with an empty SERVER_URL or domains
  # (a blank `cmpatch login` URL, or a plain-HTTP Caddy catch-all over TLS).
  require_selfhost_env_var CODEMAGIC_PATCH_API_DOMAIN
  require_selfhost_env_var SERVER_URL
  require_selfhost_env_var PUBLIC_BASE_URL
  case "${DATABASE_MODE:-bundled}" in
    external)
      require_selfhost_env_var DATABASE_URL
      validate_database_url "DATABASE_URL in ${SELFHOST_ENV_FILE}" "$DATABASE_URL"
      ;;
    bundled)
      require_selfhost_env_var POSTGRES_USER
      require_selfhost_env_var POSTGRES_DB
      require_selfhost_env_var POSTGRES_PASSWORD
      ;;
    # Any other value: require neither set — compose_selfhost rejects the
    # unrecognized flag with its own precise message before anything runs.
  esac
  case "${STORAGE_MODE:-bundled}" in
    bundled)
      require_selfhost_env_var CODEMAGIC_PATCH_STORAGE_DOMAIN
      require_selfhost_env_var MINIO_ROOT_USER
      require_selfhost_env_var MINIO_ROOT_PASSWORD
      ;;
    s3)
      require_selfhost_env_var S3_BUCKET
      validate_public_base_url "PUBLIC_BASE_URL in ${SELFHOST_ENV_FILE}" "$PUBLIC_BASE_URL"
      ;;
    gcs)
      require_selfhost_env_var GCS_PUBLIC_BUCKET
      require_selfhost_env_var GCS_INTERNAL_BUCKET
      if [ "$GCS_PUBLIC_BUCKET" = "$GCS_INTERNAL_BUCKET" ]; then
        fail_selfhost "GCS_PUBLIC_BUCKET and GCS_INTERNAL_BUCKET in ${SELFHOST_ENV_FILE} must differ (the public bucket is world-readable, the internal one must not be); got ${GCS_PUBLIC_BUCKET} for both. Fix the env file and rerun."
      fi
      validate_public_base_url "PUBLIC_BASE_URL in ${SELFHOST_ENV_FILE}" "$PUBLIC_BASE_URL"
      # The gcs overlay bind-mounts this file into the server container; with
      # it missing, compose creates an empty directory in its place and the
      # server crash-loops on unusable credentials.
      if [ ! -f "$SELFHOST_GCS_KEY_FILE" ]; then
        fail_selfhost "missing ${SELFHOST_GCS_KEY_FILE} (the gcs overlay mounts it into the server container). Copy the service-account JSON key there manually, or remove ${SELFHOST_ENV_FILE} and rerun the install with --gcs-credentials-file."
      fi
      ;;
    # Any other value: require nothing — compose_selfhost rejects the
    # unrecognized flag with its own precise message before anything runs.
  esac
  require_selfhost_env_var WORKER_SHARED_SECRET
  require_selfhost_env_var ACME_EMAIL

  # DR3/DR4: validate the domains the env file records (covers reused/edited
  # files) and refuse identical domains, which make Caddy define the same site
  # twice ("ambiguous site") and hang the install. External storage has no
  # storage domain — caddy serves the API domain alone.
  validate_domain "CODEMAGIC_PATCH_API_DOMAIN" "$CODEMAGIC_PATCH_API_DOMAIN"
  if [ "${STORAGE_MODE:-bundled}" = "bundled" ]; then
    validate_domain "CODEMAGIC_PATCH_STORAGE_DOMAIN" "$CODEMAGIC_PATCH_STORAGE_DOMAIN"
    if [ "$CODEMAGIC_PATCH_API_DOMAIN" = "$CODEMAGIC_PATCH_STORAGE_DOMAIN" ]; then
      fail_selfhost "CODEMAGIC_PATCH_API_DOMAIN and CODEMAGIC_PATCH_STORAGE_DOMAIN must differ (they map to separate Caddy sites). Edit ${SELFHOST_ENV_FILE} (or rerun with distinct --api-domain/--storage-domain) and retry."
    fi
  fi

  SERVER_URL="$(strip_trailing_slash "$SERVER_URL")"
  PUBLIC_BASE_URL="$(strip_trailing_slash "$PUBLIC_BASE_URL")"

  # The env file is now authoritative for the delivery adapter; verify the
  # Cloudflare credentials it records before building (initial install or rerun).
  if [ "${DELIVERY_ADAPTER:-base-url}" = "cloudflare" ]; then
    USE_CLOUDFLARE=1
  fi
  verify_cloudflare

  # At least one OAuth provider (GitHub or Bitbucket) is mandatory, and each
  # configured provider needs its client secret: the server refuses to boot
  # otherwise. This validates an existing env file from a pre-OAuth
  # (token-only) or hand-edited install and backfills what it can before the
  # server container would crash-loop.
  ensure_selfhost_oauth_env

  log_selfhost "building images ${CODEMAGIC_PATCH_SERVER_IMAGE:-codemagic-patch-server:selfhost} and ${CODEMAGIC_PATCH_CADDY_IMAGE:-codemagic-patch-caddy:selfhost}"
  compose_selfhost build server caddy

  log_selfhost "starting self-host stack"
  compose_selfhost up -d
  # An external database has no postgres service in the stack to wait for; the
  # server wait below still proves the connection (migrations run at boot).
  if [ "${DATABASE_MODE:-bundled}" != "external" ]; then
    wait_for_selfhost_service postgres
  fi
  # External storage has no minio service in the stack to wait for; the server
  # wait below still proves the bucket config loads (the adapter initializes
  # at boot).
  if [ "${STORAGE_MODE:-bundled}" = "bundled" ]; then
    wait_for_selfhost_service minio
  fi
  wait_for_selfhost_service server

  if [ "$SKIP_PUBLIC_CHECK" -eq 0 ]; then
    log_selfhost "waiting for public HTTPS; Caddy must obtain Let's Encrypt certificates first,"
    log_selfhost "which usually takes 1-2 minutes (longer if rate limited) before the next step"
    wait_for_selfhost_http "${SERVER_URL}/health" "API HTTPS"
    # The storage HTTPS wait (and the DNS-only-until-certificate guidance) is
    # bundled-only: external storage has no storage domain on this host.
    if [ "${STORAGE_MODE:-bundled}" = "bundled" ]; then
      if [ "$USE_CLOUDFLARE" -eq 1 ]; then
        log_selfhost "Cloudflare enabled: keep ${CODEMAGIC_PATCH_STORAGE_DOMAIN} DNS-only until Caddy obtains a certificate, then switch it to proxied"
      fi
      wait_for_selfhost_http "https://${CODEMAGIC_PATCH_STORAGE_DOMAIN}/minio/health/ready" "storage HTTPS"
    fi
  else
    warn_selfhost "skipping public HTTPS readiness checks"
  fi

  log_selfhost "OAuth sign-in enforced; the admin account is created on first sign-in by ${ACME_EMAIL}"

  printf '\nCodemagicPatch self-host is ready.\n\n'
  printf 'Server URL (app config: CodemagicPatchApiUrl):\n  %s\n\n' "$SERVER_URL"
  printf 'Dashboard URL:\n  https://%s/\n\n' "$CODEMAGIC_PATCH_API_DOMAIN"
  printf 'Public base URL (app config: CodemagicPatchDownloadBaseUrl):\n  %s\n\n' "$PUBLIC_BASE_URL"
  if [ "$USE_CLOUDFLARE" -eq 1 ]; then
    printf 'CDN:\n  Cloudflare cache purge enabled (DELIVERY_ADAPTER=cloudflare).\n'
    if [ "${STORAGE_MODE:-bundled}" = "bundled" ]; then
      printf '  Proxy %s through Cloudflare and add a Cache Rule making the\n' "$CODEMAGIC_PATCH_STORAGE_DOMAIN"
      printf '  manifest/meta JSON paths cacheable; releases then purge them automatically.\n\n'
    else
      printf '  %s (the PUBLIC_BASE_URL host) is the Cloudflare-proxied CDN\n' "$(url_host "$PUBLIC_BASE_URL")"
      printf '  domain in front of the bucket; releases purge its cache automatically.\n\n'
    fi
  elif [ "${STORAGE_MODE:-bundled}" = "bundled" ]; then
    printf 'CDN:\n  none - clients fetch storage directly (DELIVERY_ADAPTER=base-url).\n\n'
  else
    printf 'CDN:\n  none - clients fetch the bucket/CDN at %s directly (DELIVERY_ADAPTER=base-url).\n\n' "$PUBLIC_BASE_URL"
  fi
  printf 'Next:\n'
  printf '  1. Store .env.selfhost securely.\n'
  printf '  2. Sign in as the admin via the dashboard at https://%s/\n' "$CODEMAGIC_PATCH_API_DOMAIN"
  printf "     (no CLI needed), or install the CLI from this repo's root and sign in:\n"
  printf '       yarn install && yarn cli:install-global\n'
  printf '       cmpatch login --server-url %s\n' "$SERVER_URL"
  printf '     Use the GitHub or Bitbucket account whose verified primary email is %s.\n' "$ACME_EMAIL"
  printf '     This first sign-in creates the admin account and makes you owner\n'
  printf '     of the auto-created "default-team".\n'
  printf '  3. The "default-team" is the single fixed team; team creation is disabled.\n'
  printf '     Onboard others with: cmpatch member invite --email <email> --role <role>\n'
  printf '     For CI/machine access, mint a token: cmpatch token create --name <token-name>.\n'
  printf '  4. Run scripts/selfhost/backup.sh before upgrades or risky changes.\n'
}

main "$@"
