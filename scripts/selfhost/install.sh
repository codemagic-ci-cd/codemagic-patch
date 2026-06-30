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
CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"
CLOUDFLARE_ZONE_ID="${CLOUDFLARE_ZONE_ID:-}"
CLOUDFLARE_API_BASE_URL="${CLOUDFLARE_API_BASE_URL:-}"
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

Prerequisites: public DNS A/AAAA records for both domains pointing at this
host, ports 80/443 open to the internet (Let's Encrypt), and a GitHub OAuth
App. Create the OAuth App (device flow enabled, with Authorization callback
URL https://<api-domain>/auth/callback) before running, and pass its Client ID
and a generated client secret. The admin signs in via the web dashboard or
`cmpatch login`; the first sign-in by --email creates the admin account.

Options:
  --api-domain <domain>        Public API domain, for example updates.example.com.
  --storage-domain <domain>    Public storage domain, for example storage.updates.example.com.
  --email <email>              Admin and ACME email. Must match the verified
                               primary email of the admin's GitHub account.
  --github-oauth-client-id <id>
                               REQUIRED. GitHub OAuth App Client ID (device flow).
  --github-oauth-client-secret <secret>
                               REQUIRED. GitHub OAuth App client secret —
                               generate one on the same OAuth App; required
                               for the web dashboard.
  --github-oauth-scopes <s>    OAuth scopes (default: read:user user:email).
  --cloudflare                 Front the storage domain with Cloudflare CDN and
                               purge the edge cache after each release.
  --cloudflare-api-token <t>   Cloudflare API Token scoped to Zone > Cache Purge
                               — an API Token, not the Global API Key
                               (required with --cloudflare).
  --cloudflare-zone-id <id>    Cloudflare zone id containing the storage domain
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

prompt_github_oauth() {
  # GitHub OAuth is mandatory. Reuse prompt_required so non-interactive runs
  # fail fast when --github-oauth-client-id or --github-oauth-client-secret
  # is missing.
  prompt_required GITHUB_OAUTH_CLIENT_ID \
    "GitHub OAuth App Client ID (device flow)" "$GITHUB_OAUTH_CLIENT_ID"
  prompt_required GITHUB_OAUTH_CLIENT_SECRET \
    "GitHub OAuth App client secret (web dashboard)" "$GITHUB_OAUTH_CLIENT_SECRET"
}

prompt_cloudflare() {
  # Cloudflare CDN is optional. Passing credentials implies enabling it even
  # without --cloudflare; otherwise ask once (interactive) defaulting to no.
  if [ "$USE_CLOUDFLARE" -eq 0 ] &&
    { [ -n "$CLOUDFLARE_API_TOKEN" ] || [ -n "$CLOUDFLARE_ZONE_ID" ]; }; then
    USE_CLOUDFLARE=1
  fi

  # DR27: -y/--yes takes the default ("no") for this non-destructive prompt
  # without asking, matching the documented flag behavior.
  if [ "$USE_CLOUDFLARE" -eq 0 ] && [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ]; then
    if prompt_yes_no \
      "Front the storage domain with Cloudflare CDN (enables automatic cache purge on release)?" \
      no; then
      USE_CLOUDFLARE=1
    fi
  fi

  [ "$USE_CLOUDFLARE" -eq 1 ] || return 0

  # API Tokens and the legacy Global API Key sit side by side in the Cloudflare
  # dashboard; only a scoped API Token works here (Bearer auth). Point users at
  # the right one before prompting so they don't paste the Global API Key.
  if [ -z "$CLOUDFLARE_API_TOKEN" ] && [ -t 0 ]; then
    log_selfhost "Create the token at Cloudflare > My Profile > API Tokens > Create Token (NOT the Global API Key), scoped to Zone > Cache Purge for the storage zone."
  fi

  prompt_required CLOUDFLARE_API_TOKEN \
    "Cloudflare API Token (scoped to Zone > Cache Purge, not the Global API Key)" "$CLOUDFLARE_API_TOKEN"
  prompt_required CLOUDFLARE_ZONE_ID \
    "Cloudflare Zone ID for ${STORAGE_DOMAIN}" "$CLOUDFLARE_ZONE_ID"
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

  log_selfhost "verifying Cloudflare API token"
  local token_body
  token_body="$(curl -sS \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    "${api_base}/user/tokens/verify" 2>/dev/null || true)"
  case "$token_body" in
    *'"success":true'*) ;;
    *)
      fail_selfhost "Cloudflare token verification failed. Check CLOUDFLARE_API_TOKEN, or pass --skip-cloudflare-check to bypass."
      ;;
  esac
  # A token can authenticate but be disabled/expired (verify still returns
  # success:true with a non-active status); require status active.
  case "$token_body" in
    *'"status":"active"'*) ;;
    *)
      fail_selfhost "Cloudflare API token is not active (the verify endpoint did not report status active). Enable or rotate the token, or pass --skip-cloudflare-check to bypass."
      ;;
  esac

  # Validate the token's actual capability rather than zone read. The runtime
  # only ever calls POST /zones/{id}/purge_cache, which needs just Zone > Cache
  # Purge — a token scoped to that permission CANNOT read the zone (GET
  # /zones/{id} requires Zone Read), so the old zone lookup rejected correctly
  # scoped tokens. Instead exercise purge_cache itself: purging a synthetic URL
  # is harmless at the edge, yet Cloudflare still validates the token, its
  # cache-purge permission on this zone, the zone id, and that the URL hostname
  # belongs to the zone while using the same URL-purge request shape the runtime
  # uses. On reruns the prompt-set STORAGE_DOMAIN is empty, so fall back to the
  # env-file value.
  local storage_domain="${STORAGE_DOMAIN:-${CODEMAGIC_PATCH_STORAGE_DOMAIN:-}}"
  if [ -z "$storage_domain" ]; then
    warn_selfhost "storage domain unknown on this run; verified token validity only and skipped the zone/cache-purge capability check"
    log_selfhost "Cloudflare credentials verified"
    return 0
  fi

  log_selfhost "verifying Cloudflare cache-purge access for zone ${CLOUDFLARE_ZONE_ID}"
  local purge_data purge_body
  purge_data="$(printf '{"files":["https://%s/.codemagic-patch-install-check"]}' \
    "$storage_domain")"
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
      fail_selfhost "Cloudflare cache-purge check failed for zone ${CLOUDFLARE_ZONE_ID}${cf_error:+ (Cloudflare: ${cf_error})}. Ensure CLOUDFLARE_API_TOKEN is scoped to Zone > Cache Purge for this zone, CLOUDFLARE_ZONE_ID is correct, and ${storage_domain} is in that zone — or pass --skip-cloudflare-check to bypass."
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
  cat <<'EOF'
