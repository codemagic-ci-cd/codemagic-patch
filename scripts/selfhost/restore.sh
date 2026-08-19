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
  --restore-env         Replace .env.selfhost (and docker-compose.selfhost.override.yml
                        and gcs-service-account.json, when the backup contains
                        them) with the backup's copies.
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

BACKUP_MANIFEST_FILE="${BACKUP_DIR}/backup-manifest"

# backup-manifest KEY=VALUE reader (last assignment wins). backup.sh writes
# plain unquoted lines; nothing fancier is a manifest we wrote.
backup_manifest_value() {
  local key="$1" line
  line="$(grep -E "^${key}=" "$BACKUP_MANIFEST_FILE" | tail -n 1)" || return 0
  printf '%s' "${line#*=}"
}

# CMP-60: the manifest decides which artifacts this backup must contain and
# which components the restore touches. Backups without one predate the mode
# split and are bundled(x)bundled by construction. Unrecognized values fail
# hard — guessing a mode here would wipe or skip the wrong component.
BACKUP_DB_MODE=bundled
BACKUP_STORAGE_MODE=bundled
if [ -f "$BACKUP_MANIFEST_FILE" ]; then
  BACKUP_DB_MODE="$(backup_manifest_value database_mode)"
  BACKUP_STORAGE_MODE="$(backup_manifest_value storage_mode)"
  # A manifest backup.sh wrote always carries both keys; a truncated or edited
  # one must not silently degrade to bundled.
  [ -n "$BACKUP_DB_MODE" ] || fail_selfhost "${BACKUP_MANIFEST_FILE} exists but has no database_mode= line; the manifest is truncated or was edited. Fix it (database_mode=bundled|external) before restoring."
  [ -n "$BACKUP_STORAGE_MODE" ] || fail_selfhost "${BACKUP_MANIFEST_FILE} exists but has no storage_mode= line; the manifest is truncated or was edited. Fix it (storage_mode=bundled|s3|gcs) before restoring."
fi
case "$BACKUP_DB_MODE" in
  bundled | external) ;;
  *) fail_selfhost "${BACKUP_MANIFEST_FILE} records database_mode=${BACKUP_DB_MODE}, which this restore.sh does not recognize (allowed values: bundled, external). The backup may come from a newer release — run its matching restore.sh — or the manifest was edited; fix it before restoring." ;;
esac
case "$BACKUP_STORAGE_MODE" in
  bundled | s3 | gcs) ;;
  *) fail_selfhost "${BACKUP_MANIFEST_FILE} records storage_mode=${BACKUP_STORAGE_MODE}, which this restore.sh does not recognize (allowed values: bundled, s3, gcs). The backup may come from a newer release — run its matching restore.sh — or the manifest was edited; fix it before restoring." ;;
esac

# Cross-check the manifest against the backup's OWN env file before trusting
# it. backup.sh derives the manifest from that env, so a disagreement means the
# backup was edited or hand-assembled — and on a fresh host, where there is no
# current deployment to compare against, a manifest claiming external modes
# would otherwise waive the dump/archive requirements while the backup's env
# assembles a bundled stack: an empty deployment reported as a successful
# restore.
BACKUP_ENV_DB_MODE="$(SELFHOST_ENV_FILE="${BACKUP_DIR}/env.selfhost" selfhost_mode_from_env_file SELFHOST_DATABASE_MODE)"
BACKUP_ENV_STORAGE_MODE="$(SELFHOST_ENV_FILE="${BACKUP_DIR}/env.selfhost" selfhost_mode_from_env_file SELFHOST_STORAGE_MODE)"
if [ "${BACKUP_ENV_DB_MODE:-bundled}" != "$BACKUP_DB_MODE" ]; then
  fail_selfhost "${BACKUP_MANIFEST_FILE} records database_mode=${BACKUP_DB_MODE} but the backup's own env.selfhost sets SELFHOST_DATABASE_MODE=${BACKUP_ENV_DB_MODE:-bundled}. backup.sh writes these from the same source, so this backup was edited or assembled by hand — do not restore it until the inconsistency is resolved."
