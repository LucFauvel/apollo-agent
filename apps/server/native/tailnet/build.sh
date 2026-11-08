#!/usr/bin/env bash
# Builds Apollo's desktop tailnet addon: the Go tsnet node (tailnet.go) as a static C
# archive, linked with the Node-API shim (napi/addon.c) into build/apollo_tailnet.node.
# Node-API is ABI-stable, so the same file loads in Node and in Electron's Node.
#
#   bash apps/server/native/tailnet/build.sh
#
# Needs Go (>= the version in go.mod) and Xcode's command line tools. Builds for this
# machine's architecture (APOLLO_TAILNET_ARCH=arm64|amd64 to choose).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/build"
GO="${GO:-$(command -v go || echo /opt/homebrew/bin/go)}"
[[ -x "$GO" ]] || { echo "Go is not installed (brew install go)" >&2; exit 1; }

case "${APOLLO_TAILNET_ARCH:-$(uname -m)}" in
  arm64 | aarch64) GOARCH=arm64; CLANG_ARCH=arm64 ;;
  x86_64 | amd64) GOARCH=amd64; CLANG_ARCH=x86_64 ;;
  *) echo "unsupported architecture" >&2; exit 1 ;;
esac

# Node-API headers: from the Node running this script, or NODE_API_HEADERS.
HEADERS="${NODE_API_HEADERS:-$(node -p "require('path').resolve(process.execPath, '../../include/node')")}"
[[ -f "$HEADERS/node_api.h" ]] || { echo "node_api.h not found in $HEADERS (set NODE_API_HEADERS)" >&2; exit 1; }

mkdir -p "$OUT"
echo "▸ Go c-archive ($GOARCH)"
(
  cd "$HERE"
  GOOS=darwin GOARCH="$GOARCH" CGO_ENABLED=1 MACOSX_DEPLOYMENT_TARGET=13.0 \
    CC="xcrun clang -arch $CLANG_ARCH" \
    "$GO" build -trimpath -buildmode=c-archive -ldflags "-s -w" -o "$OUT/libapollotailnet.a" .
)

echo "▸ Node-API addon"
xcrun clang -arch "$CLANG_ARCH" -mmacosx-version-min=13.0 -O2 -shared \
  -undefined dynamic_lookup \
  -I "$HEADERS" -I "$OUT" \
  "$HERE/napi/addon.c" "$OUT/libapollotailnet.a" \
  -framework CoreFoundation -framework Security -framework SystemConfiguration -framework IOKit -lresolv \
  -o "$OUT/apollo_tailnet.node"
rm -f "$OUT/libapollotailnet.a" "$OUT/libapollotailnet.h"
echo "✓ $OUT/apollo_tailnet.node ($(du -h "$OUT/apollo_tailnet.node" | cut -f1))"
