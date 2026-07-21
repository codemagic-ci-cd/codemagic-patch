#!/usr/bin/env bash
#
# Verification tool for the LOCAL EVALUATION stack (docker-compose.dev.yml,
# see ./up.sh) — not part of the self-host flow. To self-host, run
# scripts/selfhost/install.sh.
#
# End-to-end smoke check for the local evaluation stack.
#
# Assumes the stack is already up (`./scripts/local-eval/up.sh` or
# `docker compose -f docker-compose.dev.yml up --build`) and the seed has
# finished. Builds the CLI if needed, posts a
# release using the bundled fixture, polls until the release is published,
# and asserts that the resulting manifest and bundle are reachable through
# the public MinIO URL the manifest itself advertises.
#
# Exits non-zero on any failure so it can be reused from CI later.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVER_URL="${SERVER_URL:-http://localhost:3000}"
DASHBOARD_URL="${DASHBOARD_URL:-http://localhost:8080}"
export CODEMAGIC_PATCH_TOKEN="${CODEMAGIC_PATCH_TOKEN:-cm_pat_local-dev-token-change-me-00000001}"
DEPLOYMENT_ID="${DEPLOYMENT_ID:-deployment_local_cli_quickstart}"
DEPLOYMENT_KEY="${DEPLOYMENT_KEY:-dev_local_deployment_key}"
TARGET_BINARY_VERSION="${TARGET_BINARY_VERSION:-1.0.0}"
FINGERPRINT="${FINGERPRINT:-local-dev-fingerprint}"
# Sample Hermes bundle shipped in the repo (override with BUNDLE_PATH=/path/to/bundle.zip).
BUNDLE_PATH="${BUNDLE_PATH:-${REPO_ROOT}/examples/local-dev/bundles/ios-hermes-v1.zip}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-http://localhost:9100/codemagic-patch}"
PUBLISH_TIMEOUT_SECONDS="${PUBLISH_TIMEOUT_SECONDS:-30}"

CLI_BIN="${REPO_ROOT}/cli/dist/cmpatch.js"

LOCAL_EVAL_LOG_PREFIX="smoke"
# shellcheck source=scripts/local-eval/common.sh
. "${REPO_ROOT}/scripts/local-eval/common.sh"

require_command curl
require_command node
require_command jq

if [ ! -f "${BUNDLE_PATH}" ]; then
  fail "bundle fixture not found at ${BUNDLE_PATH}"
fi

if [ ! -f "${CLI_BIN}" ]; then
  log "CLI build not found, building once..."
  (cd "${REPO_ROOT}" && yarn workspace @codemagic/patch-cli build)
fi

log "checking server health at ${SERVER_URL}/health"
if ! curl -fsS "${SERVER_URL}/health" >/dev/null; then
  fail "server is not responding; bring the dev stack up first"
fi

log "checking dashboard at ${DASHBOARD_URL}/"
if ! curl -fsS "${DASHBOARD_URL}/" | grep -qi '<!doctype html>'; then
  fail "dashboard is not serving the SPA shell; bring the dev stack up first"
fi

# NOT a health-path check: the SPA fallback answers ANY unknown path with a
# 200 index.html, so proving the /v1/* proxy works needs a real API route
# with an asserted JSON shape. mode=local-dev also catches a stack whose
# server was started without the local entrypoint.
log "checking dashboard /v1 proxy via ${DASHBOARD_URL}/v1/auth/oauth/web-config"
PROXY_MODE="$(curl -fsS "${DASHBOARD_URL}/v1/auth/oauth/web-config" | jq -r '.mode // empty')"
if [ "${PROXY_MODE}" != "local-dev" ]; then
  fail "dashboard /v1 proxy check failed (web-config mode='${PROXY_MODE:-ABSENT}', expected 'local-dev')"
fi

log "checking dashboard /health proxy readiness"
if ! curl -fsS "${DASHBOARD_URL}/health/ready" | jq -e '.ok == true' >/dev/null; then
  fail "dashboard /health/ready proxy check failed"
fi

# One-shot by design: this script always publishes the same fixture bundle,
# and the server rejects re-publishing the bundle that is already the latest
# published release (409 duplicate-release). Turn that case into an explicit
# "already ran on this stack" failure with remediation instead of a bare CLI
# error.
log "creating release via CLI"
CLI_STDERR="$(mktemp)"
if RELEASE_JSON="$(node "${CLI_BIN}" release create \
  --server-url "${SERVER_URL}" \
  --deployment-id "${DEPLOYMENT_ID}" \
  --bundle-path "${BUNDLE_PATH}" \
  --target-binary-version "${TARGET_BINARY_VERSION}" \
  --fingerprint "${FINGERPRINT}" \
  --yes 2>"${CLI_STDERR}")"; then
  CREATE_OK=1
else
  CREATE_OK=0
fi
cat "${CLI_STDERR}" >&2

if [ "${CREATE_OK}" != "1" ]; then
  if grep -q "duplicate-release" "${CLI_STDERR}"; then
    rm -f "${CLI_STDERR}"
    fail "the fixture bundle is already the latest published release on this stack. This smoke check runs once per fresh stack — a prior run, or the quickstart's manual 'release create', already published it. Reset with 'docker compose -f docker-compose.dev.yml down -v' and bring the stack back up, or point BUNDLE_PATH at a different bundle."
  fi
  rm -f "${CLI_STDERR}"
  fail "release create failed (see CLI output above)"
