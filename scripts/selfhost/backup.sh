#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/selfhost/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

BACKUP_ROOT="${SELFHOST_BACKUP_ROOT:-${SELFHOST_REPO_ROOT}/backups}"
SERVER_WAS_RUNNING=0
BACKUP_COMPLETE=0
backup_dir_abs=""

usage() {
  cat <<'USAGE'
Usage: scripts/selfhost/backup.sh [backup-root]

Creates a timestamped backup directory containing:
  env.selfhost
  docker-compose.selfhost.override.yml  (when the deployment uses one)
  gcs-service-account.json              (when the deployment has one)
  backup-manifest                       (KEY=VALUE lines: database_mode=..., storage_mode=...)
  versions.txt                          (its created_at= line is the backup's point-in-time anchor)
  postgres.dump                         (bundled database mode only)
  minio-codemagic-patch.tar.gz          (bundled storage mode only)

External components (SELFHOST_DATABASE_MODE=external, SELFHOST_STORAGE_MODE=s3|gcs)
are NOT included: protect them with your provider's tooling (e.g. RDS snapshots,
bucket versioning) and pair any restore of this backup with restoring the external
component to the backup's created_at timestamp.
USAGE
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

if [ "${1:-}" != "" ]; then
  BACKUP_ROOT="$1"
fi

backup_cleanup() {
  local exit_code=$?

  # A partial dump/archive must never be left behind looking like a finished
  # backup. If we never reached completion, drop the incomplete directory.
  if [ "$BACKUP_COMPLETE" -ne 1 ] && [ -n "$backup_dir_abs" ] && [ -d "$backup_dir_abs" ]; then
    warn_selfhost "backup did not complete; removing incomplete ${backup_dir_abs}"
    rm -rf "$backup_dir_abs"
  fi

  if [ "$SERVER_WAS_RUNNING" -eq 1 ]; then
    log_selfhost "restarting server after backup"
    if ! compose_selfhost up -d server; then
      exit_code=1
    fi
  fi

  exit "$exit_code"
}

quiesce_server_for_backup() {
  local any_server running_server
  # DR32: a present-but-not-running server (e.g. restarting/crash-looping) is NOT
  # safely quiesced — it can wake up and write mid-backup. Only skip stopping
  # when there is no server container at all; otherwise stop it regardless of
  # state, and restart afterward only if it was actually running.
  any_server="$(compose_selfhost ps -aq server 2>/dev/null || true)"
  if [ -z "$any_server" ]; then
    log_selfhost "no server container present; backing up the current data state"
    return
  fi

  running_server="$(compose_selfhost ps --status running -q server 2>/dev/null || true)"
  if [ -n "$running_server" ]; then
    SERVER_WAS_RUNNING=1
  fi

  log_selfhost "stopping the server to quiesce writes during backup"
  compose_selfhost stop server
}

require_command_selfhost docker
require_command_selfhost tar
docker compose version >/dev/null || fail_selfhost "Docker Compose v2 is required"
load_selfhost_env

# CMP-60: the modes come from the env file (the same authority compose_selfhost
# uses to assemble the stack). Validate before anything is written — an
# unrecognized value must never be recorded in a backup manifest, where a later
# restore would trip over it.
DB_MODE="$(selfhost_mode_from_env_file SELFHOST_DATABASE_MODE)"
DB_MODE="${DB_MODE:-bundled}"
STORAGE_MODE="$(selfhost_mode_from_env_file SELFHOST_STORAGE_MODE)"
STORAGE_MODE="${STORAGE_MODE:-bundled}"
case "$DB_MODE" in
  bundled | external) ;;
  *) fail_selfhost "SELFHOST_DATABASE_MODE=${DB_MODE} in ${SELFHOST_ENV_FILE} is not a recognized value; allowed values: bundled, external. Fix the flag, then rerun." ;;
esac
case "$STORAGE_MODE" in
  bundled | s3 | gcs) ;;
  *) fail_selfhost "SELFHOST_STORAGE_MODE=${STORAGE_MODE} in ${SELFHOST_ENV_FILE} is not a recognized value; allowed values: bundled, s3, gcs. Fix the flag, then rerun." ;;
esac