fi
if [ "${BACKUP_ENV_STORAGE_MODE:-bundled}" != "$BACKUP_STORAGE_MODE" ]; then
  fail_selfhost "${BACKUP_MANIFEST_FILE} records storage_mode=${BACKUP_STORAGE_MODE} but the backup's own env.selfhost sets SELFHOST_STORAGE_MODE=${BACKUP_ENV_STORAGE_MODE:-bundled}. backup.sh writes these from the same source, so this backup was edited or assembled by hand — do not restore it until the inconsistency is resolved."
fi

if [ "$BACKUP_DB_MODE" = "bundled" ]; then
  [ -f "${BACKUP_DIR}/postgres.dump" ] || fail_selfhost "missing ${BACKUP_DIR}/postgres.dump"
fi
MINIO_ARCHIVE=""
if [ "$BACKUP_STORAGE_MODE" = "bundled" ]; then
  if [ -f "${BACKUP_DIR}/minio-codemagic-patch.tar.gz" ]; then
    MINIO_ARCHIVE="${BACKUP_DIR}/minio-codemagic-patch.tar.gz"
  else
    fail_selfhost "missing ${BACKUP_DIR}/minio-codemagic-patch.tar.gz"
  fi
fi
# A gcs deployment cannot boot without the service-account key the storage
# overlay mounts. The key may come from the backup OR already sit at the host
# path (backup.sh refuses to produce a keyless gcs backup, but backups from
# before that guard exist, and operators legitimately keep the key out of
# off-site backups) — only when NEITHER exists is the restore unbootable.
if [ "$BACKUP_STORAGE_MODE" = "gcs" ] &&
  [ ! -f "${BACKUP_DIR}/gcs-service-account.json" ] &&
  [ ! -f "$SELFHOST_GCS_KEY_FILE" ]; then
  fail_selfhost "this backup records storage_mode=gcs but contains no gcs-service-account.json, and none exists at ${SELFHOST_GCS_KEY_FILE} — the restored stack cannot boot without the service-account key. Use a backup that contains it, or place the key at ${SELFHOST_GCS_KEY_FILE} yourself, then rerun."
fi

# CMP-60: refuse a cross-mode restore before ANY action — including the safety
# backup and the --restore-env env install — so no flag can bypass it.
# Switching a deployment between bundled and external database/storage is a
# manual data migration these scripts do not perform. On a fresh host (no env
# file) there is nothing to compare: the backup's env gets installed, and the
# cross-check above has verified it agrees with the manifest.
CURRENT_DB_MODE="$(selfhost_mode_from_env_file SELFHOST_DATABASE_MODE)"
CURRENT_DB_MODE="${CURRENT_DB_MODE:-bundled}"
CURRENT_STORAGE_MODE="$(selfhost_mode_from_env_file SELFHOST_STORAGE_MODE)"
CURRENT_STORAGE_MODE="${CURRENT_STORAGE_MODE:-bundled}"
if [ -f "$SELFHOST_ENV_FILE" ]; then
  if [ "$CURRENT_DB_MODE" != "$BACKUP_DB_MODE" ]; then
    fail_selfhost "this backup was taken from a deployment with database mode '${BACKUP_DB_MODE}' but the current deployment uses '${CURRENT_DB_MODE}' (SELFHOST_DATABASE_MODE in ${SELFHOST_ENV_FILE}). Switching between the bundled and an external database is a manual data migration these scripts do not perform: restore onto a deployment in the same mode, or migrate the data yourself first."
  fi
  if [ "$CURRENT_STORAGE_MODE" != "$BACKUP_STORAGE_MODE" ]; then
    fail_selfhost "this backup was taken from a deployment with storage mode '${BACKUP_STORAGE_MODE}' but the current deployment uses '${CURRENT_STORAGE_MODE}' (SELFHOST_STORAGE_MODE in ${SELFHOST_ENV_FILE}). Switching between the bundled and external storage is a manual data migration these scripts do not perform: restore onto a deployment in the same mode, or migrate the data yourself first."
  fi
fi

