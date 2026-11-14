#!/bin/bash
# Build chopgate_factory.wasm offline. Sources env.sh (sandbox path, cargo home, no secrets).
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091
source ./env.sh

# GNU df -BG on the current directory's filesystem. Stop below 4G free.
free_g="$(df -BG . | awk 'NR==2 { gsub(/G/, "", $4); print $4 }')"
if [ "${free_g}" -lt 4 ]; then
  echo "STOP: free ${free_g}G is below 4G"
  df -BG .
  exit 1
fi

# Plain cargo wasm (release, locked, offline). Sandbox protocol enables
# reference-types and bulk-memory, so mvp flags are only a fallback.
if ! cargo build --offline --locked --release --target wasm32-unknown-unknown --lib; then
  echo "plain cargo wasm build failed; retrying with target-cpu=mvp"
  RUSTFLAGS="-C link-arg=-s -C target-cpu=mvp" \
    cargo build --offline --locked --release --target wasm32-unknown-unknown --lib
  echo "NOTE: mvp RUSTFLAGS build succeeded"
fi

src="${CARGO_TARGET_DIR:-./target}/wasm32-unknown-unknown/release/chopgate_factory.wasm"
mkdir -p out
cp "${src}" out/chopgate_factory.wasm
bytes="$(wc -c < out/chopgate_factory.wasm | tr -d ' ')"
hash="$(sha256sum out/chopgate_factory.wasm | awk '{print $1}')"
echo "bytes=${bytes}"
echo "sha256=${hash}"
echo "path=out/chopgate_factory.wasm"