# A gcs backup without the service-account key is not restorable on a fresh
# host (the storage overlay bind-mounts the key; the stack cannot boot without
# it), so refuse to produce one instead of reporting success. A missing key
# also means this deployment itself cannot boot — fix that first.
if [ "$STORAGE_MODE" = "gcs" ] && [ ! -f "$SELFHOST_GCS_KEY_FILE" ]; then
  fail_selfhost "missing ${SELFHOST_GCS_KEY_FILE} — this deployment records SELFHOST_STORAGE_MODE=gcs and a backup without the service-account key cannot be restored on a fresh host. Restore the key (it is in previous backups, or copy it from your secret store), then rerun."
fi

# US29: a backup needs the bundled data services live (pg_dump / mc mirror). If
# the stack is down, fail fast with a clear message instead of creating a backup
# directory and then hanging on wait_for_selfhost_service's full timeout.
# External components are never dumped by this script, so only the bundled
# services are preflighted.
if [ "$DB_MODE" = "bundled" ]; then
  require_selfhost_service_running postgres
fi
if [ "$STORAGE_MODE" = "bundled" ]; then
  require_selfhost_service_running minio
fi

timestamp="$(date -u +%Y-%m-%dT%H%M%SZ)"
backup_dir="${BACKUP_ROOT%/}/codemagic-patch-selfhost-${timestamp}"
mkdir -p "$backup_dir"
backup_dir_abs="$(cd "$backup_dir" && pwd)"
chmod 700 "$backup_dir_abs"
trap backup_cleanup EXIT

log_selfhost "writing backup to ${backup_dir_abs}"
install -m 600 "$SELFHOST_ENV_FILE" "${backup_dir_abs}/env.selfhost"
# The compose override is part of the deployment's identity (the env file may
# even require it via SELFHOST_REQUIRE_COMPOSE_OVERRIDE); back it up alongside
# the env file so a restore onto a fresh host is self-contained.
if [ -f "$SELFHOST_COMPOSE_OVERRIDE_FILE" ]; then
  install -m 600 "$SELFHOST_COMPOSE_OVERRIDE_FILE" \
    "${backup_dir_abs}/docker-compose.selfhost.override.yml"
fi
# The GCS service-account key travels with the env file for the same reason:
# in gcs mode the storage overlay bind-mounts it into the server container and
# the stack cannot boot without it. Presence-keyed like the override (and like
# the overlay's own bind mount), not keyed on the storage mode flag.
if [ -f "$SELFHOST_GCS_KEY_FILE" ]; then
  install -m 600 "$SELFHOST_GCS_KEY_FILE" "${backup_dir_abs}/gcs-service-account.json"
fi

# CMP-60: record the deployment's modes so restore.sh can require exactly the
# artifacts this backup contains and refuse a cross-mode restore. Plain
# KEY=VALUE lines, trivially parseable from bash. versions.txt stays untouched:
# its created_at= line remains the backup's official point-in-time anchor.
{
  printf 'database_mode=%s\n' "$DB_MODE"
  printf 'storage_mode=%s\n' "$STORAGE_MODE"
} >"${backup_dir_abs}/backup-manifest"

# CMP-60: with BOTH components external there is nothing to dump — this is a
# config-only backup, and stopping the server would quiesce writes that never
# land in the backup anyway. Leave the server alone.
if [ "$DB_MODE" = "bundled" ] || [ "$STORAGE_MODE" = "bundled" ]; then
  quiesce_server_for_backup
else
  log_selfhost "database and storage are both external; config-only backup, leaving the server running"
fi
if [ "$DB_MODE" = "bundled" ]; then
  wait_for_selfhost_service postgres
fi
if [ "$STORAGE_MODE" = "bundled" ]; then
  wait_for_selfhost_service minio
fi

# created_at is the point-in-time anchor operators restore external components
# to, so capture it AFTER the server quiesce: writes accepted between the
# script's start and the quiesce land in the bundled dump, and an anchor taken
# earlier would tell the operator to roll the external half back to before
# them, desynchronizing DB<->storage references. The directory name above
# keeps the start timestamp; only the anchor moves. (With both components
# external nothing is quiesced and the anchor is simply the config snapshot
# time.)
created_at="$(date -u +%Y-%m-%dT%H%M%SZ)"
{
  printf 'created_at=%s\n' "$created_at"
  printf 'git_revision='
  git -C "$SELFHOST_REPO_ROOT" rev-parse HEAD 2>/dev/null || printf 'unknown\n'
  printf 'compose_project=%s\n' "$SELFHOST_PROJECT_NAME"
  printf 'compose_file=%s\n' "$SELFHOST_COMPOSE_FILE"
  printf 'server_image=%s\n' "${CODEMAGIC_PATCH_SERVER_IMAGE:-codemagic-patch-server:selfhost}"
  printf '\n[docker compose images]\n'
  compose_selfhost images || true
  printf '\n[docker compose ps]\n'
  compose_selfhost ps || true
  printf '\n[server image inspect]\n'
  docker image inspect "${CODEMAGIC_PATCH_SERVER_IMAGE:-codemagic-patch-server:selfhost}" \
    --format 'id={{.Id}} repo_digests={{json .RepoDigests}}' 2>/dev/null || true
} >"${backup_dir_abs}/versions.txt"

