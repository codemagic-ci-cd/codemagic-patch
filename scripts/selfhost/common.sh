#!/usr/bin/env bash

SELFHOST_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELFHOST_REPO_ROOT="$(cd "${SELFHOST_SCRIPT_DIR}/../.." && pwd)"
SELFHOST_COMPOSE_FILE="${SELFHOST_COMPOSE_FILE:-${SELFHOST_REPO_ROOT}/docker-compose.selfhost.yml}"
SELFHOST_ENV_FILE="${SELFHOST_ENV_FILE:-${SELFHOST_REPO_ROOT}/.env.selfhost}"
SELFHOST_PROJECT_NAME="${SELFHOST_PROJECT_NAME:-codemagic-patch-selfhost}"
SELFHOST_DEFAULT_TIMEOUT_SECONDS="${SELFHOST_TIMEOUT_SECONDS:-300}"

log_selfhost() {
  printf '[selfhost] %s\n' "$*"
}

warn_selfhost() {
  printf '[selfhost] WARN: %s\n' "$*" >&2
}

fail_selfhost() {
  printf '[selfhost] FAIL: %s\n' "$*" >&2
  exit 1
}

require_command_selfhost() {
  command -v "$1" >/dev/null 2>&1 || fail_selfhost "missing required command: $1"
}

require_env_file_selfhost() {
  [ -f "$SELFHOST_ENV_FILE" ] ||
    fail_selfhost "missing ${SELFHOST_ENV_FILE}; run scripts/selfhost/install.sh first"
}

# Assert an env var loaded from the env file is set and non-empty. Call before
# any destructive step so a missing value fails the script up front instead of
# tripping `set -u` later (e.g. after volumes have already been wiped).
require_selfhost_env_var() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    fail_selfhost "${name} is missing or empty in ${SELFHOST_ENV_FILE}; fix the env file and rerun."
  fi
}

# Load the env file the same way docker compose's --env-file does: parse literal
# KEY=VALUE lines, NOT shell `source`. Sourcing executes the file, so a value
# with spaces, a `#`, or a `$(...)` substitution that compose accepts fine would
# break every maintenance script (or run arbitrary code). This reads each line
# literally instead, stripping one layer of matching surrounding quotes.
load_selfhost_env() {
  require_env_file_selfhost
  local line key value
  while IFS= read -r line || [ -n "$line" ]; do
    # Skip blank lines.
    case "$line" in
      *[![:space:]]*) ;;
      *) continue ;;
    esac
    # Trim leading whitespace, then skip comment lines.
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in
      '#'*) continue ;;
    esac
    # Optional "export " prefix, as compose/godotenv accepts.
    case "$line" in
      export[[:space:]]*) line="${line#export}"; line="${line#"${line%%[![:space:]]*}"}" ;;
    esac
    case "$line" in
      *=*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    value="${line#*=}"
    # Trim trailing whitespace from the key; skip non-identifier keys.
    key="${key%"${key##*[![:space:]]}"}"
    case "$key" in
      '' | *[!A-Za-z0-9_]*) continue ;;
    esac
    # Parse the value the way compose's dotenv does: a quoted value keeps its
    # contents verbatim and drops anything (e.g. a trailing comment) after the
    # closing quote; an unquoted value is trimmed and an inline comment (a '#'
    # introduced by whitespace) is stripped. A '#' without leading whitespace
    # stays part of the value.
    case "$value" in
      [[:space:]]*) value="${value#"${value%%[![:space:]]*}"}" ;;
    esac
    case "$value" in
      '"'*) value="${value#\"}"; value="${value%%\"*}" ;;
      "'"*) value="${value#\'}"; value="${value%%\'*}" ;;
      *)
        case "$value" in
          *[[:space:]]'#'*) value="${value%%[[:space:]]'#'*}" ;;
        esac
        value="${value%"${value##*[![:space:]]}"}"
        ;;
    esac
    export "$key=$value"
  done <"$SELFHOST_ENV_FILE"
}

compose_selfhost() {
  docker compose \
    --project-name "$SELFHOST_PROJECT_NAME" \
    --env-file "$SELFHOST_ENV_FILE" \
    -f "$SELFHOST_COMPOSE_FILE" \
    "$@"
}

