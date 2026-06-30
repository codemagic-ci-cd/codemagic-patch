#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/selfhost/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

SERVER_URL_ARG=""
PUBLIC_BASE_URL_ARG=""
TOKEN_ARG=""
# S9: default to the mirrored examples fixture, not server/test/** (which is
# excluded from the public mirror), so the smoke runs out-of-box on an OSS checkout.
BUNDLE_PATH="${BUNDLE_PATH:-${SELFHOST_REPO_ROOT}/examples/local-dev/bundles/ios-hermes-v1.zip}"
SMOKE_TIMEOUT_SECONDS="${SELFHOST_SMOKE_TIMEOUT_SECONDS:-300}"
TARGET_BINARY_VERSION="${TARGET_BINARY_VERSION:-1.0.0}"

usage() {
  cat <<'USAGE'
Usage: scripts/selfhost/smoke.sh [options]

Options:
  --server-url <url>           Public CodemagicPatch API URL.
  --public-base-url <url>      Public base URL, including /codemagic-patch.
  --token <token>              cm_pat_... API token. CODEMAGIC_PATCH_TOKEN also works.
                               Optional: without a token only unauthenticated
                               checks run and the publish smoke is skipped.
                               Create one with 'cmpatch token create' after an
                               admin signs in via 'cmpatch login'.
  --bundle <path>              Bundle zip fixture to publish.
  --smoke-timeout <seconds>    Overall smoke timeout.
  -h, --help                   Show this help.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --server-url) SERVER_URL_ARG="${2:-}"; shift 2 ;;
    --public-base-url) PUBLIC_BASE_URL_ARG="${2:-}"; shift 2 ;;
    --token) TOKEN_ARG="${2:-}"; shift 2 ;;
    --bundle) BUNDLE_PATH="${2:-}"; shift 2 ;;
    --smoke-timeout) SMOKE_TIMEOUT_SECONDS="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fail_selfhost "unknown option: $1" ;;
  esac
done

require_command_selfhost docker
require_command_selfhost curl
docker compose version >/dev/null || fail_selfhost "Docker Compose v2 is required"
load_selfhost_env

SERVER_URL="$(strip_trailing_slash "${SERVER_URL_ARG:-${SERVER_URL:-}}")"
PUBLIC_BASE_URL="$(strip_trailing_slash "${PUBLIC_BASE_URL_ARG:-${PUBLIC_BASE_URL:-}}")"
CODEMAGIC_PATCH_TOKEN="${TOKEN_ARG:-${CODEMAGIC_PATCH_TOKEN:-}}"

[ -n "$SERVER_URL" ] || fail_selfhost "--server-url or SERVER_URL is required"
[ -n "$PUBLIC_BASE_URL" ] || fail_selfhost "--public-base-url or PUBLIC_BASE_URL is required"
if [ -z "$CODEMAGIC_PATCH_TOKEN" ]; then
  warn_selfhost "no API token provided; running unauthenticated checks only and skipping the publish/artifact smoke"
  warn_selfhost "for the full smoke, sign in with 'cmpatch login', run 'cmpatch token create', and rerun with CODEMAGIC_PATCH_TOKEN=cm_pat_..."