# The external components' point-in-time reminder needs the backup's anchor;
# versions.txt has carried created_at= since the first backup.sh, but degrade
# gracefully if a hand-assembled backup lacks it.
BACKUP_CREATED_AT=""
if [ -f "${BACKUP_DIR}/versions.txt" ]; then
  BACKUP_CREATED_AT="$(grep -E '^created_at=' "${BACKUP_DIR}/versions.txt" | head -n 1)" || true
  BACKUP_CREATED_AT="${BACKUP_CREATED_AT#created_at=}"
fi
if [ -z "$BACKUP_CREATED_AT" ]; then
  BACKUP_CREATED_AT="unknown (versions.txt has no created_at line; fall back to the timestamp in the backup directory name)"
fi
EXTERNAL_COMPONENTS=""
if [ "$BACKUP_DB_MODE" != "bundled" ]; then
  EXTERNAL_COMPONENTS="database"
fi
if [ "$BACKUP_STORAGE_MODE" != "bundled" ]; then
  EXTERNAL_COMPONENTS="${EXTERNAL_COMPONENTS:+${EXTERNAL_COMPONENTS} and }storage bucket"
fi
EXTERNAL_REMINDER=""
if [ -n "$EXTERNAL_COMPONENTS" ]; then
  EXTERNAL_REMINDER="This backup does NOT contain the deployment's external ${EXTERNAL_COMPONENTS}. For a coherent restore, use your provider's tooling (e.g. RDS point-in-time recovery, bucket versioning) to restore the external ${EXTERNAL_COMPONENTS} to this backup's created_at=${BACKUP_CREATED_AT} — these scripts cannot verify or restore external state."
fi

require_command_selfhost docker
require_command_selfhost tar
docker compose version >/dev/null || fail_selfhost "Docker Compose v2 is required"

# Name only the components this restore actually replaces (per the manifest).
REPLACED_COMPONENTS=""
if [ "$BACKUP_DB_MODE" = "bundled" ]; then
  REPLACED_COMPONENTS="PostgreSQL"
fi
if [ "$BACKUP_STORAGE_MODE" = "bundled" ]; then
  REPLACED_COMPONENTS="${REPLACED_COMPONENTS:+${REPLACED_COMPONENTS} and }MinIO"
fi

if [ "$ASSUME_YES" -eq 0 ]; then
  confirm_selfhost_destructive_action \
    "This REPLACES the current ${REPLACED_COMPONENTS:-configuration} data with the contents of ${BACKUP_DIR}. Unless --skip-safety-backup is given, a pre-restore safety backup of the current data is taken first so you can roll back if the restore fails.${EXTERNAL_REMINDER:+ ${EXTERNAL_REMINDER}}" \
    "restore"
fi

# Compose names volumes "<project>_<volume>".
postgres_volume="${SELFHOST_PROJECT_NAME}_postgres-selfhost-data"
minio_volume="${SELFHOST_PROJECT_NAME}_minio-selfhost-data"

# Reinstall a MISSING gcs key before the safety backup: backup.sh (invoked for
# the safety backup below) refuses to run a gcs-mode backup without the key,
# so a lost key would otherwise deadlock the exact restore that is meant to
# bring it back. The --restore-env overwrite of an existing key stays below,
# after the safety backup has captured the current one.
if [ -f "${BACKUP_DIR}/gcs-service-account.json" ] && [ ! -f "$SELFHOST_GCS_KEY_FILE" ]; then
  if [ -d "$SELFHOST_GCS_KEY_FILE" ]; then
    # A compose up that ran while the key was missing leaves an empty
    # docker-created directory at the bind-mount source; clear it so the key
    # can land. A non-empty directory is not docker's — leave it to the
    # operator rather than deleting data.
    rmdir "$SELFHOST_GCS_KEY_FILE" 2>/dev/null ||
      fail_selfhost "a non-empty directory exists at ${SELFHOST_GCS_KEY_FILE} (an empty one would be docker's leftover from running without the key); move it aside, then rerun"
  fi
  install -m 600 "${BACKUP_DIR}/gcs-service-account.json" "$SELFHOST_GCS_KEY_FILE"
  log_selfhost "restored missing ${SELFHOST_GCS_KEY_FILE} from the backup (required before the safety backup can run in gcs mode)"
