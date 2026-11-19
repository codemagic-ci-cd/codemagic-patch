#!/bin/bash
# Body of the "Codemagic Patch build metadata" Xcode run-script phase
# (client/specs/build-integration/Spec.md). The phase text in the app project
# (build-integration.json) handles the opt-out, refuses to run in Xcode's
# script sandbox, finds this file in the installed SDK and runs
#   /bin/bash <this file> --integration rn|expo
# Everything else is here, so it changes with an SDK upgrade: React Native's
# Node environment, and the run of the SDK writer next to this file, which
# computes and writes CodemagicPatchBuild.json.

set -e

TAG="[codemagic-patch build metadata]"
fail() {
  echo "error: $TAG $*" >&2
  exit 1
}

# An argument this SDK does not know comes from phase text written for a newer
# SDK (a downgrade, or an older node_modules). It is ignored, so a later SDK
# can add one without breaking builds on this one.
INTEGRATION=""
IGNORED=""
while [ $# -gt 0 ]; do
  case "$1" in
    --integration)
      [ $# -ge 2 ] || fail "--integration needs a value (rn or expo)"
      INTEGRATION="$2"
      shift 2
      ;;
    *)
      IGNORED="$IGNORED $1"
      shift
      ;;
  esac
done
if [ -n "$IGNORED" ]; then
  echo "warning: $TAG ignoring arguments this SDK does not know:$IGNORED. The build phase in the project was written for a newer @codemagic/react-native-patch than the one installed."
fi
case "$INTEGRATION" in
  rn | expo) ;;
  *) fail "--integration must be rn or expo" ;;
esac

for setting in PROJECT_DIR CONFIGURATION CONFIGURATION_BUILD_DIR TARGET_BUILD_DIR UNLOCALIZED_RESOURCES_FOLDER_PATH; do
  if [ -z "${!setting:-}" ]; then
    fail "the build setting $setting is not set. This phase runs only as a build phase of an application target."
  fi
done

SDK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
WRITER="$SDK_ROOT/dist/build-tools/fingerprint.js"
if [ ! -f "$WRITER" ]; then
  fail "$WRITER is missing. Reinstall @codemagic/react-native-patch (a source checkout of the SDK needs 'yarn build')."
fi

# The app root is where `cmpatch` computes the fingerprint at release time:
# the directory whose ios directory holds the native project.
APP_ROOT_INPUT="${PROJECT_ROOT:-$PROJECT_DIR/..}"
APP_ROOT_FROM="the parent of the Xcode project's directory"
if [ -n "${PROJECT_ROOT:-}" ]; then
  APP_ROOT_FROM="the PROJECT_ROOT build setting"
fi
APP_ROOT="$(cd "$APP_ROOT_INPUT" 2>/dev/null && pwd -P)" || fail "the app root $APP_ROOT_INPUT ($APP_ROOT_FROM) does not exist."

# Node.js is the one React Native's bundle phase runs: RN's own environment
# script reads .xcode.env and .xcode.env.local and falls back to a version
# manager. Its NODE_BINARY and PATH are kept for the writer. RN's
# node-binary.sh is not sourced: it exits with RN's own message, which names
# the bundle phase and no way to build without this step.
RN_DIR="${REACT_NATIVE_PATH:-}"
if [ ! -f "$RN_DIR/scripts/xcode/with-environment.sh" ]; then
  RN_DIR=""
  SEARCH_DIR="$APP_ROOT"
  while [ -z "$RN_DIR" ]; do
    if [ -f "$SEARCH_DIR/node_modules/react-native/scripts/xcode/with-environment.sh" ]; then
      RN_DIR="$SEARCH_DIR/node_modules/react-native"
    elif [ "$SEARCH_DIR" = / ]; then
      fail "cannot find React Native's scripts/xcode/with-environment.sh. Install the project's dependencies or set REACT_NATIVE_PATH to the installed react-native directory. To build without metadata, set CODEMAGIC_PATCH_SKIP_BUILD_FINGERPRINT=1."
    else
      SEARCH_DIR="$(dirname "$SEARCH_DIR")"
    fi
  done
fi
export REACT_NATIVE_PATH="$(cd "$RN_DIR" && pwd -P)"
# RN reads .xcode.env next to PODS_ROOT. A SwiftPM host has no Pods directory;
# its .xcodeproj has the same parent.
ENV_ANCHOR="${PODS_ROOT:-${PROJECT_FILE_PATH:-$PROJECT_DIR/Pods}}"
ENV_DIR="$ENV_ANCHOR/.."
PODS_ROOT="$ENV_ANCHOR" source "$REACT_NATIVE_PATH/scripts/xcode/with-environment.sh" ""
if [ "$INTEGRATION" = expo ]; then
  # Expo's generated bundle phase skips bundling for every *Debug*
  # configuration, then lets .xcode.env.updates and .xcode.env.local undo that.
  if [[ "$CONFIGURATION" = *Debug* ]]; then
    export SKIP_BUNDLING=1
  fi
  if [ -f "$ENV_DIR/.xcode.env.updates" ]; then
    source "$ENV_DIR/.xcode.env.updates"
  fi
  if [ -f "$ENV_DIR/.xcode.env.local" ]; then
    source "$ENV_DIR/.xcode.env.local"
  fi
fi
# As in React Native's node-binary.sh: NODE_BINARY defaults to node and may be
# a command name (export NODE_BINARY=node), looked up on PATH.
NODE_SETTING="${NODE_BINARY:-node}"
NODE_BINARY=$(command -v "$NODE_SETTING" || echo "")
if [ -z "$NODE_BINARY" ]; then
  fail "Node.js not found (NODE_BINARY='$NODE_SETTING'). Set NODE_BINARY in ios/.xcode.env or ios/.xcode.env.local. To build without metadata, set CODEMAGIC_PATCH_SKIP_BUILD_FINGERPRINT=1."
fi

# The writer derives the bundle mode from these (--bundle-mode xcode); the
# sourced files above may set them without exporting them.
export CONFIGURATION PLATFORM_NAME ACTION SKIP_BUNDLING FORCE_BUNDLING

# The writer's own lines carry the error: and warning: prefixes Xcode lists as issues.
set +e
"$NODE_BINARY" "$WRITER" write \
  --platform ios \
  --app-root "$APP_ROOT" \
  --bundle-mode xcode \
  --bundle-input-dir "$CONFIGURATION_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH" \
  --bundle-name "${BUNDLE_NAME:-main}.jsbundle" \
  --output "$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/CodemagicPatchBuild.json"
STATUS=$?
set -e
if [ "$STATUS" -ne 0 ]; then
  fail "the writer failed (exit $STATUS) for app root $APP_ROOT ($APP_ROOT_FROM); no CodemagicPatchBuild.json was written."
fi
