#!/usr/bin/env bash
# Builds the iOS app and uploads it to App Store Connect (TestFlight).
#
#   pnpm --filter @apollo/mobile testflight            # JS-only changes
#   pnpm --filter @apollo/mobile testflight --prebuild # after adding native modules or plugins
#
# Signing: the archive is built unsigned, then signed ad hoc here with the app's
# entitlements (an archive without them uploads an app whose pushes fail with "no valid
# aps-environment entitlement"). The export step signs it for the App Store
# automatically, for the app and its notification service extension: Xcode creates their
# App Store profiles with the account signed in under Xcode → Settings → Accounts. No
# development profiles, so the team needs no registered devices. Override the team
# with APOLLO_TEAM_ID.
#
# CI (.github/workflows/ios-testflight.yml) runs this same script. It sets the App Store Connect
# key through the environment (APOLLO_ASC_KEY_ID, APOLLO_ASC_ISSUER_ID, APOLLO_ASC_KEY_PATH,
# the same contract as ~/.appstoreconnect/apollo.env), the build number (APOLLO_BUILD_NUMBER) and,
# for manual signing with an imported Apple Distribution certificate, the App Store provisioning
# profiles' names (APOLLO_PROFILE_APP, APOLLO_PROFILE_NSE). Without those, export signing stays
# automatic, as it is locally.
set -euo pipefail

TEAM="${APOLLO_TEAM_ID:-XA3R5NAN2C}"

# Uploading uses an App Store Connect API key when one is set up, else the account signed in
# to Xcode. Xcode's sign-in only lasts about an hour for command-line uploads (Xcode renews it
# only while it is open); a key does not expire. Create one in App Store Connect → Users and
# Access → Integrations → App Store Connect API (role: App Manager), save the .p8 as
# ~/.appstoreconnect/private_keys/AuthKey_<KEY ID>.p8, and put in ~/.appstoreconnect/apollo.env:
#   APOLLO_ASC_KEY_ID=<KEY ID>
#   APOLLO_ASC_ISSUER_ID=<issuer ID>
[[ -f "$HOME/.appstoreconnect/apollo.env" ]] && source "$HOME/.appstoreconnect/apollo.env"
AUTH=()
if [[ -n "${APOLLO_ASC_KEY_ID:-}" && -n "${APOLLO_ASC_ISSUER_ID:-}" ]]; then
  KEY="${APOLLO_ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${APOLLO_ASC_KEY_ID}.p8}"
  [[ -f "$KEY" ]] || { echo "App Store Connect key not found: $KEY" >&2; exit 1; }
  AUTH=(-authenticationKeyPath "$KEY" -authenticationKeyID "$APOLLO_ASC_KEY_ID" -authenticationKeyIssuerID "$APOLLO_ASC_ISSUER_ID")
fi
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
export LANG=en_US.UTF-8 # CocoaPods fails without a UTF-8 locale

cd "$HERE"
# UTC minute (YYYYMMDDHHMM), the same sequence as CI builds (apps/desktop/scripts/release/version.ts).
BUILD="${APOLLO_BUILD_NUMBER:-$(date -u +%Y%m%d%H%M)}"
[[ "$BUILD" =~ ^[0-9]{12}$ ]] || { echo "Build number must be YYYYMMDDHHMM, got: $BUILD" >&2; exit 1; }
sed -i '' "s/\"buildNumber\": \"[0-9]*\"/\"buildNumber\": \"$BUILD\"/" app.json
# The embedded Tailscale node (Go, tsnet) is a gitignored static library; build it once.
# Delete modules/apollo-tailnet/ios/ApolloTailnet.xcframework to rebuild after Go changes.
if [[ ! -d modules/apollo-tailnet/ios/ApolloTailnet.xcframework ]]; then
  bash modules/apollo-tailnet/scripts/build-go.sh
fi
if [[ "${1:-}" == "--prebuild" || ! -d ios ]]; then
  CI=1 npx expo prebuild -p ios --no-install
  (cd ios && pod install)
fi
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD" ios/Apollo/Info.plist
echo "▸ Build $BUILD"

xcodebuild -workspace ios/Apollo.xcworkspace -scheme Apollo -configuration Release \
  -destination "generic/platform=iOS" -archivePath "$OUT/Apollo.xcarchive" \
  DEVELOPMENT_TEAM="$TEAM" CODE_SIGNING_ALLOWED=NO CURRENT_PROJECT_VERSION="$BUILD" \
  archive | grep -E "^\*\* ARCHIVE| error: " | tail -8

APP="$OUT/Apollo.xcarchive/Products/Applications/Apollo.app"
[[ -d "$APP/PlugIns/NotificationService.appex" ]] \
  || { echo "The archive has no notification service extension: run with --prebuild" >&2; exit 1; }
codesign -f -s - --entitlements ios/NotificationService/NotificationService.entitlements "$APP/PlugIns/NotificationService.appex"
codesign -f -s - --entitlements ios/Apollo/Apollo.entitlements "$APP"
codesign -d --entitlements - "$APP" 2>/dev/null | grep -q aps-environment \
  || { echo "The archive has no push entitlement: check ios/Apollo/Apollo.entitlements" >&2; exit 1; }

if [[ -n "${APOLLO_PROFILE_APP:-}" || -n "${APOLLO_PROFILE_NSE:-}" ]]; then
  [[ -n "${APOLLO_PROFILE_APP:-}" && -n "${APOLLO_PROFILE_NSE:-}" ]] \
    || { echo "Manual signing needs both APOLLO_PROFILE_APP and APOLLO_PROFILE_NSE" >&2; exit 1; }
  BUNDLE_ID="$(node -p 'require("./app.json").expo.ios.bundleIdentifier')"
  SIGNING="<key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>Apple Distribution</string>
  <key>provisioningProfiles</key><dict>
    <key>$BUNDLE_ID</key><string>$APOLLO_PROFILE_APP</string>
    <key>$BUNDLE_ID.NotificationService</key><string>$APOLLO_PROFILE_NSE</string>
  </dict>"
else
  SIGNING="<key>signingStyle</key><string>automatic</string>"
fi

cat > "$OUT/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>$TEAM</string>
  $SIGNING
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict></plist>
PLIST

echo "▸ Uploading (with $([[ ${#AUTH[@]} -gt 0 ]] && echo "the App Store Connect API key" || echo "the Xcode account"))"
xcodebuild -exportArchive -archivePath "$OUT/Apollo.xcarchive" -exportOptionsPlist "$OUT/ExportOptions.plist" \
  -exportPath "$OUT/export" -allowProvisioningUpdates ${AUTH[@]+"${AUTH[@]}"} 2>&1 | grep -E "Uploaded|EXPORT|error:" | grep -v "Upload Symbols"
rm -rf "$OUT"
echo "✓ Build $BUILD uploaded. TestFlight shows it after Apple processes it (usually 10–30 minutes)."