fi

# US28: back up the current data before the destructive replacement. Run this
# with the CURRENT env (before any --restore-env overwrite below), so a failed
# restore can be rolled back. Keyed on the env file, not on the bundled data
# volumes: backup.sh is mode-aware and dumps only what is bundled, and even an
# external-mode deployment has an env + override worth a safety copy.
#
# The bundled components keep their "only when there is existing data to lose"
# guard, though: with bundled modes but NONE of their volumes present (a fresh
# host with a restored env file, or after a documented reset) the safety
# backup would first CREATE fresh empty volumes — and a fresh MinIO brought up
# without minio-init has no bucket, so the nested backup.sh would fail the
# whole restore. external(x)external has no bundled volumes by design; its
# config-only safety backup (the --restore-env rollback path) still runs.
SAFETY_HAS_BUNDLED_COMPONENT=0
SAFETY_HAS_BUNDLED_DATA=0
if [ "$CURRENT_DB_MODE" = "bundled" ]; then
  SAFETY_HAS_BUNDLED_COMPONENT=1
  if docker volume inspect "$postgres_volume" >/dev/null 2>&1; then
    SAFETY_HAS_BUNDLED_DATA=1
  fi
fi
if [ "$CURRENT_STORAGE_MODE" = "bundled" ]; then
  SAFETY_HAS_BUNDLED_COMPONENT=1
  if docker volume inspect "$minio_volume" >/dev/null 2>&1; then
    SAFETY_HAS_BUNDLED_DATA=1
  fi
fi
if [ -f "$SELFHOST_ENV_FILE" ] &&
  [ "$SAFETY_HAS_BUNDLED_COMPONENT" -eq 1 ] && [ "$SAFETY_HAS_BUNDLED_DATA" -eq 0 ]; then
  warn_selfhost "skipping the pre-restore safety backup: the deployment's bundled data volumes do not exist yet, so there is no current data to protect (a safety backup would only create fresh empty volumes)"
elif [ -f "$SELFHOST_ENV_FILE" ]; then
  if [ "$SKIP_SAFETY_BACKUP" -eq 1 ]; then
    warn_selfhost "skipping pre-restore safety backup (--skip-safety-backup); current data will be UNRECOVERABLE if this restore fails"
  else
    safety_root="${SELFHOST_BACKUP_ROOT:-${SELFHOST_REPO_ROOT}/backups}/pre-restore"
    log_selfhost "creating a pre-restore safety backup of the current stack under ${safety_root}"
    # Ensure the bundled data services are up so the backup can dump them even
    # if the stack was stopped (idempotent; backup.sh quiesces the server).
    # Mode-aware from the CURRENT env file: an external mode has no such
    # service in the assembled stack, so naming it would fail the up.
    safety_up_services=()
    if [ "$CURRENT_DB_MODE" = "bundled" ]; then
      safety_up_services+=(postgres)
    fi
    if [ "$CURRENT_STORAGE_MODE" = "bundled" ]; then
      safety_up_services+=(minio)
    fi
    if [ "${#safety_up_services[@]}" -gt 0 ]; then
      compose_selfhost up -d "${safety_up_services[@]}"
    fi
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

# The compose override travels with the env file (which may require it via
# SELFHOST_REQUIRE_COMPOSE_OVERRIDE): restore it under the same conditions,
# plus whenever the current one is missing — a lost override otherwise makes
# every compose call below fail until the installer that wrote it is re-run.
if [ -f "${BACKUP_DIR}/docker-compose.selfhost.override.yml" ] &&
  { [ ! -f "$SELFHOST_COMPOSE_OVERRIDE_FILE" ] || [ "$RESTORE_ENV" -eq 1 ]; }; then
  install -m 600 "${BACKUP_DIR}/docker-compose.selfhost.override.yml" \
    "$SELFHOST_COMPOSE_OVERRIDE_FILE"
  log_selfhost "restored ${SELFHOST_COMPOSE_OVERRIDE_FILE}"
fi

