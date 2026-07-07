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
  postgres.dump
  minio-codemagic-patch.tar.gz
  versions.txt
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
    log_selfhost "no server container present; backing up the current PostgreSQL and MinIO state"
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

# US29: a backup needs a live PostgreSQL and MinIO (pg_dump / mc mirror). If the
# stack is down, fail fast with a clear message instead of creating a backup
# directory and then hanging on wait_for_selfhost_service's full timeout.
require_selfhost_service_running postgres
require_selfhost_service_running minio

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

{
  printf 'created_at=%s\n' "$timestamp"
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

quiesce_server_for_backup
wait_for_selfhost_service postgres
wait_for_selfhost_service minio

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

BACKUP_COMPLETE=1
printf '\nBackup complete.\n'
printf 'Backup directory:\n  %s\n\n' "$backup_dir_abs"
printf 'Restore command:\n  scripts/selfhost/restore.sh %s\n' "$backup_dir_abs"
