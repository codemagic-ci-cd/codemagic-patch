#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/selfhost/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

TARGET_IMAGE=""
LOCAL_IMAGE=0

usage() {
  cat <<'USAGE'
Usage: scripts/selfhost/schema-check.sh --image <ref> [--local-image]

Runs the schema check of the server image <ref> against the database this
deployment runs on: whether the database has applied a migration the image
does not know, which would mean that server is older than the database's
schema. The image reads the database with the server's own connection
settings, from this deployment's env file. Reads only: the image is pulled
(a plain docker pull) and run as a one-off container; nothing is started or
changed in the stack.

Options:
  --image <ref>    The server image to check, the one an upgrade would run.
  --local-image    <ref> is a locally built tag: do not pull it (it must
                   already exist).
  -h, --help       Show this help.

Prints schema_check=ok|unknown|unreachable|unsupported|error (and
unknown_migrations= or schema_error=) on stdout, the explanation on stderr.
Exits 0 when the database is compatible, 3 when it has migrations the image
does not know, 4 when the database could not be reached, 5 when the image
predates the check, 1 on anything else (the image could not be pulled, say).
upgrade.sh runs the same check before it changes anything.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --image)
      [ -n "${2:-}" ] || fail_selfhost "--image needs an image reference"
      TARGET_IMAGE="$2"; shift 2 ;;
    --local-image) LOCAL_IMAGE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail_selfhost "unknown argument: $1" ;;
  esac
done
[ -n "$TARGET_IMAGE" ] || fail_selfhost "--image <ref> is required: the check is the server image's own"

require_command_selfhost docker
# The deployment's own database settings, over anything exported in the
# caller's shell (which compose would otherwise prefer to --env-file).
load_selfhost_env

# stdout carries only the key=value report; docker's pull progress goes to
# stderr with the rest of the explanation.
if ! selfhost_fetch_server_image "$TARGET_IMAGE" "$LOCAL_IMAGE" >&2; then
  printf 'schema_check=error\nschema_error=%s\n' "$SELFHOST_SCHEMA_ERROR"
  warn_selfhost "${SELFHOST_SCHEMA_ERROR}. Nothing was changed."
  exit 1
fi

status=0
selfhost_schema_compat "$TARGET_IMAGE" || status=$?
case "$status" in
  0)
    printf 'schema_check=ok\n'
    log_selfhost "the database's ${SELFHOST_SCHEMA_APPLIED_COUNT:-applied} migrations are all known to ${TARGET_IMAGE}" >&2
    ;;
  3) printf 'schema_check=unknown\nunknown_migrations=%s\n' "$SELFHOST_SCHEMA_UNKNOWN" ;;
  4) printf 'schema_check=unreachable\nschema_error=%s\n' "$SELFHOST_SCHEMA_ERROR" ;;
  5) printf 'schema_check=unsupported\n' ;;
  *) printf 'schema_check=error\nschema_error=%s\n' "${SELFHOST_SCHEMA_ERROR:-exit ${SELFHOST_SCHEMA_EXIT}}" ;;
esac
[ "$status" -eq 0 ] || warn_selfhost "$(selfhost_schema_message "$status" "$TARGET_IMAGE")"
exit "$status"
