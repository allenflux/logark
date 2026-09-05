#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! rustup target list --installed | grep -qx wasm32-unknown-unknown; then
  echo 'Missing Rust WebAssembly target. Install with: rustup target add wasm32-unknown-unknown' >&2
  exit 1
fi

# No third-party crates; the module can be rebuilt without registry access.
CARGO_TARGET_DIR="$PROJECT_ROOT/analytics-wasm/target" cargo build \
  --manifest-path "$PROJECT_ROOT/analytics-wasm/Cargo.toml" \
  --target wasm32-unknown-unknown --release --locked --offline
cp "$PROJECT_ROOT/analytics-wasm/target/wasm32-unknown-unknown/release/logark_analytics.wasm" \
  "$PROJECT_ROOT/static/analytics.wasm"
echo "Built static/analytics.wasm"