fi
[[ "$SMOKE_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] && [ "$SMOKE_TIMEOUT_SECONDS" -gt 0 ] ||
  fail_selfhost "--smoke-timeout must be a positive integer"

wait_for_selfhost_http "${SERVER_URL}/health" "API health" 60

# The bundle is only published in authenticated mode; unauthenticated checks
# must stay runnable without the fixture.
BUNDLE_MOUNT_ARGS=()
if [ -n "$CODEMAGIC_PATCH_TOKEN" ]; then
  [ -f "$BUNDLE_PATH" ] || fail_selfhost "bundle fixture not found: ${BUNDLE_PATH}"
  BUNDLE_PATH_ABS="$(cd "$(dirname "$BUNDLE_PATH")" && pwd)/$(basename "$BUNDLE_PATH")"
  BUNDLE_MOUNT_ARGS=(-v "${BUNDLE_PATH_ABS}:/smoke/bundle.zip:ro")
  log_selfhost "running publish/artifact smoke against ${SERVER_URL}"
else
  log_selfhost "running unauthenticated smoke against ${SERVER_URL}"
fi
compose_selfhost run --rm --no-deps \
  -e SMOKE_SERVER_URL="$SERVER_URL" \
  -e SMOKE_PUBLIC_BASE_URL="$PUBLIC_BASE_URL" \
  -e SMOKE_TOKEN="$CODEMAGIC_PATCH_TOKEN" \
  -e SMOKE_TIMEOUT_SECONDS="$SMOKE_TIMEOUT_SECONDS" \
  -e SMOKE_TARGET_BINARY_VERSION="$TARGET_BINARY_VERSION" \
  ${BUNDLE_MOUNT_ARGS[@]+"${BUNDLE_MOUNT_ARGS[@]}"} \
  --entrypoint node \
  server - <<'NODE'
const { randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");

const serverUrl = stripTrailingSlash(process.env.SMOKE_SERVER_URL);
const publicBaseUrl = stripTrailingSlash(process.env.SMOKE_PUBLIC_BASE_URL);
const token = process.env.SMOKE_TOKEN;
const timeoutSeconds = Number(process.env.SMOKE_TIMEOUT_SECONDS || "300");
const targetBinaryVersion = process.env.SMOKE_TARGET_BINARY_VERSION || "1.0.0";
const deadline = Date.now() + timeoutSeconds * 1000;

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function fail(message) {
  throw new Error(message);
}

function log(message) {
  console.log(`[selfhost-smoke] ${message}`);
}

async function request(path, options = {}) {
  const response = await fetch(`${serverUrl}${path}`, {
    ...options,
    headers: {
      ...(options.json ? { "content-type": "application/json" } : {}),
      ...(options.auth === false ? {} : { authorization: `Bearer ${token}` }),
      ...(options.headers || {}),
    },
    body: options.json === undefined ? options.body : JSON.stringify(options.json),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    fail(`${path} returned ${response.status}: ${body}`);
  }

  return response.json();
}

async function listApps(teamId) {
  const body = await request(`/v1/teams/${encodeURIComponent(teamId)}/apps`);
  return Array.isArray(body.apps) ? body.apps : [];
}

async function listDeployments(appId) {
  const body = await request(`/v1/apps/${encodeURIComponent(appId)}/deployments`);
  return Array.isArray(body.deployments) ? body.deployments : [];
}

// Find the fixed smoke app or create it. Tolerates a create race (two runs
// against a fresh stack both see no app, then one POST hits the unique
// app-name constraint -> 409): on conflict, re-list and reuse the winner.
async function findOrCreateSmokeApp(teamId, name) {
  const reuse = async () => {
    const found = (await listApps(teamId)).find(
      (candidate) => candidate.name === name,
    );
    if (!found) {
      return null;
    }
    log(`reusing app=${found.id} (${name})`);
    return { appId: found.id, deployments: await listDeployments(found.id) };
  };

  const existing = await reuse();
  if (existing) {
    return existing;
  }

  const response = await fetch(`${serverUrl}/v1/apps`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name, team_id: teamId }),
  });
  if (response.ok) {
    const created = await response.json();
    log(`created app=${created.app.id} (${name})`);
    return { appId: created.app.id, deployments: created.deployments };
  }
  if (response.status === 409) {
    const raced = await reuse();
    if (raced) {
      return raced;
    }
  }
  const body = await response.text().catch(() => "");
  fail(`POST /v1/apps returned ${response.status}: ${body}`);
}

async function expectStatus(url, predicate, label, until = deadline) {
  let response;
  while (Date.now() < until) {
    response = await fetch(url).catch(() => null);
    if (response && predicate(response.status)) {
      return response;
    }
    await sleep(2000);
  }
  fail(`${label} did not reach expected status before timeout; last status=${response ? response.status : "network-error"} url=${url}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createRelease(deploymentId) {
  const bundle = await readFile("/smoke/bundle.zip");
  const form = new FormData();
  form.set("metadata", JSON.stringify({
    disabled: false,
    fingerprint: `selfhost-smoke-${Date.now()}`,
    is_mandatory: false,
    // The smoke reuses one app, so the same fixture is re-published every run;
    // allow it (the server still creates a fresh release + reconcile job, just
    // tagged with a duplicate-release warning) instead of erroring.
    no_duplicate_release_error: true,
    rollout_percentage: 100,
    target_binary_version: targetBinaryVersion,
    release_notes: "self-host smoke",
  }));
  form.set("bundle", new Blob([bundle], { type: "application/zip" }), "bundle.zip");

  return request(`/v1/deployments/${encodeURIComponent(deploymentId)}/releases`, {
    body: form,
    headers: { "idempotency-key": randomUUID() },
    json: undefined,
    method: "POST",
  });
}

async function pollRelease(releaseId) {
  while (Date.now() < deadline) {
    const body = await request(`/v1/releases/${encodeURIComponent(releaseId)}`);
    const releaseStatus = body.release && body.release.status;
    const jobStatus = body.job && body.job.status;

    if (releaseStatus === "failed" || jobStatus === "failed") {
      fail(`release failed: ${JSON.stringify(body)}`);
    }

    if (releaseStatus === "published" && (!jobStatus || jobStatus === "succeeded")) {
      return body;
    }

    await sleep(3000);
  }

  fail(`release ${releaseId} did not publish before timeout`);
}

(async () => {
  log(`checking ${serverUrl}/health`);
  await expectStatus(`${serverUrl}/health`, (status) => status >= 200 && status < 300, "API health");

  const unauth = await fetch(`${serverUrl}/v1/teams`);
  if (unauth.status !== 401) {
    fail(`unauthenticated /v1/teams returned ${unauth.status}; expected 401`);
  }

  // These should answer immediately once the API is healthy; fail fast on a
  // misconfigured PUBLIC_BASE_URL instead of polling out the full deadline.
  const staticCheckDeadline = Math.min(deadline, Date.now() + 30 * 1000);
  await expectStatus(`${publicBaseUrl}/_internal/releases/does-not-exist/bundle.tar.zst`, (status) => status >= 400 && status < 500, "_internal synthetic object", staticCheckDeadline);
  await expectStatus(`${publicBaseUrl}?list-type=2`, (status) => status >= 400 && status < 500, "bucket listing", staticCheckDeadline);

  if (!token) {
    log("OK (unauthenticated checks only; publish smoke skipped — no API token)");
    return;
  }

  // US30: reuse the bootstrap default-team and a fixed app instead of creating a
  // fresh team+app per run, which left orphan teams that can't be deleted. Only
  // this one app accrues release history; no teams are created. Select the team
  // by name (not list order) to be explicit about the contract.
  const teamsBody = await request("/v1/teams");
  const team = (teamsBody.teams || []).find(
    (candidate) => candidate.name === "default-team",
  );
  if (!team) {
    fail('smoke expected the bootstrap "default-team" but /v1/teams did not include it');
  }

  const { appId, deployments } = await findOrCreateSmokeApp(team.id, "selfhost-smoke");

  const staging = deployments.find((deployment) => deployment.name === "Staging");
  if (!staging) {
    fail(`smoke app has no Staging deployment: ${JSON.stringify(deployments)}`);
  }
  log(`team=${team.id} app=${appId} deployment=${staging.id}`);
  const creation = await createRelease(staging.id);
  const releaseId = creation.release && creation.release.id;
  if (!releaseId) {
    fail(`release create response did not include release.id: ${JSON.stringify(creation)}`);
  }

  log(`created release=${releaseId}; polling`);
  const published = await pollRelease(releaseId);
  const packageHash = published.release && published.release.target_package_hash;
  if (!packageHash) {
    fail(`published release did not include target_package_hash: ${JSON.stringify(published)}`);
  }

  const primaryManifestUrl = `${publicBaseUrl}/${staging.deployment_key}/${targetBinaryVersion}/${packageHash}/manifest.json`;
  const fallbackManifestUrl = `${publicBaseUrl}/${staging.deployment_key}/${targetBinaryVersion}/manifest.json`;
  const metaUrl = `${publicBaseUrl}/${staging.deployment_key}/meta.json`;

  log(`checking primary manifest ${primaryManifestUrl}`);
  const primaryManifest = await (await expectStatus(primaryManifestUrl, (status) => status === 200, "primary manifest")).json();
  if (primaryManifest.target_package_hash !== packageHash) {
    fail(`primary manifest hash mismatch: ${primaryManifest.target_package_hash} !== ${packageHash}`);
  }

  const bundleUrl = primaryManifest.full_bundle_url;
  if (!bundleUrl || !bundleUrl.startsWith(`${publicBaseUrl}/`)) {
    fail(`manifest full_bundle_url does not use PUBLIC_BASE_URL: ${bundleUrl}`);
  }

  await expectStatus(fallbackManifestUrl, (status) => status === 200, "fallback manifest");
  const meta = await (await expectStatus(metaUrl, (status) => status === 200, "meta.json")).json();
  if (meta.latest_binary_version !== targetBinaryVersion) {
    fail(`meta latest_binary_version mismatch: ${meta.latest_binary_version} !== ${targetBinaryVersion}`);
  }
  await expectStatus(bundleUrl, (status) => status === 200, "bundle");

  await expectStatus(`${publicBaseUrl}/_internal/releases/${releaseId}/bundle.tar.zst`, (status) => status >= 400 && status < 500, "_internal release object");

  log(`OK release=${releaseId} packageHash=${packageHash}`);
})().catch((error) => {
  console.error(`[selfhost-smoke] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
NODE
