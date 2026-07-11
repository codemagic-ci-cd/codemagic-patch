#!/usr/bin/env bash
# Build-verification lane for the on-device demo app (no emulator needed).
#
# The demo pins the same RN minor as an e2e fixture app, but that only aligns
# upgrade *timing* — this app's own build needs its own check. Run this after
# dependency or SDK bumps, and from any future CI lane. The actual on-device
# OTA apply is verified manually per the walkthrough.
#
# Usage: scripts/ci-check.sh [--android-release]
#   --android-release  additionally run `gradlew assembleRelease` (slow; needs
#                      an Android SDK; embedded-bundle wiring is exercised)
set -euo pipefail
cd "$(dirname "$0")/.."

# Resolve the cmpatch CLI: prefer the global install the walkthrough sets up,
# fall back to the repository's built CLI (which is also what a CI lane on a
# clean checkout should use — it exercises the repo-tip CLI against the npm
# SDK, the exact pairing evaluators run).
if command -v cmpatch >/dev/null 2>&1; then
  CMPATCH=(cmpatch)
elif [ -f ../../cli/dist/cmpatch.js ]; then
  CMPATCH=(node ../../cli/dist/cmpatch.js)
else
  echo "error: no cmpatch CLI available." >&2
  echo "  either run ../../scripts/local-eval/up.sh (installs it globally)," >&2
  echo "  or build the repo CLI: (cd ../.. && yarn install && yarn workspace codemagic-patch build)" >&2
  exit 1
fi

echo "==> yarn install --immutable"
yarn install --immutable

echo "==> typecheck"
yarn typecheck

echo "==> cmpatch bundle (ios) — exercises Metro + Hermes + fingerprint"
OUT_DIR="$(mktemp -d)"
trap 'rm -rf "$OUT_DIR"' EXIT
"${CMPATCH[@]}" bundle --platform ios --output "$OUT_DIR/ios.cmpatch"

echo "==> cmpatch bundle (android)"
"${CMPATCH[@]}" bundle --platform android --output "$OUT_DIR/android.cmpatch"

if [ "${1:-}" = "--android-release" ]; then
  echo "==> android assembleRelease"
  (cd android && ./gradlew assembleRelease)
fi

echo "OK"