selfhost_container_id() {
  local service="$1"
  compose_selfhost ps -q "$service"
}

selfhost_health_status() {
  local service="$1"
  local container_id
  container_id="$(selfhost_container_id "$service")"
  [ -n "$container_id" ] || return 1
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id"
}

# Fail fast if a service container is not running. Use before operations that
# require a live stack (e.g. backup) so a stopped stack errors immediately
# instead of after wait_for_selfhost_service's full timeout.
require_selfhost_service_running() {
  local service="$1"
  if [ -z "$(compose_selfhost ps --status running -q "$service" 2>/dev/null)" ]; then
    fail_selfhost "the self-host stack is not running (${service} is down); start it before continuing — e.g. scripts/selfhost/install.sh, or: docker compose --project-name ${SELFHOST_PROJECT_NAME} --env-file ${SELFHOST_ENV_FILE} -f ${SELFHOST_COMPOSE_FILE} up -d"
  fi
}

wait_for_selfhost_service() {
  local service="$1"
  local timeout_seconds="${2:-$SELFHOST_DEFAULT_TIMEOUT_SECONDS}"
  local deadline
  local status
  deadline=$((SECONDS + timeout_seconds))

  while [ "$SECONDS" -lt "$deadline" ]; do
    status="$(selfhost_health_status "$service" 2>/dev/null || true)"
    case "$status" in
      healthy|running)
        log_selfhost "${service} is ${status}"
        return 0
        ;;
      unhealthy|exited|dead)
        compose_selfhost logs --tail=80 "$service" >&2 || true
        fail_selfhost "${service} is ${status}"
        ;;
    esac
    sleep 3
  done

  compose_selfhost logs --tail=80 "$service" >&2 || true
  fail_selfhost "timed out waiting for ${service}"
}

wait_for_selfhost_http() {
  local url="$1"
  local label="$2"
  local timeout_seconds="${3:-$SELFHOST_DEFAULT_TIMEOUT_SECONDS}"
  local heartbeat_seconds="${SELFHOST_HTTP_HEARTBEAT_SECONDS:-30}"
  local start
  local deadline
  local next_heartbeat
  local status
  local elapsed
  start="$SECONDS"
  deadline=$((start + timeout_seconds))
  next_heartbeat=$((start + heartbeat_seconds))

  while [ "$SECONDS" -lt "$deadline" ]; do
    status="$(curl -sS -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || true)"
    case "$status" in
      2*|3*)
        log_selfhost "${label} is reachable: ${url}"
        return 0
        ;;
    esac
    if [ "$SECONDS" -ge "$next_heartbeat" ]; then
      elapsed=$((SECONDS - start))
      log_selfhost "still waiting for ${label} (${elapsed}s/${timeout_seconds}s, last status ${status:-none}): ${url}"
      next_heartbeat=$((SECONDS + heartbeat_seconds))
    fi
    sleep 5
  done

  compose_selfhost logs --tail=80 caddy >&2 || true
  fail_selfhost "${label} did not become reachable at ${url}; check DNS, firewall, and Caddy certificate logs"
}

random_selfhost_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return
  fi

  local secret
  secret="$(LC_ALL=C tr -dc 'a-f0-9' </dev/urandom | head -c 64 || true)"
  [ "${#secret}" -eq 64 ] || fail_selfhost "could not generate a random secret"
  printf '%s' "$secret"
  printf '\n'
}

strip_trailing_slash() {
  local value="$1"
  printf '%s' "${value%/}"
}

