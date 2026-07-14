#!/usr/bin/env bash
set -euo pipefail

# Seed the shared Example Data demo catalog into a running self-host stack
# (apps/deployments/releases + metric_event rows). Does not create auth users
# or tokens; safe to re-run to refresh relative metric timestamps.
#
# Usage:
#   scripts/selfhost/seed-demo-data.sh
#   scripts/selfhost/install.sh --with-demo-data …

# shellcheck source=scripts/selfhost/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

DEMO_SQL="${SELFHOST_REPO_ROOT}/examples/fixtures/demo-example-app.sql"

[ -f "$DEMO_SQL" ] || fail_selfhost "missing demo fixture at ${DEMO_SQL}"

load_selfhost_env
require_selfhost_env_var POSTGRES_USER
require_selfhost_env_var POSTGRES_DB
require_selfhost_service_running postgres
require_selfhost_service_running server

log_selfhost "seeding Example Data into ${POSTGRES_DB}"
compose_selfhost exec -T postgres \
  psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -v ON_ERROR_STOP=1 \
  <"$DEMO_SQL"
log_selfhost "Example Data ready (Staging + Production releases and metrics)"
