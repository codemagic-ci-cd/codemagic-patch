#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/selfhost/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

TARGET_IMAGE=""
I_HAVE_BACKUP=0
SKIP_SMOKE=0
LOCAL_IMAGE=0
BUILD_FROM_SOURCE=0
PREVIOUS_REF=""
# 1 when --previous-ref was given: only a ref the caller named is checked out
# again on a refusal; one guessed from the reflog is only reported.
PREVIOUS_REF_EXPLICIT=0
SKIP_SCHEMA_CHECK=0
# How the server image is chosen: build (--build-from-source, or a branch
# checkout), image (--image), or release (the published image of the server
# tag HEAD is at). Settled by select_upgrade_server_image.
SERVER_IMAGE_MODE=""
IMAGE_ENV_UPDATED=0
CADDY_IMAGE_ENV_UPDATED=0
PREVIOUS_IMAGE_ENV_ENTRY=""
PREVIOUS_CADDY_IMAGE_ENV_ENTRY=""
STACK_RECREATE_ATTEMPTED=0
PRE_UPGRADE_BACKUP_DIR=""
# A source build re-tags codemagic-patch-server:selfhost, the image a
# source-built stack runs now. That image is kept under this name first, so a
# rollback still has it (see keep_local_server_image).
KEPT_LOCAL_IMAGE=""
CLEANUP_DONE=0

usage() {
  cat <<'USAGE'
Usage: scripts/selfhost/upgrade.sh [options] [target-image]

Run it on the checkout of the release to upgrade to: move the checkout first
(`git fetch --tags && git checkout codemagic-patch-server-v<version>`), then
run this script from it. `cmpatch selfhost upgrade` does both.

Options:
  --previous-ref <ref>  The checkout's ref before it was moved to this
                        release: a branch name or a commit. A failure before
                        the stack is recreated checks it out again. Defaults
                        to HEAD when the checkout has not moved since the
                        stack last started (SELFHOST_SOURCE_REVISION in the
                        env file), else to the previous checkout in the
                        reflog (@{-1} when that was a branch, else HEAD@{1}).
  --image <image>       Target server image. Positional target-image also works.
  --local-image         Treat --image as a locally-built tag: skip the registry
                        pull and use the local image (it must already exist).
  --build-from-source   Build the server image on this host from the checkout
                        instead of pulling one.
  --i-have-a-backup     Do not create a fresh backup before upgrading.
  --skip-smoke          Skip publish/artifact smoke after upgrade.
  --skip-schema-check   Do not run the target server image's own schema check
                        first (it refuses a database with migrations the image
                        does not know). Unsafe: nothing then stops an older
                        server from starting on a newer schema. Only for a
                        database the check cannot read, or a target image
                        from before the check.
  -h, --help            Show this help.

Without --image or --build-from-source the script runs the image published
with the server release HEAD is at (the release's server-image.json asset,
cross-checked against the tag). A checkout that is not at a release tag (an
install from before published images, on `main`) refuses without one of the
two flags and names the move to a release tag instead. The dashboard ships inside the
server image; caddy runs the stock image named by CODEMAGIC_PATCH_CADDY_IMAGE,
pulled, never built (an env file without the key, or with the old locally
built codemagic-patch-caddy:selfhost, is switched to the pinned stock image).
Set CODEMAGIC_PATCH_TOKEN=cm_pat_... to run the full publish/artifact smoke
after the upgrade; without it only unauthenticated checks run (or pass
--skip-smoke to skip it entirely). Obtain the token by signing in as an admin
(`cmpatch login`) and running `cmpatch token create`.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --image)
      [ -n "${2:-}" ] || fail_selfhost "--image needs an image reference"
      TARGET_IMAGE="$2"; shift 2 ;;
    --local-image) LOCAL_IMAGE=1; shift ;;
    --build-from-source) BUILD_FROM_SOURCE=1; shift ;;
    --previous-ref)
      [ -n "${2:-}" ] || fail_selfhost "--previous-ref needs a branch name or a commit"
      PREVIOUS_REF="$2"; PREVIOUS_REF_EXPLICIT=1; shift 2 ;;
    --i-have-a-backup) I_HAVE_BACKUP=1; shift ;;
    --skip-smoke) SKIP_SMOKE=1; shift ;;
    --skip-schema-check) SKIP_SCHEMA_CHECK=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) fail_selfhost "unknown option: $1" ;;
    *)
      [ -z "$TARGET_IMAGE" ] || fail_selfhost "only one target image may be provided"
      TARGET_IMAGE="$1"
      shift
      ;;
  esac
