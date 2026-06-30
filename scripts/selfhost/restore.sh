#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/selfhost/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

ASSUME_YES=0
RESTORE_ENV=0
SKIP_SMOKE=0
SKIP_SAFETY_BACKUP=0
BACKUP_DIR=""
SAFETY_BACKUP_DIR=""
RESTORE_COMPLETE=0

usage() {
  cat <<'USAGE'
Usage: scripts/selfhost/restore.sh [options] <backup-directory>

Options:
  --restore-env         Replace .env.selfhost with env.selfhost from the backup.
  --skip-smoke          Start the stack and check health, but skip publish smoke.
  --skip-safety-backup  Do not back up the current data before replacing it.
                        Unsafe: a failed restore becomes unrecoverable.
  -y, --yes             Confirm destructive volume replacement.
  -h, --help            Show this help.

Set CODEMAGIC_PATCH_TOKEN=cm_pat_... to run the full publish/artifact smoke after
restore; without it only unauthenticated checks run.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --restore-env) RESTORE_ENV=1; shift ;;
    --skip-smoke) SKIP_SMOKE=1; shift ;;
    --skip-safety-backup) SKIP_SAFETY_BACKUP=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)
      [ -z "$BACKUP_DIR" ] || fail_selfhost "only one backup directory may be provided"
      BACKUP_DIR="$1"
      shift
      ;;
  esac
done

[ -n "$BACKUP_DIR" ] || fail_selfhost "backup directory is required"
[ -d "$BACKUP_DIR" ] || fail_selfhost "backup directory not found: ${BACKUP_DIR}"
BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"

[ -f "${BACKUP_DIR}/env.selfhost" ] || fail_selfhost "missing ${BACKUP_DIR}/env.selfhost"
[ -f "${BACKUP_DIR}/postgres.dump" ] || fail_selfhost "missing ${BACKUP_DIR}/postgres.dump"
if [ -f "${BACKUP_DIR}/minio-codemagic-patch.tar.gz" ]; then
  MINIO_ARCHIVE="${BACKUP_DIR}/minio-codemagic-patch.tar.gz"
else
  fail_selfhost "missing ${BACKUP_DIR}/minio-codemagic-patch.tar.gz"
fi

require_command_selfhost docker
require_command_selfhost tar
docker compose version >/dev/null || fail_selfhost "Docker Compose v2 is required"

if [ "$ASSUME_YES" -eq 0 ]; then
  confirm_selfhost_destructive_action \
    "This REPLACES the current PostgreSQL and MinIO data with the contents of ${BACKUP_DIR}. Unless --skip-safety-backup is given, a pre-restore safety backup of the current data is taken first so you can roll back if the restore fails." \
    "restore"
fi

# Compose names volumes "<project>_<volume>".
postgres_volume="${SELFHOST_PROJECT_NAME}_postgres-selfhost-data"
minio_volume="${SELFHOST_PROJECT_NAME}_minio-selfhost-data"

# US28: back up the current data before the destructive replacement. Run this
# with the CURRENT env (before any --restore-env overwrite below) and only when
# there is existing data to lose, so a failed restore can be rolled back.
if [ -f "$SELFHOST_ENV_FILE" ] &&
  { docker volume inspect "$postgres_volume" >/dev/null 2>&1 ||
    docker volume inspect "$minio_volume" >/dev/null 2>&1; }; then
  if [ "$SKIP_SAFETY_BACKUP" -eq 1 ]; then
    warn_selfhost "skipping pre-restore safety backup (--skip-safety-backup); current data will be UNRECOVERABLE if this restore fails"
  else
    safety_root="${SELFHOST_BACKUP_ROOT:-${SELFHOST_REPO_ROOT}/backups}/pre-restore"
    log_selfhost "creating a pre-restore safety backup of the current stack under ${safety_root}"
    # Ensure the data services are up so the backup can dump them even if the
    # stack was stopped (idempotent; backup.sh quiesces the server).
    compose_selfhost up -d postgres minio
    if "$SELFHOST_REPO_ROOT/scripts/selfhost/backup.sh" "$safety_root"; then
      # Backup dirs are timestamped (no special chars), so ls -t is safe here.
      # shellcheck disable=SC2012
      SAFETY_BACKUP_DIR="$(ls -dt "${safety_root}"/codemagic-patch-selfhost-* 2>/dev/null | head -n1 || true)"
      log_selfhost "pre-restore safety backup complete: ${SAFETY_BACKUP_DIR:-${safety_root}}"
    else
      fail_selfhost "pre-restore safety backup failed; aborting before touching your data. Fix the cause, or re-run with --skip-safety-backup to proceed WITHOUT a safety net (current data will be unrecoverable if the restore fails)."
    fi
  fi
fi