# The GCS service-account key travels with the env file the same way, missing-
# file nuance included: in gcs mode the storage overlay bind-mounts it into
# the server container, so a lost key breaks the stack exactly like a lost
# required override — restore it also whenever the current one is absent.
if [ -f "${BACKUP_DIR}/gcs-service-account.json" ] &&
  { [ ! -f "$SELFHOST_GCS_KEY_FILE" ] || [ "$RESTORE_ENV" -eq 1 ]; }; then
  install -m 600 "${BACKUP_DIR}/gcs-service-account.json" "$SELFHOST_GCS_KEY_FILE"
  log_selfhost "restored ${SELFHOST_GCS_KEY_FILE}"
fi

load_selfhost_env
# The restored env may predate mandatory OAuth (notably with --restore-env);
# validate and backfill before any destructive step so the stack can boot.
ensure_selfhost_oauth_env

# Backups taken before the override was included cannot satisfy an env file
# that requires one. Fail here, before any destructive step, instead of
# tripping the compose guard mid-restore at the first compose call.
if [ ! -f "$SELFHOST_COMPOSE_OVERRIDE_FILE" ] && selfhost_compose_override_required; then
  fail_selfhost "the restored env requires ${SELFHOST_COMPOSE_OVERRIDE_FILE} (SELFHOST_REQUIRE_COMPOSE_OVERRIDE=true) but neither this host nor the backup has it — this backup predates override inclusion. Re-run the installer that wrote the override (it reuses the restored env file), then re-run this restore."
fi

# DR7: assert values dereferenced after the wipe are present now, so a missing
# one fails before the destructive step instead of tripping `set -u` afterward.
# The POSTGRES_* values are only dereferenced by the bundled-database restore.
require_selfhost_env_var SERVER_URL
if [ "$BACKUP_DB_MODE" = "bundled" ]; then
  require_selfhost_env_var POSTGRES_USER
  require_selfhost_env_var POSTGRES_DB
fi

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
# Wipe only the volumes this restore repopulates (per the manifest): the
# mode-mismatch refusal above guarantees the current deployment matches, so a
# skipped component's volume — if any stale one exists — is left untouched.
if [ "$BACKUP_DB_MODE" = "bundled" ]; then
  docker volume rm "$postgres_volume" >/dev/null 2>&1 || true
fi
if [ "$BACKUP_STORAGE_MODE" = "bundled" ]; then
  docker volume rm "$minio_volume" >/dev/null 2>&1 || true
fi

# Bring up only the bundled data services — the assembled stack has no
# postgres/minio service in the external modes, so naming one would fail.
restore_up_services=()
if [ "$BACKUP_DB_MODE" = "bundled" ]; then
  restore_up_services+=(postgres)
fi
if [ "$BACKUP_STORAGE_MODE" = "bundled" ]; then
  restore_up_services+=(minio)
fi
if [ "${#restore_up_services[@]}" -gt 0 ]; then
  log_selfhost "starting ${restore_up_services[*]} for restore"
  compose_selfhost up -d "${restore_up_services[@]}"
  for restore_service in "${restore_up_services[@]}"; do
    wait_for_selfhost_service "$restore_service"
  done
fi

if [ "$BACKUP_DB_MODE" = "bundled" ]; then
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
else
  log_selfhost "external database (database_mode=${BACKUP_DB_MODE}); this script does not restore it"
fi

if [ "$BACKUP_STORAGE_MODE" = "bundled" ]; then
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
else
  log_selfhost "external storage (storage_mode=${BACKUP_STORAGE_MODE}); this script does not restore the bucket"
fi

log_selfhost "starting full stack"
compose_selfhost up -d
wait_for_selfhost_service server
wait_for_selfhost_http "${SERVER_URL%/}/health" "API health" 120

if [ "$SKIP_SMOKE" -eq 0 ]; then
  "$SELFHOST_REPO_ROOT/scripts/selfhost/smoke.sh"
fi

RESTORE_COMPLETE=1
log_selfhost "restore complete"
if [ -n "$EXTERNAL_REMINDER" ]; then
  warn_selfhost "$EXTERNAL_REMINDER"
fi
