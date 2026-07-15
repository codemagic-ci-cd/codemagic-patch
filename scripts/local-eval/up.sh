#!/usr/bin/env bash
#
# Local evaluation bootstrap — one command from a fresh clone to a working
# stack: brings up docker-compose.dev.yml (server + worker + Postgres + MinIO
# + dashboard, local sign-in), installs the `cmpatch` CLI globally, waits for
# readiness, and prints a ready banner with URLs and next steps.
#
#   ./scripts/local-eval/up.sh [--skip-cli]
#
# Re-running is safe and cheap: the compose stack is idempotent, and a run
# against an already-up stack just re-verifies health and reprints the banner
# (use it as the "where were those URLs again?" command).
#
# The CLI step assumes a React Native developer's machine: Node >= 22.20 is a
# hard requirement and the script FAILS FAST (before any Docker work) when it
# is missing or too old, rather than half-succeeding. --skip-cli opts out of
# the CLI entirely (Docker remains the only prerequisite).
#
# This is the evaluation stack, NOT a deployment — authentication is disabled
# and every published port binds to 127.0.0.1. To self-host for real, run
# scripts/selfhost/install.sh.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/docker-compose.dev.yml"
COMPOSE=(docker compose -f "${COMPOSE_FILE}")

DASHBOARD_URL="http://localhost:8080"
SERVER_URL="http://localhost:3000"
MINIO_CONSOLE_URL="http://localhost:9101"
LOCAL_ADMIN_EMAIL="local-admin@example.com"
SEEDED_TOKEN="cm_pat_local-dev-token-change-me-00000001"
REQUIRED_NODE_VERSION="22.20.0"
READY_TIMEOUT_SECONDS="${READY_TIMEOUT_SECONDS:-180}"
EVAL_PORTS=(3000 8080 9100 9101 55433)

SKIP_CLI=0

LOCAL_EVAL_LOG_PREFIX="local-eval"
# shellcheck source=scripts/local-eval/common.sh
. "${REPO_ROOT}/scripts/local-eval/common.sh"

usage() {
  cat <<'EOF'
Usage: scripts/local-eval/up.sh [options]

Brings up the local evaluation stack (docker-compose.dev.yml), installs the
cmpatch CLI globally, and prints the ready banner.

Options:
  --skip-cli   Skip the CLI install entirely (Docker stays the only
               prerequisite; the banner shows manual CLI instructions instead)
  -h, --help   Show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-cli) SKIP_CLI=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown option: $1" ;;
  esac
done

# ---------------------------------------------------------------------------
# Preflight — fail fast (in seconds) before any minutes-long Docker work.
# ---------------------------------------------------------------------------