[selfhost] Before continuing, make sure:
  - DNS: A/AAAA records for BOTH the API and storage domains point to THIS
    host's public IP (Let's Encrypt validates over HTTP on port 80).
  - Ports 80 and 443 are open to the internet and free on this host.
  - A GitHub OAuth App exists: device flow enabled, an Authorization callback
    URL https://<API domain>/auth/callback, and a generated client secret.
  (No DNS yet? Re-run later, or pass --skip-public-check to skip the HTTPS wait.)
EOF
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
  local postgres_password
  local minio_password
  local worker_secret
  postgres_password="$(random_selfhost_secret)"
  minio_password="$(random_selfhost_secret)"
  worker_secret="$(random_selfhost_secret)"

  umask 077
  # DR2: build into a temp file in the same directory, then atomically rename, so
  # an interrupted write never leaves a partial .env.selfhost that the reuse path
  # would silently load. The .XXXXXX suffix matches the .env.selfhost.* gitignore.
  local env_tmp
  env_tmp="$(mktemp "${SELFHOST_ENV_FILE}.XXXXXX")"
  trap 'rm -f "$env_tmp"' EXIT INT TERM
  cat >"$env_tmp" <<EOF
CODEMAGIC_PATCH_API_DOMAIN=${API_DOMAIN}
CODEMAGIC_PATCH_STORAGE_DOMAIN=${STORAGE_DOMAIN}
ACME_EMAIL=${ADMIN_EMAIL}