if [ ! -f "$SELFHOST_ENV_FILE" ] || [ "$RESTORE_ENV" -eq 1 ]; then
  install -m 600 "${BACKUP_DIR}/env.selfhost" "$SELFHOST_ENV_FILE"
  log_selfhost "restored ${SELFHOST_ENV_FILE}"
fi

load_selfhost_env
# The restored env may predate mandatory OAuth (notably with --restore-env);
# validate and backfill before any destructive step so the stack can boot.
ensure_selfhost_oauth_env

# DR7: assert values dereferenced after the wipe are present now, so a missing
# one fails before the destructive step instead of tripping `set -u` afterward.
require_selfhost_env_var SERVER_URL
require_selfhost_env_var POSTGRES_USER
require_selfhost_env_var POSTGRES_DB

restore_tmp="$(mktemp -d)"
cleanup() {
  local exit_code=$?
  rm -rf "${restore_tmp:-}"
  # After the destructive step any failure leaves the stack mid-restore; point
  # the operator at the safety backup so they can roll back. --restore-env is
  # required so the safety backup's original env is restored too (this run may
  # have replaced .env.selfhost via --restore-env); --skip-safety-backup avoids
  # re-backing-up the broken intermediate state, which could block recovery.
  if [ "$exit_code" -ne 0 ] && [ "$RESTORE_COMPLETE" -ne 1 ] && [ -n "$SAFETY_BACKUP_DIR" ]; then
    warn_selfhost "restore did not complete. Roll back to the previous state with: scripts/selfhost/restore.sh --restore-env --skip-safety-backup ${SAFETY_BACKUP_DIR}"
  fi
  exit "$exit_code"
}
trap cleanup EXIT

log_selfhost "stopping stack"
compose_selfhost down
docker volume rm "$postgres_volume" >/dev/null 2>&1 || true
docker volume rm "$minio_volume" >/dev/null 2>&1 || true

log_selfhost "starting PostgreSQL and MinIO for restore"
compose_selfhost up -d postgres minio
wait_for_selfhost_service postgres
wait_for_selfhost_service minio

log_selfhost "restoring PostgreSQL"
# pg_restore --clean --if-exists routinely reports ignorable errors (it issues
# DROPs for objects that never existed in the freshly wiped database) and exits
# non-zero. Under set -e that benign status would abort the script with the
# volumes already wiped and the database half-loaded. Capture the status and
# verify the actual result below instead of trusting the exit code.
set +e
compose_selfhost exec -T postgres \
  pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists \
  <"${BACKUP_DIR}/postgres.dump"
pg_restore_status=$?
set -e
if [ "$pg_restore_status" -ne 0 ]; then
  warn_selfhost "pg_restore exited with status ${pg_restore_status}; this is expected with --clean --if-exists on a fresh database. Verifying the restored data before continuing."
fi

# Verify the dump actually loaded — don't trust pg_restore's exit code or the
# liveness-only /health probe. A real restore has tables in the public schema.
restored_table_count="$(compose_selfhost exec -T postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAXc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'" \
  2>/dev/null | tr -d '[:space:]')" || true
case "$restored_table_count" in
  '' | *[!0-9]*) restored_table_count=0 ;;
esac
if [ "$restored_table_count" -lt 1 ]; then
  fail_selfhost "PostgreSQL restore looks empty (no tables in the public schema); the restore did not succeed."
fi
log_selfhost "PostgreSQL restore verified (${restored_table_count} tables)"

log_selfhost "restoring MinIO bucket codemagic-patch"
mkdir -p "${restore_tmp}/minio"
tar -xzf "$MINIO_ARCHIVE" -C "${restore_tmp}/minio"
[ -d "${restore_tmp}/minio/minio-codemagic-patch" ] ||
  fail_selfhost "MinIO archive did not contain minio-codemagic-patch/"

compose_selfhost run --rm --no-deps \
  -v "${restore_tmp}/minio/minio-codemagic-patch:/restore/minio-codemagic-patch:ro" \
  --entrypoint /bin/sh \
  minio-init -c '
    set -eu
    mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
    mc mb --ignore-existing local/codemagic-patch
    mc mirror --overwrite --remove /restore/minio-codemagic-patch local/codemagic-patch
    mc anonymous set-json /policy/codemagic-patch-bucket-policy.json local/codemagic-patch
  '

log_selfhost "starting full stack"
compose_selfhost up -d
wait_for_selfhost_service server
wait_for_selfhost_http "${SERVER_URL%/}/health" "API health" 120

if [ "$SKIP_SMOKE" -eq 0 ]; then
  "$SELFHOST_REPO_ROOT/scripts/selfhost/smoke.sh"
fi

RESTORE_COMPLETE=1
log_selfhost "restore complete"
