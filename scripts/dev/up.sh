#!/usr/bin/env bash
# One-command local stack: API + worker + Postgres + MinIO + mock GitHub + dashboard.
#
#   ./scripts/dev/up.sh
#
# Open http://127.0.0.1:5173/login → Continue with GitHub (mock, no real GitHub).
# API (direct): http://localhost:3000
# MinIO console: http://localhost:9101 (minio / minio12345)
#
# Tear down and wipe data:
#   docker compose -f docker-compose.dev.yml -f docker-compose.dev.local.yml down -v

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${REPO_ROOT}"

COMPOSE_FILES=(-f docker-compose.dev.yml)
if [[ -f docker-compose.dev.local.yml ]]; then
  COMPOSE_FILES+=(-f docker-compose.dev.local.yml)
fi

docker compose "${COMPOSE_FILES[@]}" up --build "$@"
