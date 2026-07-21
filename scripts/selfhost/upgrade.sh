#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/selfhost/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

TARGET_IMAGE=""
I_HAVE_BACKUP=0
SKIP_SMOKE=0
LOCAL_IMAGE=0
IMAGE_ENV_UPDATED=0
PREVIOUS_IMAGE_ENV_ENTRY=""
STACK_RECREATE_ATTEMPTED=0
PRE_UPGRADE_BACKUP_DIR=""

usage() {
  cat <<'USAGE'
Usage: scripts/selfhost/upgrade.sh [options] [target-image]

Options:
  --image <image>       Target server image. Positional target-image also works.
  --local-image         Treat --image as a locally-built tag: skip the registry
                        pull and use the local image (it must already exist).
  --i-have-a-backup     Do not create a fresh backup before upgrading.
  --skip-smoke          Skip publish/artifact smoke after upgrade.
  -h, --help            Show this help.

Without a target image, the script rebuilds the current local server image from
the checked-out source tree. The caddy (web dashboard) image is always rebuilt
from source so upgrades never ship a stale dashboard. Set
CODEMAGIC_PATCH_TOKEN=cm_pat_... to run the full publish/artifact smoke after the
upgrade; without it only unauthenticated checks run (or pass --skip-smoke to
skip it entirely). Obtain the token by signing in as an admin
(`cmpatch login`) and running `cmpatch token create`.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --image) TARGET_IMAGE="${2:-}"; shift 2 ;;
    --local-image) LOCAL_IMAGE=1; shift ;;
    --i-have-a-backup) I_HAVE_BACKUP=1; shift ;;
    --skip-smoke) SKIP_SMOKE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)
      [ -z "$TARGET_IMAGE" ] || fail_selfhost "only one target image may be provided"
      TARGET_IMAGE="$1"
      shift
      ;;
  esac
done

require_command_selfhost docker
docker compose version >/dev/null || fail_selfhost "Docker Compose v2 is required"
load_selfhost_env
# Fail (or backfill) before the backup/build instead of letting the upgraded
# server refuse to boot over missing OAuth env.
ensure_selfhost_oauth_env

SMOKE_UNAUTHENTICATED=0
if [ "$SKIP_SMOKE" -eq 0 ] && [ -z "${CODEMAGIC_PATCH_TOKEN:-}" ]; then
  SMOKE_UNAUTHENTICATED=1
  warn_selfhost "CODEMAGIC_PATCH_TOKEN is not set; the post-upgrade smoke will run unauthenticated checks only and skip the publish/artifact smoke"
  warn_selfhost "for the full smoke, sign in with 'cmpatch login', run 'cmpatch token create', and set CODEMAGIC_PATCH_TOKEN=cm_pat_..."
fi

# ensure_selfhost_oauth_env above already validated the OAuth env (at least
# one provider, and each configured provider's id/secret pair). Older GitHub
# installs may still predate the redirect allowlist; backfill it here.
if [ -n "${GITHUB_OAUTH_CLIENT_ID:-}" ] && [ -z "${GITHUB_OAUTH_ALLOWED_REDIRECT_URIS:-}" ]; then
  set_selfhost_env_value GITHUB_OAUTH_ALLOWED_REDIRECT_URIS "https://${CODEMAGIC_PATCH_API_DOMAIN}/auth/callback"
  warn_selfhost "GITHUB_OAUTH_ALLOWED_REDIRECT_URIS was missing; defaulted to https://${CODEMAGIC_PATCH_API_DOMAIN}/auth/callback in ${SELFHOST_ENV_FILE}"
fi

if [ -z "${CODEMAGIC_PATCH_CADDY_IMAGE:-}" ]; then
  log_selfhost "CODEMAGIC_PATCH_CADDY_IMAGE was missing; defaulting to codemagic-patch-caddy:selfhost"
  set_selfhost_env_value CODEMAGIC_PATCH_CADDY_IMAGE "codemagic-patch-caddy:selfhost"
fi

previous_image="${CODEMAGIC_PATCH_SERVER_IMAGE:-codemagic-patch-server:selfhost}"
PREVIOUS_IMAGE_ENV_ENTRY="$(grep -E '^CODEMAGIC_PATCH_SERVER_IMAGE=' "$SELFHOST_ENV_FILE" 2>/dev/null || true)"
printf 'Current server image:\n  %s\n\n' "$previous_image"