SERVER_URL=https://${API_DOMAIN}
PUBLIC_BASE_URL=https://${STORAGE_DOMAIN}/codemagic-patch

CODEMAGIC_PATCH_SERVER_IMAGE=codemagic-patch-server:selfhost
CODEMAGIC_PATCH_CADDY_IMAGE=codemagic-patch-caddy:selfhost

POSTGRES_DB=codemagic_patch
POSTGRES_USER=codemagic_patch
POSTGRES_PASSWORD=${postgres_password}

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

  # Delivery / CDN. Default base-url serves storage directly; cloudflare fronts
  # the storage domain with Cloudflare and purges the edge cache after releases.
  if [ "$USE_CLOUDFLARE" -eq 1 ]; then
    {
      printf '\nDELIVERY_ADAPTER=cloudflare\n'
      printf 'CLOUDFLARE_API_TOKEN=%s\n' "$CLOUDFLARE_API_TOKEN"
      printf 'CLOUDFLARE_ZONE_ID=%s\n' "$CLOUDFLARE_ZONE_ID"
      if [ -n "$CLOUDFLARE_API_BASE_URL" ]; then
        printf 'CLOUDFLARE_API_BASE_URL=%s\n' "$CLOUDFLARE_API_BASE_URL"
      fi
    } >>"$env_tmp"
  else
    printf '\nDELIVERY_ADAPTER=base-url\n' >>"$env_tmp"
  fi

  # GitHub OAuth is mandatory; the server refuses to boot without it. The
  # client secret powers the web dashboard's confidential code exchange, and
  # the redirect allowlist pins the browser callback to the API domain.
  # INITIAL_ADMIN_EMAILS lets the admin's first OAuth sign-in create the
  # admin account under invite-only registration.
  local poll_secret
  poll_secret="$(random_selfhost_secret)"
  cat >>"$env_tmp" <<EOF

