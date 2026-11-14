#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
output=$(CHOPGATE_PREREQ_ONLY=1 bash scripts/check.sh)
[[ "$output" == 'CHECK: prerequisites OK' ]]
if output=$(NEAR_SANDBOX_BIN_PATH=/nonexistent/near-sandbox CHOPGATE_PREREQ_ONLY=1 bash scripts/check.sh 2>&1 >/dev/null); then exit 1; fi
[[ "$output" != *$'\n'* && "$output" == *'missing prerequisite: near-sandbox'* ]]
# Node is required before any Rust or sandbox work.
if output=$(bash -c 'command() { if [[ "$1" == "-v" && "$2" == "node" ]]; then return 1; fi; builtin command "$@"; }; source scripts/check.sh' 2>&1); then exit 1; fi
[[ "$output" != *$'\n'* && "$output" == *'missing prerequisite: node'* ]]
# Hide only cargo-near so Node remains discoverable on its normal path.
if output=$(bash -c 'command() { if [[ "$1" == "-v" && "$2" == "cargo-near" ]]; then return 1; fi; builtin command "$@"; }; source scripts/check.sh' 2>&1); then exit 1; fi
[[ "$output" != *$'\n'* && "$output" == *'missing prerequisite: cargo-near'* ]]
echo 'PREREQ-TEST: OK'
