#!/usr/bin/env bash
# Release build, then install on a simulator.
#
# `react-native run-ios` opens Simulator.app before xcodebuild, so the device
# sits idle through a compile that does not need it. xcodebuild does not open
# a simulator; we boot one only once the .app exists.
set -euo pipefail
cd "$(dirname "$0")/.."

udid=""
if [ "$#" -gt 0 ]; then
  if [ "$#" -ne 2 ] || [ "$1" != "--udid" ] || [ -z "$2" ]; then
    echo "Usage: $0 [--udid <simulator-id>]" >&2
    exit 1
  fi
  udid="$2"
  # An explicit target must never silently fall back to another simulator.
  xcrun simctl list devices available -j | node -e '
    const fs = require("fs");
    const devices = JSON.parse(fs.readFileSync(0, "utf8")).devices;
    const found = Object.entries(devices).some(([runtime, entries]) =>
      runtime.includes("iOS") && entries.some(d => d.udid === process.argv[1] && d.isAvailable !== false));
    if (!found) { console.error("error: requested iOS simulator is unavailable"); process.exit(1); }
  ' "$udid"
fi

APP_ID="io.codemagic.patch.demo"
APP="ios/build/Build/Products/Release-iphonesimulator/PatchDemo.app"
WORKSPACE="ios/PatchDemo.xcworkspace"

if [ ! -d "$WORKSPACE" ]; then
  echo "error: ${WORKSPACE} is missing. Run yarn demo:setup:ios first." >&2
  exit 1
fi

echo "Building PatchDemo (Release, iOS Simulator)…"
xcodebuild \
  -workspace "$WORKSPACE" \
  -scheme PatchDemo \
  -configuration Release \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath ios/build

if [ ! -d "$APP" ]; then
  echo "error: xcodebuild succeeded but ${APP} was not produced." >&2
  exit 1
fi

if [ -z "$udid" ]; then
  udid="$(xcrun simctl list devices available -j | node -e '
    const fs = require("fs");
    const devices = Object.entries(JSON.parse(fs.readFileSync(0, "utf8")).devices)
      .filter(([runtime]) => runtime.includes("iOS"))
      .flatMap(([, entries]) => entries)
      .filter(d => d.isAvailable !== false && d.name.startsWith("iPhone"));
    const target = devices.find(d => d.state === "Booted") || devices[0];
    if (target) process.stdout.write(target.udid);
  ')"
fi
if [ -z "$udid" ]; then
  echo "error: no available iPhone simulator. Install one in Xcode." >&2
  exit 1
fi

echo "Installing on the simulator…"
developer_dir="$(xcode-select -p)"
open "${developer_dir}/Applications/Simulator.app" --args -CurrentDeviceUDID "$udid"
xcrun simctl bootstatus "$udid" -b
xcrun simctl install "$udid" "$APP"
xcrun simctl launch "$udid" "$APP_ID"
