#!/usr/bin/env bash
# iOS dependency setup for the on-device demo.
#
# Preferred path: Bundler with the pinned Gemfile.lock (reproducible CocoaPods
# version). Real-world fallback: macOS system Ruby (2.6) cannot run the pinned
# bundler, but most RN developers already have a working `pod` on PATH
# (Homebrew or gem) — use it rather than failing the walkthrough.
set -euo pipefail
cd "$(dirname "$0")/.."

export LANG="${LANG:-en_US.UTF-8}"

if bundle install >/dev/null 2>&1; then
  echo "Installing pods via Bundler (pinned by Gemfile.lock)…"
  (cd ios && bundle exec pod install)
elif command -v pod >/dev/null 2>&1; then
  echo "Bundler unavailable for the pinned Gemfile.lock — using 'pod' from PATH…"
  (cd ios && pod install)
else
  echo "error: need either Ruby ≥3 with Bundler, or CocoaPods ('pod') on PATH." >&2
  echo "  brew install cocoapods   # or: gem install bundler cocoapods" >&2
  exit 1
fi
