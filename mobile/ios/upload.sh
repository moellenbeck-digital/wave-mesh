#!/usr/bin/env bash
# Builds the iOS app and uploads it to App Store Connect (TestFlight).
#
# The same script locally and in CI. Everything secret comes from the
# environment and lives only in a throwaway keychain and a temporary directory
# that are removed on exit -- nothing is added to the login keychain.
#
#   ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8_BASE64   App Store Connect API key
#   DIST_P12_BASE64, DIST_P12_PASSWORD             Apple Distribution certificate
#   APP_PROFILE_BASE64, TUNNEL_PROFILE_BASE64      App Store profiles of both targets
#   BUILD_NUMBER                                   unique per upload (CI run number)
#   UPLOAD=0                                       export the .ipa only, no upload
#
# Requires ios/Frameworks/Wavemobile.xcframework (../build.sh ios) and xcodegen.
set -euo pipefail
cd "$(dirname "$0")"

: "${ASC_KEY_ID:?}" "${ASC_ISSUER_ID:?}" "${ASC_KEY_P8_BASE64:?}"
: "${DIST_P12_BASE64:?}" "${DIST_P12_PASSWORD:?}"
: "${APP_PROFILE_BASE64:?}" "${TUNNEL_PROFILE_BASE64:?}" "${BUILD_NUMBER:?}"
TEAM_ID=L6R92A4Y7C

work=$(mktemp -d)
keychain="$work/signing.keychain-db"
profiles="$HOME/Library/MobileDevice/Provisioning Profiles"
installed=()
original_keychains=$(security list-keychains -d user | tr -d '"')
cleanup() {
  # shellcheck disable=SC2086
  security list-keychains -d user -s $original_keychains
  security delete-keychain "$keychain" 2>/dev/null || true
  for f in "${installed[@]}"; do rm -f "$f"; done
  rm -rf "$work"
}
trap cleanup EXIT
umask 077

key="$work/AuthKey_$ASC_KEY_ID.p8"
base64 -d <<<"$ASC_KEY_P8_BASE64" >"$key"

# A keychain of its own, unlocked for this run, with only the one identity.
keychain_password=$(openssl rand -hex 16)
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 3600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
base64 -d <<<"$DIST_P12_BASE64" >"$work/dist.p12"
security import "$work/dist.p12" -k "$keychain" -P "$DIST_P12_PASSWORD" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple: -k "$keychain_password" "$keychain" >/dev/null
# shellcheck disable=SC2086
security list-keychains -d user -s "$keychain" $original_keychains

# Profiles are looked up by UUID; their names go into the build settings.
mkdir -p "$profiles"
profile() {
  local file="$work/$1.mobileprovision"
  base64 -d <<<"$2" >"$file"
  local plist; plist=$(security cms -D -i "$file")
  local uuid; uuid=$(/usr/libexec/PlistBuddy -c "Print UUID" /dev/stdin <<<"$plist")
  cp "$file" "$profiles/$uuid.mobileprovision"
  installed+=("$profiles/$uuid.mobileprovision")
  /usr/libexec/PlistBuddy -c "Print Name" /dev/stdin <<<"$plist"
}
app_profile=$(profile app "$APP_PROFILE_BASE64")
tunnel_profile=$(profile tunnel "$TUNNEL_PROFILE_BASE64")

xcodegen generate --quiet

xcodebuild -project Wave.xcodeproj -scheme Wave -configuration Release \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$work/dd" -archivePath "$work/wave-mesh.xcarchive" \
  CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="Apple Distribution" \
  OTHER_CODE_SIGN_FLAGS="--keychain $keychain" \
  WAVE_APP_PROFILE="$app_profile" WAVE_TUNNEL_PROFILE="$tunnel_profile" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  -quiet archive

destination=upload
[[ "${UPLOAD:-1}" == 0 ]] && destination=export
cat >"$work/export.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$destination</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>Apple Distribution</string>
  <key>provisioningProfiles</key><dict>
    <key>org.wavemesh.app</key><string>$app_profile</string>
    <key>org.wavemesh.app.tunnel</key><string>$tunnel_profile</string>
  </dict>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>uploadSymbols</key><true/>
</dict></plist>
PLIST

out="${OUTPUT_DIR:-$PWD/build}"
mkdir -p "$out"
xcodebuild -exportArchive -archivePath "$work/wave-mesh.xcarchive" \
  -exportOptionsPlist "$work/export.plist" -exportPath "$out" \
  -authenticationKeyPath "$key" -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID" -quiet
echo "build $BUILD_NUMBER: $destination done"
