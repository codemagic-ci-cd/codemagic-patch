#!/usr/bin/env bash
#
# Verification tool for the LOCAL EVALUATION stack (docker-compose.dev.yml,
# see ./up.sh) — not part of the self-host flow. To self-host, run
# scripts/selfhost/install.sh.
#
# Two-release smoke check for the local evaluation stack.
#
# Assumes the stack is already up (`docker compose -f docker-compose.dev.yml
# up --build`) and the seed has finished. Publishes two OTA releases for the
# same deployment / binary version, then verifies:
#
# - a client on the first OTA package sees the second release with patch_url
# - a client on the embedded bundle sees the second release without patch_url
# - fallback previous_package_info also remains full-bundle-only
# - advertised patch and bundle URLs are publicly reachable

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVER_URL="${SERVER_URL:-http://localhost:3000}"
export CODEMAGIC_PATCH_TOKEN="${CODEMAGIC_PATCH_TOKEN:-cm_pat_local-dev-token-change-me-00000001}"
DEPLOYMENT_ID="${DEPLOYMENT_ID:-deployment_local_staging}"
DEPLOYMENT_KEY="${DEPLOYMENT_KEY:-dev_local_deployment_key}"
TARGET_BINARY_VERSION="${TARGET_BINARY_VERSION:-1.0.0}"
FINGERPRINT="${FINGERPRINT:-local-dev-fingerprint}"
# Sample Hermes bundles shipped in the repo; baseline->v2 form an OTA patch
# pair. Deliberately NOT ios-hermes-v1.zip: local-dev-smoke.sh publishes that
# one to the same deployment, and the server rejects re-publishing the bundle
# that is already the latest published release (409 duplicate-release). Using
# a disjoint pair keeps both smoke scripts runnable in any order on a warm
# stack. Override with BUNDLE_FIRST_PATH=/path/to/first.zip
# BUNDLE_SECOND_PATH=/path/to/second.zip (contents must differ).
BUNDLE_FIRST_PATH="${BUNDLE_FIRST_PATH:-${REPO_ROOT}/examples/local-dev/bundles/ios-hermes-baseline.zip}"
BUNDLE_SECOND_PATH="${BUNDLE_SECOND_PATH:-${REPO_ROOT}/examples/local-dev/bundles/ios-hermes-v2.zip}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-http://localhost:9100/codemagic-patch}"
PUBLISH_TIMEOUT_SECONDS="${PUBLISH_TIMEOUT_SECONDS:-30}"

CLI_BIN="${REPO_ROOT}/cli/dist/cmpatch.js"

LOCAL_EVAL_LOG_PREFIX="smoke:second-release"
# shellcheck source=scripts/local-eval/common.sh
. "${REPO_ROOT}/scripts/local-eval/common.sh"

require_command curl
require_command node
require_command jq

if [ ! -f "${BUNDLE_FIRST_PATH}" ]; then
  fail "first bundle fixture not found at ${BUNDLE_FIRST_PATH}"
fi

if [ ! -f "${BUNDLE_SECOND_PATH}" ]; then
  fail "second bundle fixture not found at ${BUNDLE_SECOND_PATH}"
fi

if [ ! -f "${CLI_BIN}" ]; then
  log "CLI build not found, building once..."
  (cd "${REPO_ROOT}" && yarn workspace codemagic-patch build)
fi

log "checking server health at ${SERVER_URL}/health"
if ! curl -fsS "${SERVER_URL}/health" >/dev/null; then
  fail "server is not responding; bring the dev stack up first"
fi

create_release() {
  local label="$1"
  local bundle_path="$2"

  log "creating ${label} via CLI"
  node "${CLI_BIN}" release create \
    --server-url "${SERVER_URL}" \
    --deployment-id "${DEPLOYMENT_ID}" \
    --bundle-path "${bundle_path}" \
    --target-binary-version "${TARGET_BINARY_VERSION}" \
    --fingerprint "${FINGERPRINT}" \
    --yes
}