# US31: on any failure after the stack is touched, restore the env image pin
# (image upgrades) and, once the stack has been recreated, point the operator at
# a real rollback. The new image may already have migrated the database, so
# re-pinning the image alone is NOT a safe rollback — a full restore is.
upgrade_failed() {
  local exit_code=$?
  if [ "$exit_code" -eq 0 ]; then
    return 0
  fi

  if [ "$IMAGE_ENV_UPDATED" -eq 1 ]; then
    warn_selfhost "upgrade failed; restoring CODEMAGIC_PATCH_SERVER_IMAGE to ${previous_image} in ${SELFHOST_ENV_FILE}"
    if [ -n "$PREVIOUS_IMAGE_ENV_ENTRY" ]; then
      set_selfhost_env_value CODEMAGIC_PATCH_SERVER_IMAGE "${PREVIOUS_IMAGE_ENV_ENTRY#CODEMAGIC_PATCH_SERVER_IMAGE=}" || true
    else
      remove_selfhost_env_value CODEMAGIC_PATCH_SERVER_IMAGE || true
    fi
  fi

  if [ "$STACK_RECREATE_ATTEMPTED" -eq 1 ]; then
    warn_selfhost "upgrade did not complete; the stack may be left running the new image, which may already have migrated the database (re-pinning the image alone is not a safe rollback)."
    if [ -n "$PRE_UPGRADE_BACKUP_DIR" ]; then
      warn_selfhost "roll back to the pre-upgrade state with: scripts/selfhost/restore.sh --restore-env ${PRE_UPGRADE_BACKUP_DIR}"
    else
      warn_selfhost "no pre-upgrade backup was taken (--i-have-a-backup); roll back from your external backup with: scripts/selfhost/restore.sh --restore-env <backup-dir>"
    fi
  fi

  exit "$exit_code"
}

if [ "$I_HAVE_BACKUP" -eq 0 ]; then
  pre_upgrade_root="${SELFHOST_BACKUP_ROOT:-${SELFHOST_REPO_ROOT}/backups}/pre-upgrade"
  log_selfhost "creating a pre-upgrade backup under ${pre_upgrade_root}"
  "$SELFHOST_REPO_ROOT/scripts/selfhost/backup.sh" "$pre_upgrade_root"
  # Backup dirs are timestamped (no special chars), so ls -t is safe here.
  # shellcheck disable=SC2012
  PRE_UPGRADE_BACKUP_DIR="$(ls -dt "${pre_upgrade_root}"/codemagic-patch-selfhost-* 2>/dev/null | head -n1 || true)"
else
  warn_selfhost "operator confirmed an external backup; no fresh backup was created"
fi

# Cover both the image-pin and rebuild paths from here on (env-pin restore +
# rollback guidance once the stack is recreated).
trap upgrade_failed EXIT

if [ -n "$TARGET_IMAGE" ]; then
  log_selfhost "updating CODEMAGIC_PATCH_SERVER_IMAGE to ${TARGET_IMAGE}"
  set_selfhost_env_value CODEMAGIC_PATCH_SERVER_IMAGE "$TARGET_IMAGE"
  IMAGE_ENV_UPDATED=1
  load_selfhost_env
  # DR10: a locally-built tag isn't in any registry, so --local-image skips the
  # pull and uses the local image. Without it, --image is a registry image: a
  # pull failure stays a hard failure (don't silently run a stale local copy of
  # a mutable tag).
  if [ "$LOCAL_IMAGE" -eq 1 ]; then
    if ! docker image inspect "$TARGET_IMAGE" >/dev/null 2>&1; then
      fail_selfhost "--local-image was given but ${TARGET_IMAGE} is not present locally; build it first"
    fi
    log_selfhost "using locally available image ${TARGET_IMAGE} (--local-image; skipping pull)"
  else
    log_selfhost "pulling target server image ${TARGET_IMAGE}"
    compose_selfhost pull server
  fi
  log_selfhost "rebuilding caddy (web dashboard) image from source"
  compose_selfhost build --pull caddy
else
  TARGET_IMAGE="$previous_image"
  log_selfhost "rebuilding current server and caddy (web dashboard) images from source"
  compose_selfhost build --pull server caddy
fi

log_selfhost "recreating stack"
# Mark before the call: `compose up` can fail after recreating some containers,
# leaving the stack partially upgraded — the rollback guidance must still fire.
STACK_RECREATE_ATTEMPTED=1
compose_selfhost up -d --remove-orphans
wait_for_selfhost_service postgres
wait_for_selfhost_service minio
wait_for_selfhost_service server
wait_for_selfhost_http "${SERVER_URL%/}/health" "API health" 120

if [ "$SKIP_SMOKE" -eq 0 ]; then
  "$SELFHOST_REPO_ROOT/scripts/selfhost/smoke.sh"
fi

IMAGE_ENV_UPDATED=0
trap - EXIT

printf '\nUpgrade complete.\n'
printf 'Previous server image:\n  %s\n' "$previous_image"
printf 'Current server image:\n  %s\n' "$TARGET_IMAGE"
if [ "$SMOKE_UNAUTHENTICATED" -eq 1 ]; then
  printf '\nNote: publish/artifact smoke was skipped (no CODEMAGIC_PATCH_TOKEN).\n'
  printf 'Run CODEMAGIC_PATCH_TOKEN=cm_pat_... scripts/selfhost/smoke.sh for full validation.\n'
fi
printf '\nCurrent compose images:\n'
compose_selfhost images server