done

if [ "$BUILD_FROM_SOURCE" -eq 1 ] && [ -n "$TARGET_IMAGE" ]; then
  fail_selfhost "--image and --build-from-source cannot be combined: one runs an image built elsewhere, the other builds it here. Pick one."
fi
if [ "$LOCAL_IMAGE" -eq 1 ] && [ -z "$TARGET_IMAGE" ]; then
  fail_selfhost "--local-image names how to use --image; pass --image <local tag> with it"
fi

selfhost_git() {
  git -C "$SELFHOST_REPO_ROOT" "$@"
}

# The ref the checkout was on before it was moved to this release. A branch
# is named (so a rollback lands back on it, not on a detached copy); anything
# else is the exact commit.
default_previous_ref() {
  local symbolic recorded head
  # A checkout that did not move since the stack last started has nothing to
  # go back to, and the reflog's older entries (on a clone, its `main`) must
  # not be taken for "before this upgrade". The env file records the commit
  # the stack last started from.
  head="$(selfhost_git rev-parse HEAD)"
  recorded="$(selfhost_env_value_from_file SELFHOST_SOURCE_REVISION)"
  if [ -n "$recorded" ] &&
    [ "$(selfhost_git rev-parse --verify --quiet "${recorded}^{commit}" 2>/dev/null || true)" = "$head" ]; then
    printf '%s\n' "$head"
    return 0
  fi
  if symbolic="$(selfhost_git rev-parse --symbolic-full-name '@{-1}' 2>/dev/null)"; then
    case "$symbolic" in
      refs/heads/*)
        printf '%s\n' "${symbolic#refs/heads/}"
        return 0
        ;;
    esac
  fi
  selfhost_git rev-parse --verify --quiet 'HEAD@{1}^{commit}' 2>/dev/null ||
    selfhost_git rev-parse HEAD
}

# Whether checking out PREVIOUS_REF would change anything. A branch is
# elsewhere unless HEAD is on it (a fast-forwarded branch checkout has no
# other state to go back to; a tag checkout at the branch's commit still has
# to get back onto the branch). Anything else is a commit, elsewhere when it
# is not HEAD's.
previous_ref_is_elsewhere() {
  [ -n "$PREVIOUS_REF" ] || return 1
  if selfhost_git show-ref --verify --quiet "refs/heads/${PREVIOUS_REF}"; then
    [ "$PREVIOUS_REF" != "$(selfhost_git symbolic-ref --quiet --short HEAD 2>/dev/null || true)" ]
    return
  fi
  [ "$(selfhost_git rev-parse --verify --quiet "${PREVIOUS_REF}^{commit}" 2>/dev/null || true)" != "$(selfhost_git rev-parse HEAD)" ]
}

restore_previous_ref() {
  previous_ref_is_elsewhere || return 0
  if selfhost_git checkout --quiet "$PREVIOUS_REF" 2>/dev/null; then
    warn_selfhost "checked the previous ref ${PREVIOUS_REF} out again in ${SELFHOST_REPO_ROOT}"
  else
    warn_selfhost "could not check out ${PREVIOUS_REF} again; run: git -C ${SELFHOST_REPO_ROOT} checkout ${PREVIOUS_REF}"
  fi
}

# The ways forward for a checkout that is not at a release tag and named no
# image. On a `main` checkout (every install from before published images,
# whichever image it runs) the first one is the migration onto the published
# image, with `main` as the rollback ref.
refuse_untagged_upgrade() {
  local where
  where="$(selfhost_git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  if [ -n "$where" ]; then
    where="on branch ${where}"
  else
    where="at $(selfhost_git rev-parse --short HEAD)"
  fi
  fail_selfhost "the checkout in ${SELFHOST_REPO_ROOT} is ${where}, not at a ${SELFHOST_SERVER_TAG_PREFIX}* release tag, so there is no published server image that matches it. Nothing was changed. Either:
  1. Move to the latest server release and upgrade from it:
       git fetch --tags
       git checkout ${SELFHOST_SERVER_TAG_PREFIX}<version>
       scripts/selfhost/upgrade.sh
     This checkout stays the rollback ref. If it is newer than that release, upgrade.sh refuses: wait for the next release, or use 2.
  2. Rerun with --build-from-source to rebuild the server image on this host from this checkout.
  3. Rerun with --image <ref> to run a server image you choose.
cmpatch selfhost upgrade does 1 for you."
}

# Settles SERVER_IMAGE_MODE. A flag always wins. Without one, a release tag
# at HEAD runs that release's published image; any other checkout (notably a
# legacy install on `main`) refuses rather than guess between a rebuild and a
# migration.
select_upgrade_server_image() {
  if [ "$BUILD_FROM_SOURCE" -eq 1 ]; then
    SERVER_IMAGE_MODE=build
  elif [ -n "$TARGET_IMAGE" ]; then
    SERVER_IMAGE_MODE=image
  elif [ -n "$(selfhost_server_tag_at_head)" ]; then
    SERVER_IMAGE_MODE=release
  else
    refuse_untagged_upgrade
  fi
}

select_upgrade_server_image

# Previous ref and direction, before anything else changes. After the
# untagged refusal above: that checkout was not moved for this run, so an old
# reflog entry must not be checked out on its behalf. The checkout has
# already been moved (the CLI or the operator did it, so that this script is
# the target release's); a checkout that does not descend from the previous
# ref is not a way forward from it, so it is undone (when the ref was named)
# and refused here.
if selfhost_git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [ -z "$PREVIOUS_REF" ]; then
    PREVIOUS_REF="$(default_previous_ref)"
  fi
  selfhost_git rev-parse --verify --quiet "${PREVIOUS_REF}^{commit}" >/dev/null ||
    fail_selfhost "--previous-ref ${PREVIOUS_REF} is not a commit or branch in ${SELFHOST_REPO_ROOT}"
  log_selfhost "previous ref: ${PREVIOUS_REF}"
  if ! selfhost_git merge-base --is-ancestor "${PREVIOUS_REF}^{commit}" HEAD; then
    upgrade_head="$(selfhost_git rev-parse --short HEAD)"
    if [ "$PREVIOUS_REF_EXPLICIT" -eq 1 ]; then
      restore_previous_ref
      fail_selfhost "the checkout (${upgrade_head}) is not a descendant of the previous ref ${PREVIOUS_REF}, so this would move the server backwards. Nothing was changed. Wait for the next release, or use --build-from-source on the checkout you want."
    fi
    # Guessed from the reflog: it may be a checkout this stack never ran
    # (a clone's `main`), so the checkout stays where the operator put it.
    fail_selfhost "the checkout (${upgrade_head}) is not a descendant of ${PREVIOUS_REF}, the previous checkout in the reflog: either this would move the server backwards, or the stack never ran ${PREVIOUS_REF}. Nothing was changed, and the checkout was left where it is. If the stack ran ${PREVIOUS_REF}, go back to it with: git -C ${SELFHOST_REPO_ROOT} checkout ${PREVIOUS_REF}. Otherwise rerun with --previous-ref <the ref the stack runs now> (HEAD when this checkout has not moved since the stack started)."
  fi
else
  warn_selfhost "${SELFHOST_REPO_ROOT} is not a git checkout; there is no previous ref to roll the source back to"
  PREVIOUS_REF=""
fi

# Until the rollback trap below is armed nothing on this host has changed, so
# a failure only puts back a checkout the caller named with --previous-ref;
# one guessed from the reflog is named, not checked out, like the direction
# refusal above.
refused_before_changes() {
  local exit_code=$?
  [ "$exit_code" -ne 0 ] || return 0
  if [ "$PREVIOUS_REF_EXPLICIT" -eq 1 ]; then
    restore_previous_ref
  elif previous_ref_is_elsewhere; then
    warn_selfhost "The checkout was left where it is; the previous checkout in the reflog is ${PREVIOUS_REF} (git -C ${SELFHOST_REPO_ROOT} checkout ${PREVIOUS_REF})."
  fi
}
trap 'refused_before_changes' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

require_command_selfhost docker
docker compose version >/dev/null || fail_selfhost "Docker Compose v2 is required"

# The image to run. The release's is resolved here, before the backup: a
# release with no published image, or GitHub out of reach, stops with nothing
# changed.
case "$SERVER_IMAGE_MODE" in
  release)
    resolve_server_image_for_head
    TARGET_IMAGE="$SELFHOST_RESOLVED_SERVER_IMAGE"
    ;;
  build)
    TARGET_IMAGE="$SELFHOST_LOCAL_SERVER_IMAGE"
    ;;
esac

# The database decides whether the target image may run on it: an applied
# migration the image does not know means the database is newer than the
# server this would start. The check is the target image's own (see
# selfhost_schema_compat in common.sh), so it reads the database exactly as
# that server will. $1 is what a refusal leaves behind.
check_target_schema() {
  local status=0
  log_selfhost "checking the database's applied migrations with the schema check of ${TARGET_IMAGE}"
  selfhost_schema_compat "$TARGET_IMAGE" || status=$?
  [ "$status" -eq 0 ] || fail_selfhost "$(selfhost_schema_message "$status" "$TARGET_IMAGE" "$1")"
  log_selfhost "the database's ${SELFHOST_SCHEMA_APPLIED_COUNT:-applied} migrations are all known to ${TARGET_IMAGE}"
}

# The release and --image targets exist before anything changes, so they are
# fetched here, once: a plain `docker pull`, which leaves the stack alone
# (with --local-image only looked for). An image that cannot be had stops the
# upgrade with nothing changed, and the schema check below runs on it. A
# --build-from-source image exists only after the build, so its check runs
# between the build and the recreate (below), and a refusal goes through the
# pre-recreate rollback.
# The env file is loaded before the check: compose gives an exported shell
# variable precedence over --env-file, so an ambient DATABASE_URL or
# POSTGRES_* would otherwise point the check at a different database from the
# one this upgrade runs on.
if [ "$SERVER_IMAGE_MODE" != build ]; then
  selfhost_fetch_server_image "$TARGET_IMAGE" "$LOCAL_IMAGE" ||
    fail_selfhost "${SELFHOST_SCHEMA_ERROR}. Nothing was changed."
fi
if [ "$SKIP_SCHEMA_CHECK" -eq 1 ]; then
  warn_selfhost "skipping the database schema check (--skip-schema-check): nothing stops this upgrade from starting an older server on a newer schema"
elif [ "$SERVER_IMAGE_MODE" = build ]; then
  log_selfhost "the database schema check runs after the build, before the stack is recreated"
else
  load_selfhost_env
  check_target_schema "Nothing was changed."
fi

# Before the backup, before anything changes, from here on every failure that
# happens before the stack is recreated puts the checkout back on the
# previous ref (see upgrade_failed).
#
# US31: on any failure after the stack is touched, restore the env image pins
# and, once the stack has been recreated, point the operator at a real
# rollback. The new image may already have migrated the database, so
# re-pinning the image alone is NOT a safe rollback — a full restore is.
upgrade_failed() {
  local exit_code=$?
  local signal_number="${1:-}"
  # The output may be gone (a dropped ssh session closes the pipe the script
  # writes to): a write must fail on its own, not kill the shell half-way
  # through the rollback, and no failing step may cut the rest short.
  trap '' PIPE
  set +e
  # Probed from subshells, which cannot harm this shell: a failed write here
  # can leave its text in the shell's output buffer (bash 3.2 does), and the
  # next command substitution (the env rewrite's mktemp) would read it back
  # as its result. Once the output is gone, send everything to /dev/null and
  # flush that buffer there.
  if ! ( printf '\n' 2>/dev/null ) || ! ( printf '\n' >&2 2>/dev/null ); then
    exec >/dev/null 2>&1
    printf '\n'
  fi

  if [ -n "$signal_number" ]; then
    exit_code=$((128 + signal_number))
  fi
  if [ "$CLEANUP_DONE" -eq 1 ]; then
    exit "$exit_code"
  fi
  CLEANUP_DONE=1

  if [ "$exit_code" -eq 0 ]; then
    return 0
  fi

  if [ "$STACK_RECREATE_ATTEMPTED" -eq 1 ]; then
    upgrade_recovery_guidance
    exit "$exit_code"
  fi

  if [ "$IMAGE_ENV_UPDATED" -eq 1 ]; then
    warn_selfhost "upgrade failed; restoring CODEMAGIC_PATCH_SERVER_IMAGE to ${previous_image:-its previous value} in ${SELFHOST_ENV_FILE}"
    if [ -n "$PREVIOUS_IMAGE_ENV_ENTRY" ]; then
      set_selfhost_env_value CODEMAGIC_PATCH_SERVER_IMAGE "${PREVIOUS_IMAGE_ENV_ENTRY#CODEMAGIC_PATCH_SERVER_IMAGE=}" || true
    else
      remove_selfhost_env_value CODEMAGIC_PATCH_SERVER_IMAGE || true
    fi
  fi
  if [ "$CADDY_IMAGE_ENV_UPDATED" -eq 1 ]; then
    if [ -n "$PREVIOUS_CADDY_IMAGE_ENV_ENTRY" ]; then
      warn_selfhost "upgrade failed; restoring CODEMAGIC_PATCH_CADDY_IMAGE to ${caddy_image_before:-its previous value} in ${SELFHOST_ENV_FILE}"
    else
      warn_selfhost "upgrade failed; removing CODEMAGIC_PATCH_CADDY_IMAGE from ${SELFHOST_ENV_FILE} again (it had none)"
    fi
    if [ -n "$PREVIOUS_CADDY_IMAGE_ENV_ENTRY" ]; then
      set_selfhost_env_value CODEMAGIC_PATCH_CADDY_IMAGE "${PREVIOUS_CADDY_IMAGE_ENV_ENTRY#CODEMAGIC_PATCH_CADDY_IMAGE=}" || true
    else
      remove_selfhost_env_value CODEMAGIC_PATCH_CADDY_IMAGE || true
    fi
  fi
  if [ -n "$KEPT_LOCAL_IMAGE" ]; then
    if docker tag "$KEPT_LOCAL_IMAGE" "$SELFHOST_LOCAL_SERVER_IMAGE" >/dev/null 2>&1; then
      warn_selfhost "upgrade failed; tagged the image this host ran before (${KEPT_LOCAL_IMAGE}) as ${SELFHOST_LOCAL_SERVER_IMAGE} again"
      docker image rm "$KEPT_LOCAL_IMAGE" >/dev/null 2>&1 || true
    else
      warn_selfhost "upgrade failed and the image this host ran before could not be tagged back; run: docker tag ${KEPT_LOCAL_IMAGE} ${SELFHOST_LOCAL_SERVER_IMAGE}"
    fi
  fi
  # Last: git replaces the files rather than rewriting them in place, so this
  # running script keeps reading its own open copy.
  restore_previous_ref

  exit "$exit_code"
}

# Before a source build replaces codemagic-patch-server:selfhost: when the
# stack runs that local image now, tag it pre-upgrade-<UTC time> so the
# rollback has it. No registry has a copy of a host-built image.
keep_local_server_image() {
  [ "$previous_image" = "$SELFHOST_LOCAL_SERVER_IMAGE" ] || return 0
  docker image inspect "$SELFHOST_LOCAL_SERVER_IMAGE" >/dev/null 2>&1 || return 0
  local kept
  kept="${SELFHOST_LOCAL_SERVER_IMAGE%%:*}:pre-upgrade-$(date -u +%Y%m%dT%H%M%SZ)"
  docker tag "$SELFHOST_LOCAL_SERVER_IMAGE" "$kept"
  KEPT_LOCAL_IMAGE="$kept"
  log_selfhost "kept the server image this host runs now as ${KEPT_LOCAL_IMAGE}"
}

# Recovery after the stack was (perhaps partly) recreated. The order matters:
# - The new server stops first and stays stopped: it migrates whatever
#   database it meets at startup, so a running one would upgrade the restored
#   (or provider-rolled-back) database again. restore.sh keeps a stopped
#   server stopped until the data is back (its safety backup restarts only a
#   server that was running, and it starts the full stack last).
# - restore.sh starts the stack on whatever checkout is present, so the
#   compose and Caddy files have to be the previous ones first.
# Every path is absolute: the operator may run the steps from anywhere.
upgrade_recovery_guidance() {
  local db_mode backup_dir="${PRE_UPGRADE_BACKUP_DIR:-<backup-dir>}" step=1
  warn_selfhost "upgrade did not complete; the stack may be left running the new image, which may already have migrated the database (re-pinning the image alone is not a safe rollback)."
  if [ -z "$PRE_UPGRADE_BACKUP_DIR" ]; then
    warn_selfhost "no pre-upgrade backup was taken (--i-have-a-backup); use your external backup below"
  fi
  warn_selfhost "to roll back, in this order:"
  warn_selfhost "  ${step}. $(selfhost_compose_command) stop server   (so the new server cannot migrate the database again while you roll back)"
  step=$((step + 1))
  if [ -n "$KEPT_LOCAL_IMAGE" ]; then
    warn_selfhost "  ${step}. docker tag ${KEPT_LOCAL_IMAGE} ${SELFHOST_LOCAL_SERVER_IMAGE}   (the image this host ran before; the build replaced ${SELFHOST_LOCAL_SERVER_IMAGE})"
    step=$((step + 1))
  fi
  if previous_ref_is_elsewhere; then
    warn_selfhost "  ${step}. git -C ${SELFHOST_REPO_ROOT} checkout ${PREVIOUS_REF}   (the compose and Caddy files the backup was taken with)"
    step=$((step + 1))
  fi
  # Read the mode from the env file (same authority compose_selfhost used to
  # assemble the stack): with an external database restore.sh cannot undo a
  # migration, so the operator's own database rollback is the only fix.
  db_mode="$(selfhost_mode_from_env_file SELFHOST_DATABASE_MODE)"
  if [ "${db_mode:-bundled}" = "external" ]; then
    warn_selfhost "  ${step}. with the server still stopped, roll the external database (SELFHOST_DATABASE_MODE=external) back to just before the upgrade with your provider's mechanism (e.g. RDS point-in-time recovery); restore.sh does NOT restore it"
    step=$((step + 1))
    warn_selfhost "  ${step}. ${SELFHOST_REPO_ROOT}/scripts/selfhost/restore.sh --restore-env ${backup_dir}   (the remaining bundled components; starts the stack)"
  else
    warn_selfhost "  ${step}. ${SELFHOST_REPO_ROOT}/scripts/selfhost/restore.sh --restore-env ${backup_dir}   (starts the stack)"
  fi
  warn_selfhost "do not prune the previous server image ${KEPT_LOCAL_IMAGE:-${previous_image:-}} (docker image prune) until the upgrade is confirmed: the rollback runs it from this host's image cache"
  if [ "${previous_image:-}" = "$SELFHOST_LOCAL_SERVER_IMAGE" ]; then
    warn_selfhost "  it was built on this host and no registry has a copy; once pruned, the rollback has to rebuild it"
  fi
  if [ "${caddy_image_before:-}" = "$SELFHOST_LEGACY_CADDY_IMAGE" ]; then
    warn_selfhost "  keep ${SELFHOST_LEGACY_CADDY_IMAGE} too: the previous checkout's stack runs it"
  fi
}

trap 'upgrade_failed' EXIT
trap 'upgrade_failed 2' INT
trap 'upgrade_failed 15' TERM

load_selfhost_env
# Fail (or backfill) before the backup/build instead of letting the upgraded
# server refuse to boot over missing OAuth env.
ensure_selfhost_oauth_env
# Same reason, same moment: DELIVERY_ADAPTER=cloudfront without a distribution
# id (or with half a credential pair) makes resolveRuntimeConfig throw at
# startup. compose_selfhost no longer rejects it — that would abort a backup on
# a stack backup.sh can still service — so the recreating paths assert it here.
validate_selfhost_delivery_bootable

# The gcs storage overlay bind-mounts the service-account key into the server
# container; with the file missing, `compose up` puts an empty docker-created
# directory in its place and the server crash-loops on unusable credentials —
# and --i-have-a-backup skips the backup.sh run whose own guard would have
# caught it. Preflight it here like install.sh, backup.sh, and restore.sh do.
upgrade_storage_mode="$(selfhost_mode_from_env_file SELFHOST_STORAGE_MODE)"
if [ "${upgrade_storage_mode:-bundled}" = "gcs" ] && [ ! -f "$SELFHOST_GCS_KEY_FILE" ]; then
  fail_selfhost "missing ${SELFHOST_GCS_KEY_FILE} — this deployment records SELFHOST_STORAGE_MODE=gcs and the stack cannot run without the service-account key. Restore it from a backup (scripts/selfhost/restore.sh reinstalls it) or copy it from your secret store, then rerun."
fi

SMOKE_UNAUTHENTICATED=0
if [ "$SKIP_SMOKE" -eq 0 ] && [ -z "${CODEMAGIC_PATCH_TOKEN:-}" ]; then
  SMOKE_UNAUTHENTICATED=1
  warn_selfhost "CODEMAGIC_PATCH_TOKEN is not set; the post-upgrade smoke will run unauthenticated checks only and skip the publish/artifact smoke"
  warn_selfhost "for the full smoke, sign in with 'cmpatch login', run 'cmpatch token create', and set CODEMAGIC_PATCH_TOKEN=cm_pat_..."
fi

# ensure_selfhost_oauth_env above already validated the OAuth env (at least
# one provider, and each configured provider's id/secret pair). Older GitHub
# installs may still predate the redirect allowlist; backfill it here.
for upgrade_provider in $SELFHOST_OAUTH_PROVIDERS; do
  upgrade_id_var="${upgrade_provider}_OAUTH_CLIENT_ID"
  upgrade_redirect_var="${upgrade_provider}_OAUTH_ALLOWED_REDIRECT_URIS"
  if [ -n "${!upgrade_id_var:-}" ] && [ -z "${!upgrade_redirect_var:-}" ]; then
    # The callback follows the stack's scheme (SELFHOST_SCHEME), exactly as
    # install.sh derives it: https for the certificate and ngrok stacks.
    upgrade_scheme="$(selfhost_url_scheme "$(selfhost_scheme_from_env_file)")"
    set_selfhost_env_value "$upgrade_redirect_var" "${upgrade_scheme}://${CODEMAGIC_PATCH_API_DOMAIN}/auth/callback"
    warn_selfhost "${upgrade_redirect_var} was missing; defaulted to ${upgrade_scheme}://${CODEMAGIC_PATCH_API_DOMAIN}/auth/callback in ${SELFHOST_ENV_FILE}"
  fi
done

previous_image="${CODEMAGIC_PATCH_SERVER_IMAGE:-$SELFHOST_LOCAL_SERVER_IMAGE}"
PREVIOUS_IMAGE_ENV_ENTRY="$(grep -E '^CODEMAGIC_PATCH_SERVER_IMAGE=' "$SELFHOST_ENV_FILE" 2>/dev/null | tail -n 1 || true)"
PREVIOUS_CADDY_IMAGE_ENV_ENTRY="$(grep -E '^CODEMAGIC_PATCH_CADDY_IMAGE=' "$SELFHOST_ENV_FILE" 2>/dev/null | tail -n 1 || true)"
printf 'Current server image:\n  %s\n\n' "$previous_image"

if [ "$I_HAVE_BACKUP" -eq 0 ]; then
  pre_upgrade_root="${SELFHOST_BACKUP_ROOT:-${SELFHOST_REPO_ROOT}/backups}/pre-upgrade"
  log_selfhost "creating a pre-upgrade backup under ${pre_upgrade_root}"
  "$SELFHOST_REPO_ROOT/scripts/selfhost/backup.sh" "$pre_upgrade_root"
  # Backup dirs are timestamped (no special chars), so ls -t is safe here.
  # shellcheck disable=SC2012
  PRE_UPGRADE_BACKUP_DIR="$(ls -dt "${pre_upgrade_root}"/codemagic-patch-selfhost-* 2>/dev/null | head -n1 || true)"
  if [ -n "$PRE_UPGRADE_BACKUP_DIR" ]; then
    PRE_UPGRADE_BACKUP_DIR="$(cd "$PRE_UPGRADE_BACKUP_DIR" && pwd)"
  fi
else
  warn_selfhost "operator confirmed an external backup; no fresh backup was created"
fi

# Image values, after the backup so the backup holds the previous ones. Both
# are restored on a failure before the stack is recreated. Each is marked
# before its write, so a failure inside the write still restores the entry;
# the caddy mark is dropped again when the migration had nothing to change.
caddy_image_before="${CODEMAGIC_PATCH_CADDY_IMAGE:-}"
CADDY_IMAGE_ENV_UPDATED=1
migrate_selfhost_caddy_image
if [ "${CODEMAGIC_PATCH_CADDY_IMAGE:-}" = "$caddy_image_before" ]; then
  CADDY_IMAGE_ENV_UPDATED=0
fi

log_selfhost "updating CODEMAGIC_PATCH_SERVER_IMAGE to ${TARGET_IMAGE}"
IMAGE_ENV_UPDATED=1
set_selfhost_env_value CODEMAGIC_PATCH_SERVER_IMAGE "$TARGET_IMAGE"
load_selfhost_env

if [ "$SERVER_IMAGE_MODE" = build ]; then
  # Compose tags the build with the service's image value, which is why the
  # local ref was written first. The "rebuilding" wording is what the CLI's
  # upgrade progress keys on.
  keep_local_server_image
  log_selfhost "rebuilding the server image ${TARGET_IMAGE} from source"
  compose_selfhost build --pull server
  # The built image's own check, before the recreate: a refusal exits through
  # upgrade_failed, which puts the image values, the kept image and the
  # previous ref back.
  if [ "$SKIP_SCHEMA_CHECK" -eq 0 ]; then
    check_target_schema "The stack was not recreated; the previous image settings are put back below."
  fi
fi
log_selfhost "pulling caddy image ${CODEMAGIC_PATCH_CADDY_IMAGE}"
compose_selfhost pull caddy

log_selfhost "recreating stack"
# Mark before the call: `compose up` can fail after recreating some containers,
# leaving the stack partially upgraded — the rollback guidance must still fire.
STACK_RECREATE_ATTEMPTED=1
compose_selfhost up -d --remove-orphans
# The waits must match the stack compose_selfhost assembled from the mode flags:
# an external database has no postgres service and external storage (s3/gcs)
# has no minio service, so waiting on them would time out against nothing.
db_mode="$(selfhost_mode_from_env_file SELFHOST_DATABASE_MODE)"
storage_mode="$(selfhost_mode_from_env_file SELFHOST_STORAGE_MODE)"
if [ "${db_mode:-bundled}" != "external" ]; then
  wait_for_selfhost_service postgres
fi
case "${storage_mode:-bundled}" in
  s3 | gcs) ;;
  *) wait_for_selfhost_service minio ;;
esac
wait_for_selfhost_service server
wait_for_selfhost_http "${SERVER_URL%/}/health" "API health" 120

if [ "$SKIP_SMOKE" -eq 0 ]; then
  "$SELFHOST_REPO_ROOT/scripts/selfhost/smoke.sh"
fi

IMAGE_ENV_UPDATED=0
CADDY_IMAGE_ENV_UPDATED=0
trap - EXIT INT TERM
record_selfhost_source_revision ||
  warn_selfhost "could not record SELFHOST_SOURCE_REVISION in ${SELFHOST_ENV_FILE}; pass --previous-ref to the next upgrade.sh run"

printf '\nUpgrade complete.\n'
printf 'Previous server image:\n  %s\n' "$previous_image"
printf 'Current server image:\n  %s\n' "$TARGET_IMAGE"
if previous_ref_is_elsewhere; then
  printf 'Previous source ref:\n  %s\n' "$PREVIOUS_REF"
  printf 'Keep the previous server image (%s) on this host until you have confirmed\n' "${KEPT_LOCAL_IMAGE:-$previous_image}"
  printf 'the upgrade: rolling back (git checkout %s, then restore.sh) runs it.\n' "$PREVIOUS_REF"
fi
if [ -n "$KEPT_LOCAL_IMAGE" ]; then
  printf 'The server image this host ran before is kept as %s; remove it\n' "$KEPT_LOCAL_IMAGE"
  printf '(docker image rm %s) once the upgrade is confirmed.\n' "$KEPT_LOCAL_IMAGE"
fi
if [ "$SMOKE_UNAUTHENTICATED" -eq 1 ]; then
  printf '\nNote: publish/artifact smoke was skipped (no CODEMAGIC_PATCH_TOKEN).\n'
  printf 'Run CODEMAGIC_PATCH_TOKEN=cm_pat_... scripts/selfhost/smoke.sh for full validation.\n'
fi
printf '\nCurrent compose images:\n'
compose_selfhost images server