wait_for_published() {
  local release_id="$1"
  local deadline
  local current
  local status

  log "polling ${release_id} until published (timeout ${PUBLISH_TIMEOUT_SECONDS}s)"
  deadline=$(( $(date +%s) + PUBLISH_TIMEOUT_SECONDS ))

  while [ "$(date +%s)" -lt "${deadline}" ]; do
    current="$(curl -fsS -H "Authorization: Bearer ${CODEMAGIC_PATCH_TOKEN}" "${SERVER_URL}/v1/releases/${release_id}")"
    status="$(printf '%s' "${current}" | jq -r '.release.status')"

    case "${status}" in
      published)
        printf '%s' "${current}"
        return 0
        ;;
      failed|disabled)
        fail "release ${release_id} reached terminal status ${status}; raw: ${current}"
        ;;
    esac

    sleep 1
  done

  fail "release ${release_id} did not reach 'published' within ${PUBLISH_TIMEOUT_SECONDS}s"
}

require_http_200() {
  local label="$1"
  local url="$2"
  local status

  status="$(curl -s -o /dev/null -w '%{http_code}' "${url}")"
  if [ "${status}" != "200" ]; then
    fail "${label} returned HTTP ${status}: ${url}"
  fi
}

FIRST_RELEASE_JSON="$(create_release "first release" "${BUNDLE_FIRST_PATH}")"
FIRST_RELEASE_ID="$(printf '%s' "${FIRST_RELEASE_JSON}" | jq -r '.release.id')"
if [ -z "${FIRST_RELEASE_ID}" ] || [ "${FIRST_RELEASE_ID}" = "null" ]; then
  fail "first release create did not return a release id; raw response: ${FIRST_RELEASE_JSON}"
fi

FIRST_PUBLISHED_JSON="$(wait_for_published "${FIRST_RELEASE_ID}")"
FIRST_PACKAGE_HASH="$(printf '%s' "${FIRST_PUBLISHED_JSON}" | jq -r '.release.target_package_hash')"
if [ -z "${FIRST_PACKAGE_HASH}" ] || [ "${FIRST_PACKAGE_HASH}" = "null" ]; then
  fail "first published release is missing target_package_hash"
fi
log "first release ${FIRST_RELEASE_ID} published with package hash ${FIRST_PACKAGE_HASH}"

SECOND_RELEASE_JSON="$(create_release "second release" "${BUNDLE_SECOND_PATH}")"
SECOND_RELEASE_ID="$(printf '%s' "${SECOND_RELEASE_JSON}" | jq -r '.release.id')"
if [ -z "${SECOND_RELEASE_ID}" ] || [ "${SECOND_RELEASE_ID}" = "null" ]; then
  fail "second release create did not return a release id; raw response: ${SECOND_RELEASE_JSON}"
fi

SECOND_PUBLISHED_JSON="$(wait_for_published "${SECOND_RELEASE_ID}")"
SECOND_PACKAGE_HASH="$(printf '%s' "${SECOND_PUBLISHED_JSON}" | jq -r '.release.target_package_hash')"
if [ -z "${SECOND_PACKAGE_HASH}" ] || [ "${SECOND_PACKAGE_HASH}" = "null" ]; then
  fail "second published release is missing target_package_hash"
fi

if [ "${FIRST_PACKAGE_HASH}" = "${SECOND_PACKAGE_HASH}" ]; then
  fail "first and second package hashes are identical; patch smoke needs distinct releases"
fi
log "second release ${SECOND_RELEASE_ID} published with package hash ${SECOND_PACKAGE_HASH}"

FIRST_PRIMARY_MANIFEST_URL="${PUBLIC_BASE_URL}/${DEPLOYMENT_KEY}/${TARGET_BINARY_VERSION}/${FIRST_PACKAGE_HASH}/manifest.json"
SECOND_PRIMARY_MANIFEST_URL="${PUBLIC_BASE_URL}/${DEPLOYMENT_KEY}/${TARGET_BINARY_VERSION}/${SECOND_PACKAGE_HASH}/manifest.json"
FALLBACK_MANIFEST_URL="${PUBLIC_BASE_URL}/${DEPLOYMENT_KEY}/${TARGET_BINARY_VERSION}/manifest.json"

