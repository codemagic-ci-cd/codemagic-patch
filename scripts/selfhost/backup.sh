#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/selfhost/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

BACKUP_ROOT="${SELFHOST_BACKUP_ROOT:-${SELFHOST_REPO_ROOT}/backups}"
BACKUP_ROOT_GIVEN=0
BACKUP_DIRECTORY=""
SERVER_WAS_RUNNING=0
BACKUP_COMPLETE=0
CLEANUP_DONE=0
backup_dir_abs=""

usage() {
  cat <<'USAGE'
Usage: scripts/selfhost/backup.sh [options] [backup-root]

Options:
  --directory <path>   Write the backup into exactly this directory instead of
                       creating codemagic-patch-selfhost-<utc> under a root.
                       The directory must not already exist, or must be empty:
                       an incomplete backup is removed on failure, and that
                       must never take an operator's data with it. Mutually
                       exclusive with the backup-root positional.
  -h, --help           Show this help.

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

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h | --help) usage; exit 0 ;;
    --directory)
      # Both a missing and an empty value are refused here: `shift 2` past the
      # end would die under `set -e` with no message at all, and an empty path
      # would silently fall through to the default timestamped root — a backup
      # landing somewhere the caller never named.
      [ "$#" -ge 2 ] && [ -n "${2:-}" ] || fail_selfhost "--directory requires a path"
      BACKUP_DIRECTORY="$2"
      shift 2
      ;;
    -*) fail_selfhost "unknown option: $1" ;;
    *)
      [ "$BACKUP_ROOT_GIVEN" -eq 0 ] || fail_selfhost "only one backup root may be provided"
      BACKUP_ROOT="$1"
      BACKUP_ROOT_GIVEN=1
      shift
      ;;
  esac
done

if [ -n "$BACKUP_DIRECTORY" ] && [ "$BACKUP_ROOT_GIVEN" -eq 1 ]; then
  fail_selfhost "--directory and a backup-root positional are mutually exclusive: --directory already names the exact output directory"
fi

backup_cleanup() {
  local exit_code=$?
  local signal_number="${1:-}"

  if [ -n "$signal_number" ]; then
    exit_code=$((128 + signal_number))
  fi
  if [ "$CLEANUP_DONE" -eq 1 ]; then
    exit "$exit_code"
  fi
  CLEANUP_DONE=1

  # A partial dump/archive must never be left behind looking like a finished
  # backup. If we never reached completion, drop the incomplete directory. A
  # cleanup failure must not prevent the stopped server from being restarted.
  if [ "$BACKUP_COMPLETE" -ne 1 ] && [ -n "$backup_dir_abs" ] && [ -d "$backup_dir_abs" ]; then
    warn_selfhost "backup did not complete; removing incomplete ${backup_dir_abs}"
    if ! rm -rf "$backup_dir_abs" 2>/dev/null; then
      warn_selfhost "could not remove ${backup_dir_abs}; remove it by hand"
    fi
  fi

  if [ "$SERVER_WAS_RUNNING" -eq 1 ]; then
    log_selfhost "restarting server after backup"
    if ! compose_selfhost up -d server; then
      exit_code=1
    else
      # `up -d` only proves the container was created: a server that
      # crash-loops right after (an env file drifted into a non-bootable
      # state) would otherwise be reported as a completed backup over a downed
      # deployment. Gate the restart on the same health check restore.sh uses,
      # so a failed restart surfaces as a failed backup with the state named.
      wait_for_selfhost_service server
      if [ -n "${SERVER_URL:-}" ]; then
        wait_for_selfhost_http "${SERVER_URL%/}/health" "API health" 120
      fi
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
# compose_selfhost validates the remaining stack-shape flags too, but the first
# call here is `compose_selfhost ps` inside a `$( ... 2>/dev/null )`, which
# turns fail_selfhost's message into a bare exit 1. Run it once up front so the
# operator sees why the backup stopped.
validate_selfhost_stack_shape

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
if [ -n "$BACKUP_DIRECTORY" ]; then
  # The caller (the CLI) already owns a per-invocation directory name and
  # needs the backup to land at exactly that path, identified rather than
  # guessed by newest-directory. Creating our own timestamped child under it
  # would double-nest and make the reported path wrong.
  backup_dir="$BACKUP_DIRECTORY"
  if [ -e "$backup_dir" ]; then
    [ -d "$backup_dir" ] || fail_selfhost "--directory ${backup_dir} exists and is not a directory"
    # backup_cleanup removes the directory when the backup does not complete,
    # so refusing a non-empty one is what keeps that trap from deleting
    # something this run did not create.
    if [ -n "$(ls -A "$backup_dir" 2>/dev/null)" ]; then
      fail_selfhost "--directory ${backup_dir} is not empty; point it at a new or empty directory (an incomplete backup is removed on failure, which must never delete existing files)"
    fi
  fi
else
  backup_dir="${BACKUP_ROOT%/}/codemagic-patch-selfhost-${timestamp}"
fi
mkdir -p "$backup_dir"
backup_dir_abs="$(cd "$backup_dir" && pwd)"
chmod 700 "$backup_dir_abs"
trap 'backup_cleanup' EXIT
trap 'backup_cleanup 2' INT
trap 'backup_cleanup 15' TERM

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
  # The mc container runs as root, so on a Linux host with rootful Docker every
  # object directory the mirror creates under the bind mount is root-owned —
  # and the `rm -rf` below then fails for a non-root operator (the wizard's
  # default install: a docker-group user such as ubuntu/ec2-user), which under
  # `set -e` trips the cleanup trap and deletes the finished backup. Hand the
  # mirror output back to the invoking user inside the same container, where
  # root can chown; a no-op when the operator is root. (macOS Docker Desktop
  # maps bind-mount ownership to the host user, so it never shows this.)
  # `--user` on the mc container is not an option: mc needs a writable config
  # directory that the image only provides for root.
  compose_selfhost run --rm --no-deps \
    -v "${backup_dir_abs}/minio-codemagic-patch:/backup/minio-codemagic-patch" \
    -e "CMPATCH_BACKUP_UID=$(id -u)" \
    -e "CMPATCH_BACKUP_GID=$(id -g)" \
    --entrypoint /bin/sh \
    minio-init -c '
      set -eu
      mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
      mc mirror --overwrite --remove local/codemagic-patch /backup/minio-codemagic-patch
      chown -R "$CMPATCH_BACKUP_UID:$CMPATCH_BACKUP_GID" /backup/minio-codemagic-patch
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
    "$created_at" "$backup_omissions"
fi
printf '\nRestore command:\n  scripts/selfhost/restore.sh %s\n' "$backup_dir_abs"
