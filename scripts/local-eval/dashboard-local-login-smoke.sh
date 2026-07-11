#!/usr/bin/env bash
#
# Verification tool for the LOCAL EVALUATION stack (docker-compose.dev.yml,
# see ./up.sh) — not part of the self-host flow. To self-host, run
# scripts/selfhost/install.sh.
#
# Hermetic smoke check for the local evaluation sign-in path — no browser
# needed. Exercises the exact API sequence the dashboard performs:
#
#   1. GET  /v1/auth/oauth/web-config   → expect mode=local-dev, provider echo
#   2. POST /v1/auth/oauth/callback     with code=local:<email> → real session
#   3. GET  /v1/users/me                with the access token → identity check
#   4. POST /v1/auth/logout             with the refresh token → 204
#   5. GET  /v1/users/me                again → the session is really revoked
#
# Runs against the dashboard origin (same-origin proxy) by default so the
# Caddy /v1/* route is covered too; point DASHBOARD_URL elsewhere (or at the
# server directly) to isolate. The real-GitHub path has its own smoke
# (github-device-login-smoke.sh) — this one never leaves localhost.
#
# Exits non-zero on any failure so it can be reused from CI later.

set -euo pipefail

DASHBOARD_URL="${DASHBOARD_URL:-http://localhost:8080}"
LOCAL_ADMIN_EMAIL="${LOCAL_ADMIN_EMAIL:-local-admin@example.com}"

LOCAL_EVAL_LOG_PREFIX="dashboard-smoke"
# shellcheck source=scripts/local-eval/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

require_command curl
require_command jq

log "fetching web config at ${DASHBOARD_URL}/v1/auth/oauth/web-config"
WEB_CONFIG="$(curl -fsS "${DASHBOARD_URL}/v1/auth/oauth/web-config")" \
  || fail "web-config is unreachable; bring the dev stack up first"

MODE="$(printf '%s' "${WEB_CONFIG}" | jq -r '.mode // empty')"
PROVIDER="$(printf '%s' "${WEB_CONFIG}" | jq -r '.provider')"
AUTHORIZE_BASE_URL="$(printf '%s' "${WEB_CONFIG}" | jq -r '.authorize_base_url // "ABSENT"')"
if [ "${MODE}" != "local-dev" ]; then
  fail "web-config mode is '${MODE:-ABSENT}', expected 'local-dev' — is the server running dist/localDev/entry.js?"
fi
if [ "${PROVIDER}" != "local-dev" ]; then
  fail "web-config provider is '${PROVIDER}', expected 'local-dev'"
fi
# "" (same-origin) is the meaningful value here; ABSENT means the field was
# dropped somewhere between the runtime option and the wire serializer.
if [ "${AUTHORIZE_BASE_URL}" != "" ]; then
  fail "web-config authorize_base_url is '${AUTHORIZE_BASE_URL}', expected the same-origin empty string"
fi
log "web config OK (mode=local-dev, same-origin authorize)"

log "exchanging code local:${LOCAL_ADMIN_EMAIL} via the callback route"
SESSION_JSON="$(curl -fsS -X POST "${DASHBOARD_URL}/v1/auth/oauth/callback" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg email "${LOCAL_ADMIN_EMAIL}" --arg redirect "${DASHBOARD_URL}/auth/callback" '{
        code: ("local:" + $email),
        code_verifier: "smoke-pkce-verifier-unchecked",
        provider: "local-dev",
        redirect_uri: $redirect
      }')")" || fail "callback exchange failed"

ACCESS_TOKEN="$(printf '%s' "${SESSION_JSON}" | jq -r '.access_token')"
REFRESH_TOKEN="$(printf '%s' "${SESSION_JSON}" | jq -r '.refresh_token')"
SESSION_EMAIL="$(printf '%s' "${SESSION_JSON}" | jq -r '.user.email')"
case "${ACCESS_TOKEN}" in
  cm_oat_*) ;;
  *) fail "callback did not return a cm_oat_ access token; raw: ${SESSION_JSON}" ;;
esac
if [ "${SESSION_EMAIL}" != "${LOCAL_ADMIN_EMAIL}" ]; then
  fail "session user email is '${SESSION_EMAIL}', expected '${LOCAL_ADMIN_EMAIL}'"
fi
log "session created for ${SESSION_EMAIL}"

log "calling an authenticated route with the access token"
ME_JSON="$(curl -fsS -H "Authorization: Bearer ${ACCESS_TOKEN}" "${DASHBOARD_URL}/v1/users/me")" \
  || fail "authenticated /v1/users/me failed"
OAUTH_PROVIDER="$(printf '%s' "${ME_JSON}" | jq -r '.user.oauth_provider')"
if [ "${OAUTH_PROVIDER}" != "local-dev" ]; then
  fail "user oauth_provider is '${OAUTH_PROVIDER}', expected 'local-dev' (audit-trail contract)"
fi
log "authenticated route OK (oauth_provider=local-dev recorded)"

log "logging out"
LOGOUT_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${DASHBOARD_URL}/v1/auth/logout" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg rt "${REFRESH_TOKEN}" '{refresh_token: $rt}')")"
if [ "${LOGOUT_STATUS}" != "204" ]; then
  fail "logout returned HTTP ${LOGOUT_STATUS}, expected 204"
fi

AFTER_LOGOUT_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" "${DASHBOARD_URL}/v1/users/me")"
if [ "${AFTER_LOGOUT_STATUS}" != "401" ]; then
  fail "access token still works after logout (HTTP ${AFTER_LOGOUT_STATUS}), expected 401"
fi
log "OK — local sign-in round-trip complete (web-config → callback → session → logout)"