log "fetching primary manifest for first package"
FIRST_PRIMARY_JSON="$(curl -fsS "${FIRST_PRIMARY_MANIFEST_URL}")"
FIRST_PRIMARY_TARGET="$(printf '%s' "${FIRST_PRIMARY_JSON}" | jq -r '.target_package_hash')"
if [ "${FIRST_PRIMARY_TARGET}" != "${SECOND_PACKAGE_HASH}" ]; then
  fail "first-package primary manifest targets ${FIRST_PRIMARY_TARGET}; expected ${SECOND_PACKAGE_HASH}"
fi

PATCH_URL="$(printf '%s' "${FIRST_PRIMARY_JSON}" | jq -r '.patch_url // empty')"
if [ -z "${PATCH_URL}" ]; then
  fail "first-package primary manifest did not advertise patch_url"
fi
require_http_200 "patch URL" "${PATCH_URL}"

FIRST_PRIMARY_PREVIOUS_HASH="$(printf '%s' "${FIRST_PRIMARY_JSON}" | jq -r '.previous_package_info.package_hash // empty')"
if [ "${FIRST_PRIMARY_PREVIOUS_HASH}" != "${FIRST_PACKAGE_HASH}" ]; then
  fail "first-package primary previous_package_info hash (${FIRST_PRIMARY_PREVIOUS_HASH}) does not match first release (${FIRST_PACKAGE_HASH})"
fi

BUNDLE_URL="$(printf '%s' "${FIRST_PRIMARY_JSON}" | jq -r '.full_bundle_url // empty')"
if [ -z "${BUNDLE_URL}" ]; then
  fail "first-package primary manifest is missing full_bundle_url"
fi
require_http_200 "second full bundle URL" "${BUNDLE_URL}"

log "fetching primary manifest for second package"
SECOND_PRIMARY_JSON="$(curl -fsS "${SECOND_PRIMARY_MANIFEST_URL}")"
SECOND_PRIMARY_TARGET="$(printf '%s' "${SECOND_PRIMARY_JSON}" | jq -r '.target_package_hash')"
if [ "${SECOND_PRIMARY_TARGET}" != "${SECOND_PACKAGE_HASH}" ]; then
  fail "second-package primary manifest targets ${SECOND_PRIMARY_TARGET}; expected ${SECOND_PACKAGE_HASH}"
fi
if printf '%s' "${SECOND_PRIMARY_JSON}" | jq -e 'has("patch_url")' >/dev/null; then
  fail "second-package primary manifest should be a no-op and must not advertise patch_url"
fi

log "fetching fallback manifest"
FALLBACK_JSON="$(curl -fsS "${FALLBACK_MANIFEST_URL}")"
FALLBACK_TARGET="$(printf '%s' "${FALLBACK_JSON}" | jq -r '.target_package_hash')"
if [ "${FALLBACK_TARGET}" != "${SECOND_PACKAGE_HASH}" ]; then
  fail "fallback manifest targets ${FALLBACK_TARGET}; expected ${SECOND_PACKAGE_HASH}"
fi
if printf '%s' "${FALLBACK_JSON}" | jq -e 'has("patch_url")' >/dev/null; then
  fail "fallback manifest must not advertise root patch_url (PROTOCOL.md)"
fi

FALLBACK_PREVIOUS_HASH="$(printf '%s' "${FALLBACK_JSON}" | jq -r '.previous_package_info.package_hash // empty')"
if [ "${FALLBACK_PREVIOUS_HASH}" != "${FIRST_PACKAGE_HASH}" ]; then
  fail "fallback previous_package_info hash (${FALLBACK_PREVIOUS_HASH}) does not match first release (${FIRST_PACKAGE_HASH})"
fi
if printf '%s' "${FALLBACK_JSON}" | jq -e '.previous_package_info | objects | has("patch_url")' >/dev/null; then
  fail "fallback previous_package_info must not advertise patch_url (PROTOCOL.md)"
fi

FALLBACK_BUNDLE_URL="$(printf '%s' "${FALLBACK_JSON}" | jq -r '.full_bundle_url // empty')"
if [ -z "${FALLBACK_BUNDLE_URL}" ]; then
  fail "fallback manifest is missing full_bundle_url"
fi
require_http_200 "fallback full bundle URL" "${FALLBACK_BUNDLE_URL}"

log "OK — second release patch manifest works, fallback remains full-bundle-only"