if [ "$DB_MODE" = "bundled" ]; then
  log_selfhost "exporting PostgreSQL"
  compose_selfhost exec -T postgres \
    pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc \
    >"${backup_dir_abs}/postgres.dump.partial"
  # Verify the dump is a readable custom-format archive before promoting it to its
  # final name — otherwise a half-written dump would sit in the backup looking
  # complete. pg_restore --list parses the header + table of contents, catching an
  # empty, truncated-early, or corrupt archive. (It cannot detect truncation within
  # the trailing data blocks; restore.sh re-verifies the loaded result.)
  if ! compose_selfhost exec -T postgres pg_restore --list \
    <"${backup_dir_abs}/postgres.dump.partial" >/dev/null 2>&1; then
    fail_selfhost "PostgreSQL dump is empty, truncated, or corrupt (pg_restore could not read its table of contents); aborting"
  fi
  mv "${backup_dir_abs}/postgres.dump.partial" "${backup_dir_abs}/postgres.dump"
else
  warn_selfhost "the external database (SELFHOST_DATABASE_MODE=${DB_MODE}) is NOT included in this backup; protect it with your provider's tooling (e.g. RDS automated snapshots / point-in-time recovery). A coherent restore of this backup requires restoring the external database to this backup's created_at=${created_at}."
fi

if [ "$STORAGE_MODE" = "bundled" ]; then
  log_selfhost "exporting MinIO bucket codemagic-patch"
  mkdir -p "${backup_dir_abs}/minio-codemagic-patch"
  compose_selfhost run --rm --no-deps \
    -v "${backup_dir_abs}/minio-codemagic-patch:/backup/minio-codemagic-patch" \
    --entrypoint /bin/sh \
    minio-init -c '
      set -eu
      mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
      mc mirror --overwrite --remove local/codemagic-patch /backup/minio-codemagic-patch
    '

  tar -czf "${backup_dir_abs}/minio-codemagic-patch.tar.gz" -C "$backup_dir_abs" minio-codemagic-patch
  rm -rf "${backup_dir_abs}/minio-codemagic-patch"
else
  warn_selfhost "the external storage bucket (SELFHOST_STORAGE_MODE=${STORAGE_MODE}) is NOT included in this backup; protect it with your provider's tooling (e.g. bucket versioning / replication). A coherent restore of this backup requires restoring the bucket to this backup's created_at=${created_at}."
fi

BACKUP_COMPLETE=1
backup_contents="env.selfhost, backup-manifest, versions.txt"
if [ -f "${backup_dir_abs}/docker-compose.selfhost.override.yml" ]; then
  backup_contents="${backup_contents}, docker-compose.selfhost.override.yml"
fi
if [ -f "${backup_dir_abs}/gcs-service-account.json" ]; then
  backup_contents="${backup_contents}, gcs-service-account.json"
fi
backup_omissions=""
if [ "$DB_MODE" = "bundled" ]; then
  backup_contents="${backup_contents}, postgres.dump"
else
  backup_omissions="external database"
fi
if [ "$STORAGE_MODE" = "bundled" ]; then
  backup_contents="${backup_contents}, minio-codemagic-patch.tar.gz"
else
  backup_omissions="${backup_omissions:+${backup_omissions}, }external storage bucket"
fi
printf '\nBackup complete.\n'
printf 'Backup directory:\n  %s\n' "$backup_dir_abs"
printf 'Contains:\n  %s\n' "$backup_contents"
if [ -n "$backup_omissions" ]; then
  printf 'NOT included (protect with provider tooling, restore to created_at=%s):\n  %s\n' \
    "$timestamp" "$backup_omissions"
fi
printf '\nRestore command:\n  scripts/selfhost/restore.sh %s\n' "$backup_dir_abs"
