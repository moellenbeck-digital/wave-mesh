#!/usr/bin/env bash
# The App Store's screenshots, for every size App Store Connect asks for and
# every language of the listing. Debug build against FakeTunnel with demo data
# (WaveUITests/StoreScreenshots.swift); nothing here talks to a server.
#
#   mobile/ios/store/screenshots.sh [out-dir]    default: mobile/ios/store/screenshots
#
# Needs Xcode (DEVELOPER_DIR) and Frameworks/Wavemobile.xcframework
# (`mobile/build.sh ios`).
set -euo pipefail
cd "$(dirname "$0")/.."
out="$(cd "${1:-store/screenshots}" 2>/dev/null && pwd || (mkdir -p "${1:-store/screenshots}" && cd "${1:-store/screenshots}" && pwd))"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

# 6.9" iPhone and 13" iPad: App Store Connect scales these down for the rest.
devices=("iPhone 17 Pro Max:iphone" "iPad Pro 13-inch (M5):ipad")
languages=(en de)

xcodegen generate --quiet
for entry in "${devices[@]}"; do
  device="${entry%%:*}" kind="${entry##*:}"
  udid="$(xcrun simctl list devices available | grep -F "    $device (" | head -1 | grep -oE '[0-9A-F-]{36}')"
  [ -n "$udid" ] || { echo "no simulator named $device" >&2; exit 1; }
  xcrun simctl boot "$udid" 2>/dev/null || true
  xcrun simctl bootstatus "$udid" -b >/dev/null
  # Apple's own picture of a phone: 9:41, full battery, full bars.
  xcrun simctl status_bar "$udid" override --time 9:41 --batteryState charged --batteryLevel 100 \
    --cellularMode active --cellularBars 4 --wifiBars 3 --dataNetwork wifi
  for lang in "${languages[@]}"; do
    dir="$out/$lang/$kind"
    rm -rf "$dir" && mkdir -p "$dir"
    TEST_RUNNER_STORE_SCREENSHOTS_DIR="$dir" TEST_RUNNER_STORE_LANG="$lang" \
      xcodebuild test -project Wave.xcodeproj -scheme Wave -destination "id=$udid" \
      -only-testing:WaveUITests/StoreScreenshots -quiet
    echo "$dir: $(ls "$dir" | tr '\n' ' ')"
  done
  xcrun simctl status_bar "$udid" clear
done
