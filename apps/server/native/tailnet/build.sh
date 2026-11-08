#!/usr/bin/env bash
# Builds Apollo's desktop tailnet addon on macOS: the Go tsnet node (tailnet.go) as a static
# C archive, linked into the Rust Node-API crate (addon/) as build/apollo_tailnet.node.
# Node-API is ABI-stable, so the same file loads in Node and in Electron's Node.
# Windows: build.ps1.
#
#   bash apps/server/native/tailnet/build.sh
#
# Needs Go (>= the version in go.mod), Rust (cargo) and Xcode's command line tools. Builds
# for this machine's architecture (APOLLO_TAILNET_ARCH=arm64|amd64 to choose).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/build"
GO="${GO:-$(command -v go || echo /opt/homebrew/bin/go)}"
[[ -x "$GO" ]] || { echo "Go is not installed (brew install go)" >&2; exit 1; }

case "${APOLLO_TAILNET_ARCH:-$(uname -m)}" in
  arm64 | aarch64) GOARCH=arm64; CLANG_ARCH=arm64; RUST_TARGET=aarch64-apple-darwin ;;
  x86_64 | amd64) GOARCH=amd64; CLANG_ARCH=x86_64; RUST_TARGET=x86_64-apple-darwin ;;
  *) echo "unsupported architecture" >&2; exit 1 ;;
esac

CARGO="${CARGO:-$(command -v cargo || echo "$HOME/.cargo/bin/cargo")}"
[[ -x "$CARGO" ]] || { echo "Rust is not installed (https://rustup.rs)" >&2; exit 1; }

mkdir -p "$OUT"
echo "▸ Go c-archive ($GOARCH)"
(
  cd "$HERE"
  GOOS=darwin GOARCH="$GOARCH" CGO_ENABLED=1 MACOSX_DEPLOYMENT_TARGET=13.0 \
    CC="xcrun clang -arch $CLANG_ARCH" \
    "$GO" build -trimpath -buildmode=c-archive -ldflags "-s -w" -o "$OUT/libapollotailnet.a" .
)

echo "▸ Node-API addon (Rust, $RUST_TARGET)"
APOLLO_TAILNET_LIB_DIR="$OUT" MACOSX_DEPLOYMENT_TARGET=13.0 \
  "$CARGO" build --release --manifest-path "$HERE/addon/Cargo.toml" --target "$RUST_TARGET" --target-dir "$OUT/cargo"
cp "$OUT/cargo/$RUST_TARGET/release/libapollo_tailnet.dylib" "$OUT/apollo_tailnet.node"
rm -f "$OUT/libapollotailnet.a" "$OUT/libapollotailnet.h"
echo "✓ $OUT/apollo_tailnet.node ($(du -h "$OUT/apollo_tailnet.node" | cut -f1))"