# Validate (and migrate) the OAuth env the server refuses to boot without.
# Call after load_selfhost_env. Pre-OAuth installs recorded the admin email
# only as ACME_EMAIL, so INITIAL_ADMIN_EMAILS is backfilled from it; the
# device-poll secret is server-local and can simply be generated.
ensure_selfhost_oauth_env() {
  local env_changed=0

  if [ -z "${GITHUB_OAUTH_CLIENT_ID:-}" ]; then
    fail_selfhost "GITHUB_OAUTH_CLIENT_ID is missing from ${SELFHOST_ENV_FILE}. GitHub OAuth is now required. Create a GitHub OAuth App (device flow) and add its client ID to the env file, then rerun. Existing API tokens keep working."
  fi

  if [ -z "${OAUTH_DEVICE_POLL_TOKEN_SECRET:-}" ]; then
    log_selfhost "OAUTH_DEVICE_POLL_TOKEN_SECRET is missing; generating one"
    set_selfhost_env_value OAUTH_DEVICE_POLL_TOKEN_SECRET "$(random_selfhost_secret)"
    env_changed=1
  elif [ "${#OAUTH_DEVICE_POLL_TOKEN_SECRET}" -lt 32 ]; then
    # The server enforces this minimum at boot; fail here instead of after
    # the backup/build.
    fail_selfhost "OAUTH_DEVICE_POLL_TOKEN_SECRET in ${SELFHOST_ENV_FILE} is shorter than 32 characters and the server will refuse to boot with it. Set a longer value, or remove the line to have one generated."
  fi

  # The server requires INITIAL_ADMIN_EMAILS only under invite-only
  # registration; an open-registration stack boots without it.
  if [ "${REGISTRATION_MODE:-invite_only}" != "open" ] &&
    [ -z "${INITIAL_ADMIN_EMAILS:-}" ]; then
    if [ -n "${ACME_EMAIL:-}" ]; then
      log_selfhost "INITIAL_ADMIN_EMAILS is missing; backfilling from ACME_EMAIL=${ACME_EMAIL}"
      warn_selfhost "the admin must sign in with the GitHub account whose verified primary email is ${ACME_EMAIL}; edit INITIAL_ADMIN_EMAILS in ${SELFHOST_ENV_FILE} if that is not the admin's email"
      set_selfhost_env_value INITIAL_ADMIN_EMAILS "$ACME_EMAIL"
      env_changed=1
    else
      fail_selfhost "INITIAL_ADMIN_EMAILS is missing from ${SELFHOST_ENV_FILE} and there is no ACME_EMAIL to backfill from. Add INITIAL_ADMIN_EMAILS=<admin email> (the admin's verified primary GitHub email), then rerun."
    fi
  fi

  if [ "$env_changed" -eq 1 ]; then
    load_selfhost_env
  fi
}

set_selfhost_env_value() {
  local key="$1"
  local value="$2"
  local tmp
  tmp="$(mktemp "${SELFHOST_ENV_FILE}.XXXXXX")"

  awk -v key="$key" -v line="${key}=${value}" '
    BEGIN { replaced = 0 }
    index($0, key "=") == 1 {
      print line
      replaced = 1
      next
    }
    { print }
    END {
      if (replaced == 0) {
        print line
      }
    }
  ' "$SELFHOST_ENV_FILE" >"$tmp"

  chmod 600 "$tmp"
  mv "$tmp" "$SELFHOST_ENV_FILE"
}

remove_selfhost_env_value() {
  local key="$1"
  local tmp
  tmp="$(mktemp "${SELFHOST_ENV_FILE}.XXXXXX")"

  awk -v key="$key" '
    index($0, key "=") == 1 {
      next
    }
    { print }
  ' "$SELFHOST_ENV_FILE" >"$tmp"

  chmod 600 "$tmp"
  mv "$tmp" "$SELFHOST_ENV_FILE"
}

confirm_selfhost_destructive_action() {
  local prompt="$1"
  local expected="$2"
  local answer

  printf '%s\n' "$prompt"
  printf 'Type %s to continue: ' "$expected"
  read -r answer
  [ "$answer" = "$expected" ] || fail_selfhost "confirmation did not match; aborting"
}

# Yes/no prompt. Returns 0 for yes, 1 for no. With no TTY (non-interactive) it
# returns the default without prompting. The second argument sets the default
# ("yes" or "no"; defaults to "no").
prompt_yes_no() {
  local prompt="$1"
  local default="${2:-no}"
  local hint
  local answer

  if [ "$default" = "yes" ]; then
    hint="[Y/n]"
  else
    hint="[y/N]"
  fi

  if [ ! -t 0 ]; then
    [ "$default" = "yes" ]
    return
  fi

  printf '%s %s ' "$prompt" "$hint"
  read -r answer
  answer="$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')"
  case "$answer" in
    y | yes) return 0 ;;
    n | no) return 1 ;;
    "") [ "$default" = "yes" ] ;;
    *) return 1 ;;
  esac
}
