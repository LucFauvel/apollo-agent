#!/usr/bin/env bash
# Builds the Go tsnet bridge (../go) as a static C archive for iOS devices (arm64) and
# the simulator (arm64 + x86_64, which Release simulator builds also link) and packs
# them into ios/ApolloTailnet.xcframework.
#
#   bash modules/apollo-tailnet/scripts/build-go.sh
#
# Needs Go (>= the version in go/go.mod) and Xcode. The output is gitignored.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
GO_DIR="$HERE/go"
OUT="$HERE/ios/ApolloTailnet.xcframework"
MIN_IOS="${APOLLO_TAILNET_MIN_IOS:-16.4}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

GO="${GO:-$(command -v go || echo /opt/homebrew/bin/go)}"
[[ -x "$GO" ]] || { echo "Go is not installed (brew install go)" >&2; exit 1; }

build_slice() { # <name> <sdk> <GOARCH> <clang target>
  local name="$1" sdk="$2" goarch="$3" target="$4"
  local sysroot clang
  sysroot="$(xcrun --sdk "$sdk" --show-sdk-path)"
  clang="$(xcrun --sdk "$sdk" --find clang)"
  mkdir -p "$WORK/$name"
  echo "▸ Go c-archive for $name"
  (
    cd "$GO_DIR"
    GOOS=ios GOARCH="$goarch" CGO_ENABLED=1 \
      CC="$clang -isysroot $sysroot -target $target" \
      CGO_CFLAGS="-isysroot $sysroot -target $target -fembed-bitcode=off" \
      CGO_LDFLAGS="-isysroot $sysroot -target $target" \
      "$GO" build -trimpath -buildmode=c-archive \
        -ldflags "-s -w" -o "$WORK/$name/libapollotailnet_go.a" .
  )
  # Headers go in their own dir with a module map so Swift can import them.
  mkdir -p "$WORK/$name/Headers"
  mv "$WORK/$name/libapollotailnet_go.h" "$WORK/$name/Headers/ApolloTailnetGo.h"
  cat > "$WORK/$name/Headers/module.modulemap" <<'MAP'
module ApolloTailnetGo {
  header "ApolloTailnetGo.h"
  export *
}
MAP
}

build_slice device iphoneos arm64 "arm64-apple-ios$MIN_IOS"
build_slice sim-arm64 iphonesimulator arm64 "arm64-apple-ios$MIN_IOS-simulator"
build_slice sim-x86_64 iphonesimulator amd64 "x86_64-apple-ios$MIN_IOS-simulator"

# The podspec compiles Swift against the device slice's header for every slice.
for other in sim-arm64 sim-x86_64; do
  cmp -s "$WORK/device/Headers/ApolloTailnetGo.h" "$WORK/$other/Headers/ApolloTailnetGo.h" \
    || { echo "device and $other headers differ" >&2; exit 1; }
done

mkdir -p "$WORK/sim"
lipo -create "$WORK/sim-arm64/libapollotailnet_go.a" "$WORK/sim-x86_64/libapollotailnet_go.a" \
  -output "$WORK/sim/libapollotailnet_go.a"

rm -rf "$OUT"
xcodebuild -create-xcframework \
  -library "$WORK/device/libapollotailnet_go.a" -headers "$WORK/device/Headers" \
  -library "$WORK/sim/libapollotailnet_go.a" -headers "$WORK/sim-arm64/Headers" \
  -output "$OUT" >/dev/null
for slice in ios-arm64 ios-arm64_x86_64-simulator; do
  [[ -f "$OUT/$slice/libapollotailnet_go.a" ]] || { echo "missing slice $slice" >&2; exit 1; }
done
echo "✓ $(du -sh "$OUT" | cut -f1) $OUT"
