#!/usr/bin/env bash
#
# Shared prelude for the scripts/local-eval/* scripts — sourced, never
# executed. Set LOCAL_EVAL_LOG_PREFIX before sourcing to brand the output.
#
# Diagnostics go to stderr so a caller (or a function like create_release)
# can capture a script's stdout — e.g. JSON from the CLI — without log lines
# bleeding into it.

LOCAL_EVAL_LOG_PREFIX="${LOCAL_EVAL_LOG_PREFIX:-local-eval}"

log() { printf '[%s] %s\n' "${LOCAL_EVAL_LOG_PREFIX}" "$*" >&2; }
fail() { printf '[%s] FAIL: %s\n' "${LOCAL_EVAL_LOG_PREFIX}" "$*" >&2; exit 1; }

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}