GITHUB_OAUTH_CLIENT_ID=${GITHUB_OAUTH_CLIENT_ID}
GITHUB_OAUTH_CLIENT_SECRET=${GITHUB_OAUTH_CLIENT_SECRET}
OAUTH_DEVICE_POLL_TOKEN_SECRET=${poll_secret}
GITHUB_OAUTH_SCOPES="${GITHUB_OAUTH_SCOPES:-read:user user:email}"
GITHUB_OAUTH_ALLOWED_REDIRECT_URIS=https://${API_DOMAIN}/auth/callback
INITIAL_ADMIN_EMAILS=${ADMIN_EMAIL}
EOF

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
    prompt_required STORAGE_DOMAIN "Public storage domain" "$STORAGE_DOMAIN"
    prompt_required ADMIN_EMAIL "Admin email" "$ADMIN_EMAIL"
    prompt_github_oauth
    prompt_cloudflare
    # DR3/DR4: validate before writing so we never persist a broken env file that
    # the reuse path would then keep loading.
    validate_domain "API domain" "$API_DOMAIN"
    validate_domain "storage domain" "$STORAGE_DOMAIN"
    if [ "$API_DOMAIN" = "$STORAGE_DOMAIN" ]; then
      fail_selfhost "the API domain and storage domain must differ (they map to separate Caddy sites); got ${API_DOMAIN} for both"
    fi
    write_env_file
  else
    log_selfhost "reusing existing ${SELFHOST_ENV_FILE}"
    if [ -n "$GITHUB_OAUTH_CLIENT_ID" ] || [ -n "$GITHUB_OAUTH_CLIENT_SECRET" ]; then
      warn_selfhost "ignoring --github-oauth-client-id/--github-oauth-client-secret; OAuth is only written on initial install"
      warn_selfhost "edit GITHUB_OAUTH_CLIENT_ID/GITHUB_OAUTH_CLIENT_SECRET in ${SELFHOST_ENV_FILE} to change them, then rerun"
    fi
    if [ "$USE_CLOUDFLARE" -eq 1 ] ||
      [ -n "$CLOUDFLARE_API_TOKEN" ] || [ -n "$CLOUDFLARE_ZONE_ID" ]; then
      warn_selfhost "ignoring --cloudflare/--cloudflare-api-token/--cloudflare-zone-id; delivery config is only written on initial install"
      warn_selfhost "edit DELIVERY_ADAPTER/CLOUDFLARE_* in ${SELFHOST_ENV_FILE} to change them, then rerun"
    fi
  fi

  # Reset so detection below reflects the env file, not flags or the ambient
  # environment. load_selfhost_env repopulates them from the file.
  GITHUB_OAUTH_CLIENT_ID=""
  GITHUB_OAUTH_CLIENT_SECRET=""
  USE_CLOUDFLARE=0
  CLOUDFLARE_API_TOKEN=""
  CLOUDFLARE_ZONE_ID=""
  CLOUDFLARE_API_BASE_URL=""
  load_selfhost_env

  # DR29: a reused or hand-edited env file may be missing required values (e.g.
  # truncated by an interrupted write). Assert them before building so the install
  # fails clearly here instead of booting with an empty SERVER_URL or domains
  # (a blank `cmpatch login` URL, or a plain-HTTP Caddy catch-all over TLS).
  require_selfhost_env_var CODEMAGIC_PATCH_API_DOMAIN
  require_selfhost_env_var CODEMAGIC_PATCH_STORAGE_DOMAIN
  require_selfhost_env_var SERVER_URL
  require_selfhost_env_var PUBLIC_BASE_URL
  require_selfhost_env_var POSTGRES_USER
  require_selfhost_env_var POSTGRES_DB
  require_selfhost_env_var POSTGRES_PASSWORD
  require_selfhost_env_var MINIO_ROOT_USER
  require_selfhost_env_var MINIO_ROOT_PASSWORD
  require_selfhost_env_var WORKER_SHARED_SECRET
  require_selfhost_env_var ACME_EMAIL

  # DR3/DR4: validate the domains the env file records (covers reused/edited
  # files) and refuse identical domains, which make Caddy define the same site
  # twice ("ambiguous site") and hang the install.
  validate_domain "CODEMAGIC_PATCH_API_DOMAIN" "$CODEMAGIC_PATCH_API_DOMAIN"
  validate_domain "CODEMAGIC_PATCH_STORAGE_DOMAIN" "$CODEMAGIC_PATCH_STORAGE_DOMAIN"
  if [ "$CODEMAGIC_PATCH_API_DOMAIN" = "$CODEMAGIC_PATCH_STORAGE_DOMAIN" ]; then
    fail_selfhost "CODEMAGIC_PATCH_API_DOMAIN and CODEMAGIC_PATCH_STORAGE_DOMAIN must differ (they map to separate Caddy sites). Edit ${SELFHOST_ENV_FILE} (or rerun with distinct --api-domain/--storage-domain) and retry."
  fi

  SERVER_URL="$(strip_trailing_slash "$SERVER_URL")"
  PUBLIC_BASE_URL="$(strip_trailing_slash "$PUBLIC_BASE_URL")"

  # The env file is now authoritative for the delivery adapter; verify the
  # Cloudflare credentials it records before building (initial install or rerun).
  if [ "${DELIVERY_ADAPTER:-base-url}" = "cloudflare" ]; then
    USE_CLOUDFLARE=1
  fi
  verify_cloudflare

  # GitHub OAuth is mandatory: the server refuses to boot without it. This
  # validates an existing env file from a pre-OAuth (token-only) install and
  # backfills what it can before the server container would crash-loop.
  ensure_selfhost_oauth_env

  # The client id alone only covers the CLI device flow; the web dashboard
  # performs the confidential web code exchange and needs the client secret.
  if [ -z "${GITHUB_OAUTH_CLIENT_SECRET:-}" ]; then
    fail_selfhost "GITHUB_OAUTH_CLIENT_SECRET is missing from ${SELFHOST_ENV_FILE}. The web dashboard requires a client secret. Add an Authorization callback URL https://${CODEMAGIC_PATCH_API_DOMAIN}/auth/callback to your GitHub OAuth App, generate a client secret, and add GITHUB_OAUTH_CLIENT_SECRET to the env file before rerunning."
  fi

  log_selfhost "building images ${CODEMAGIC_PATCH_SERVER_IMAGE:-codemagic-patch-server:selfhost} and ${CODEMAGIC_PATCH_CADDY_IMAGE:-codemagic-patch-caddy:selfhost}"
  compose_selfhost build server caddy

  log_selfhost "starting self-host stack"
  compose_selfhost up -d
  wait_for_selfhost_service postgres
  wait_for_selfhost_service minio
  wait_for_selfhost_service server

  if [ "$SKIP_PUBLIC_CHECK" -eq 0 ]; then
    log_selfhost "waiting for public HTTPS; Caddy must obtain Let's Encrypt certificates first,"
    log_selfhost "which usually takes 1-2 minutes (longer if rate limited) before the next step"
    wait_for_selfhost_http "${SERVER_URL}/health" "API HTTPS"
    if [ "$USE_CLOUDFLARE" -eq 1 ]; then
      log_selfhost "Cloudflare enabled: keep ${CODEMAGIC_PATCH_STORAGE_DOMAIN} DNS-only until Caddy obtains a certificate, then switch it to proxied"
    fi
    wait_for_selfhost_http "https://${CODEMAGIC_PATCH_STORAGE_DOMAIN}/minio/health/ready" "storage HTTPS"
  else
    warn_selfhost "skipping public HTTPS readiness checks"
  fi

  log_selfhost "GitHub OAuth enforced; the admin account is created on first sign-in by ${ACME_EMAIL}"

  printf '\nCodemagicPatch self-host is ready.\n\n'
  printf 'Server URL (app config: CodemagicPatchApiUrl):\n  %s\n\n' "$SERVER_URL"
  printf 'Dashboard URL:\n  https://%s/\n\n' "$CODEMAGIC_PATCH_API_DOMAIN"
  printf 'Public base URL (app config: CodemagicPatchDownloadBaseUrl):\n  %s\n\n' "$PUBLIC_BASE_URL"
  if [ "$USE_CLOUDFLARE" -eq 1 ]; then
    printf 'CDN:\n  Cloudflare cache purge enabled (DELIVERY_ADAPTER=cloudflare).\n'
    printf '  Proxy %s through Cloudflare and add a Cache Rule making the\n' "$CODEMAGIC_PATCH_STORAGE_DOMAIN"
    printf '  manifest/meta JSON paths cacheable; releases then purge them automatically.\n\n'
  else
    printf 'CDN:\n  none - clients fetch storage directly (DELIVERY_ADAPTER=base-url).\n\n'
  fi
  printf 'Next:\n'
  printf '  1. Store .env.selfhost securely.\n'
  printf '  2. Sign in as the admin via the dashboard at https://%s/\n' "$CODEMAGIC_PATCH_API_DOMAIN"
  printf "     (no CLI needed), or install the CLI from this repo's root and sign in:\n"
  printf '       yarn install && yarn cli:install-global\n'
  printf '       cmpatch login --server-url %s\n' "$SERVER_URL"
  printf '     Use the GitHub account whose verified primary email is %s.\n' "$ACME_EMAIL"
  printf '     This first sign-in creates the admin account and makes you owner\n'
  printf '     of the auto-created "default-team".\n'
  printf '  3. The "default-team" is the single fixed team; team creation is disabled.\n'
  printf '     Onboard others with: cmpatch member invite --email <email> --role <role>\n'
  printf '     For CI/machine access, mint a token: cmpatch token create.\n'
  printf '  4. Run scripts/selfhost/backup.sh before upgrades or risky changes.\n'
}

main "$@"