fi
rm -f "${CLI_STDERR}"

RELEASE_ID="$(printf '%s' "${RELEASE_JSON}" | jq -r '.release.id')"
INITIAL_STATUS="$(printf '%s' "${RELEASE_JSON}" | jq -r '.release.status')"
if [ -z "${RELEASE_ID}" ] || [ "${RELEASE_ID}" = "null" ]; then
  fail "release create did not return a release id; raw response: ${RELEASE_JSON}"
fi
log "release ${RELEASE_ID} created (initial status: ${INITIAL_STATUS})"

log "polling release status (timeout ${PUBLISH_TIMEOUT_SECONDS}s)"
DEADLINE=$(( $(date +%s) + PUBLISH_TIMEOUT_SECONDS ))
PUBLISHED_JSON=""
while [ "$(date +%s)" -lt "${DEADLINE}" ]; do
  CURRENT="$(curl -fsS -H "Authorization: Bearer ${CODEMAGIC_PATCH_TOKEN}" "${SERVER_URL}/v1/releases/${RELEASE_ID}")"
  STATUS="$(printf '%s' "${CURRENT}" | jq -r '.release.status')"
  case "${STATUS}" in
    published)
      PUBLISHED_JSON="${CURRENT}"
      break
      ;;
    failed|disabled)
      fail "release ${RELEASE_ID} reached terminal status ${STATUS}; raw: ${CURRENT}"
      ;;
  esac
  sleep 1
done

if [ -z "${PUBLISHED_JSON}" ]; then
  fail "release ${RELEASE_ID} did not reach 'published' within ${PUBLISH_TIMEOUT_SECONDS}s"
fi

PACKAGE_HASH="$(printf '%s' "${PUBLISHED_JSON}" | jq -r '.release.target_package_hash')"
if [ -z "${PACKAGE_HASH}" ] || [ "${PACKAGE_HASH}" = "null" ]; then
  fail "published release is missing target_package_hash"
fi
log "release published with package hash ${PACKAGE_HASH}"

PRIMARY_MANIFEST_URL="${PUBLIC_BASE_URL}/${DEPLOYMENT_KEY}/${TARGET_BINARY_VERSION}/${PACKAGE_HASH}/manifest.json"
FALLBACK_MANIFEST_URL="${PUBLIC_BASE_URL}/${DEPLOYMENT_KEY}/${TARGET_BINARY_VERSION}/manifest.json"
META_URL="${PUBLIC_BASE_URL}/${DEPLOYMENT_KEY}/meta.json"

log "fetching primary manifest"
PRIMARY_JSON="$(curl -fsS "${PRIMARY_MANIFEST_URL}")"
MANIFEST_HASH="$(printf '%s' "${PRIMARY_JSON}" | jq -r '.target_package_hash')"
if [ "${MANIFEST_HASH}" != "${PACKAGE_HASH}" ]; then
  fail "primary manifest target_package_hash (${MANIFEST_HASH}) does not match published release (${PACKAGE_HASH})"
fi

log "fetching fallback manifest"
FALLBACK_JSON="$(curl -fsS "${FALLBACK_MANIFEST_URL}")"
FALLBACK_HASH="$(printf '%s' "${FALLBACK_JSON}" | jq -r '.target_package_hash')"
if [ "${FALLBACK_HASH}" != "${PACKAGE_HASH}" ]; then
  fail "fallback manifest target_package_hash (${FALLBACK_HASH}) does not match published release (${PACKAGE_HASH})"
fi
if printf '%s' "${FALLBACK_JSON}" | jq -e 'has("patch_url")' >/dev/null; then
  fail "fallback manifest must not advertise patch_url"
fi

log "fetching deployment meta"
META_JSON="$(curl -fsS "${META_URL}")"
META_VERSION="$(printf '%s' "${META_JSON}" | jq -r '.latest_binary_version')"
if [ "${META_VERSION}" != "${TARGET_BINARY_VERSION}" ]; then
  fail "meta.json latest_binary_version (${META_VERSION}) does not match target (${TARGET_BINARY_VERSION})"
fi

BUNDLE_URL="$(printf '%s' "${PRIMARY_JSON}" | jq -r '.full_bundle_url')"
log "checking bundle is reachable at ${BUNDLE_URL}"
BUNDLE_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "${BUNDLE_URL}")"
if [ "${BUNDLE_STATUS}" != "200" ]; then
  fail "bundle URL returned HTTP ${BUNDLE_STATUS}"
fi

INTERNAL_URL="${PUBLIC_BASE_URL}/_internal/releases/${RELEASE_ID}/bundle.tar.zst"
log "asserting _internal prefix is denied at ${INTERNAL_URL}"
INTERNAL_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "${INTERNAL_URL}")"
case "${INTERNAL_STATUS}" in
  4*) ;;  # any 4xx is acceptable: 403 (policy deny) or 404 (key absent under stricter policies)
  *) fail "_internal URL returned HTTP ${INTERNAL_STATUS}; expected 4xx (bucket policy must deny anonymous reads under _internal/*)" ;;
esac

log "OK — release ${RELEASE_ID} published, manifests + bundle reachable, _internal/* denied"