command -v docker >/dev/null 2>&1 || fail "Docker is required: https://docs.docker.com/get-docker/"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required (the \`docker compose\` plugin, not docker-compose v1)"
command -v curl >/dev/null 2>&1 || fail "curl is required"

if [ "${SKIP_CLI}" -eq 0 ]; then
  command -v node >/dev/null 2>&1 \
    || fail "Node.js >= ${REQUIRED_NODE_VERSION} is required for the CLI install (pass --skip-cli to bring up only the stack)"
  # node itself does the semver comparison — it is guaranteed present here,
  # and this avoids leaning on the host sort's dialect for a correctness gate.
  if ! node -e '
    const cur = process.versions.node.split(".").map(Number);
    const req = process.argv[1].split(".").map(Number);
    for (let i = 0; i < 3; i += 1) {
      if (cur[i] !== req[i]) process.exit(cur[i] > req[i] ? 0 : 1);
    }
  ' "${REQUIRED_NODE_VERSION}"; then
    fail "Node $(node --version) is too old — the CLI requires >= ${REQUIRED_NODE_VERSION} (pass --skip-cli to bring up only the stack)"
  fi
  command -v yarn >/dev/null 2>&1 \
    || fail "yarn is required for the CLI install — run \`corepack enable\` first (or pass --skip-cli)"
  command -v npm >/dev/null 2>&1 \
    || fail "npm is required for the CLI global install (ships with Node — check your Node installation)"
fi

# Port check only applies to a fresh start; when the stack's own containers
# already hold the ports, `up` is an idempotent no-op and must not be blocked.
# ANY running container of this compose project counts — a stack created
# before the dashboard service existed still owns 3000/9100/… and must be
# upgraded by `up`, not aborted as a port conflict.
if [ -z "$("${COMPOSE[@]}" ps -q 2>/dev/null)" ]; then
  for port in "${EVAL_PORTS[@]}"; do
    if (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then
      exec 3>&- 3<&- || true
      fail "port ${port} is already in use by another process; the evaluation stack needs 3000, 8080, 9100, 9101, and 55433 free"
    fi
  done
fi

# ---------------------------------------------------------------------------
# Bring the stack up and wait until it is genuinely ready: the dashboard's
# /health/ready proxies to the server (DB check included), and the seed
# container must have exited 0 so the demo app / token actually exist.
# ---------------------------------------------------------------------------

log "bringing up the evaluation stack (first run builds images — a few minutes)"
"${COMPOSE[@]}" up --build -d

log "waiting for readiness at ${DASHBOARD_URL}/health/ready (timeout ${READY_TIMEOUT_SECONDS}s)"
DEADLINE=$(( $(date +%s) + READY_TIMEOUT_SECONDS ))
until curl -fsS "${DASHBOARD_URL}/health/ready" 2>/dev/null | grep -q '"ok":true'; do
  if [ "$(date +%s)" -ge "${DEADLINE}" ]; then
    printf '\n'
    fail "stack did not become ready within ${READY_TIMEOUT_SECONDS}s — inspect with: docker compose -f docker-compose.dev.yml logs server dashboard"
  fi
  printf '.'
  sleep 2
done
printf '\n'

# `docker compose wait` cannot see already-exited one-shots, so poll the seed
# container's state directly until it has exited, then assert exit code 0.
SEED_IDS="$("${COMPOSE[@]}" ps -aq seed)"
[ -n "${SEED_IDS}" ] || fail "the seed container was not created — inspect with: docker compose -f docker-compose.dev.yml ps -a"
# `ps -aq` can list more than one container for the service (e.g. a leftover
# one-off `compose run seed`) — watch the newest one, not a raw multi-line id.
SEED_ID="$(printf '%s\n' "${SEED_IDS}" | xargs docker inspect -f '{{.Created}} {{.Id}}' | sort | tail -n 1 | awk '{print $2}')"
SEED_DEADLINE=$(( $(date +%s) + 60 ))
while :; do
  SEED_STATE="$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' "${SEED_ID}")"
  case "${SEED_STATE}" in
    "exited 0") break ;;
    exited*) fail "the seed service exited with status ${SEED_STATE#exited } — inspect with: docker compose -f docker-compose.dev.yml logs seed" ;;
  esac
  if [ "$(date +%s)" -ge "${SEED_DEADLINE}" ]; then
    fail "the seed service did not finish within 60s — inspect with: docker compose -f docker-compose.dev.yml logs seed"
  fi
  sleep 1
done

# ---------------------------------------------------------------------------
# CLI — global install by default (React Native evaluators have Node). Any
# failure here fails the whole script; --skip-cli is the opt-out.
# ---------------------------------------------------------------------------

CLI_READY=0
if [ "${SKIP_CLI}" -eq 0 ]; then
  log "installing the cmpatch CLI globally (yarn install + build + npm install -g)"
  (cd "${REPO_ROOT}" && yarn install && yarn cli:install-global) \
    || fail "CLI install failed — see the output above (re-run with --skip-cli to use the stack without the CLI)"
  command -v cmpatch >/dev/null 2>&1 \
    || fail "cmpatch was installed but is not on PATH — check \`npm prefix -g\`/bin is in your PATH, then re-run"
  CLI_READY=1
fi

# ---------------------------------------------------------------------------
# Ready banner
# ---------------------------------------------------------------------------

cat <<EOF

==============================================================
 Codemagic Patch — local evaluation stack is ready

   Dashboard    ${DASHBOARD_URL}
                → sign in as ${LOCAL_ADMIN_EMAIL} (prefilled, one click)
   API          ${SERVER_URL}
   MinIO        ${MINIO_CONSOLE_URL}  (minio / minio12345)

EOF

if [ "${CLI_READY}" -eq 1 ]; then
  cat <<EOF
   CLI (installed globally as \`cmpatch\`):
     cmpatch login --server-url ${SERVER_URL}     # approves instantly
     cmpatch release create \\
       --server-url ${SERVER_URL} \\
       --app demo-app-ios --deployment cli-smoke-test \\
       --bundle-path examples/local-dev/bundles/ios-hermes-v1.zip \\
       --target-binary-version 1.0.0 --fingerprint local-dev-fingerprint
     # uninstall later with: npm uninstall -g codemagic-patch
EOF
else
  cat <<EOF
   CLI (skipped — install later with):
     yarn install && yarn cli:install-global
EOF
fi

cat <<EOF

   Seeded API token (scripting / CI):
     ${SEEDED_TOKEN}

   Dashboard sample data:
     Example Data → Staging / Production (releases + metrics; not downloadable)

   See it on a device (OTA update applying on an emulator):
     examples/on-device-demo/

   Re-print     ./scripts/local-eval/up.sh --skip-cli
   Tear down    docker compose -f docker-compose.dev.yml down -v

   ⚠ Local evaluation mode — authentication is disabled.
     All ports bind to 127.0.0.1; never expose this stack.
==============================================================
EOF
