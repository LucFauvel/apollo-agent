#!/usr/bin/env bash
# Builds the iOS app and uploads it to App Store Connect (TestFlight).
#
#   pnpm --filter @apollo/mobile testflight            # JS-only changes
#   pnpm --filter @apollo/mobile testflight --prebuild # after adding native modules or plugins
#
# The archive is signed with the App Store profile (not left unsigned and signed only at
# upload): an unsigned archive loses its entitlements, and push notifications then fail
# with "no valid aps-environment entitlement". Override for another account with
# APOLLO_TEAM_ID, APOLLO_PROFILE and APOLLO_BUNDLE_ID.
set -euo pipefail

TEAM="${APOLLO_TEAM_ID:-XA3R5NAN2C}"
PROFILE="${APOLLO_PROFILE:-Apollo Agent App Store}"
BUNDLE="${APOLLO_BUNDLE_ID:-dev.ocx64.apollo.mobile}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
export LANG=en_US.UTF-8 # CocoaPods fails without a UTF-8 locale

cd "$HERE"
BUILD="$(date +%Y%m%d%H%M)"
sed -i '' "s/\"buildNumber\": \"[0-9]*\"/\"buildNumber\": \"$BUILD\"/" app.json
if [[ "${1:-}" == "--prebuild" || ! -d ios ]]; then
  CI=1 npx expo prebuild -p ios --no-install
  (cd ios && pod install)
fi
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD" ios/Apollo/Info.plist
echo "▸ Build $BUILD"

xcodebuild -workspace ios/Apollo.xcworkspace -scheme Apollo -configuration Release \
  -destination "generic/platform=iOS" -archivePath "$OUT/Apollo.xcarchive" \
  DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="Apple Distribution" \
  PROVISIONING_PROFILE_SPECIFIER="$PROFILE" archive | tail -3

codesign -d --entitlements - "$OUT/Apollo.xcarchive/Products/Applications/Apollo.app" 2>/dev/null | grep -q aps-environment \
  || { echo "The archive has no push entitlement: is the profile right?" >&2; exit 1; }

cat > "$OUT/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>$TEAM</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>Apple Distribution</string>
  <key>provisioningProfiles</key><dict><key>$BUNDLE</key><string>$PROFILE</string></dict>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict></plist>
PLIST

echo "▸ Uploading"
xcodebuild -exportArchive -archivePath "$OUT/Apollo.xcarchive" -exportOptionsPlist "$OUT/ExportOptions.plist" \
  -exportPath "$OUT/export" -allowProvisioningUpdates 2>&1 | grep -E "Uploaded|EXPORT|error:" | grep -v "Upload Symbols"
rm -rf "$OUT"
echo "✓ Build $BUILD uploaded. TestFlight shows it after Apple processes it (usually 10–30 minutes)."
