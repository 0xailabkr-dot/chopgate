#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/chopgate-noexec.XXXXXX")
test_dir=$(cd -- "$test_dir" && pwd -P)
mount_options=
if [[ -r /proc/self/mountinfo ]]; then
    mount_options=$(awk -v path="$test_dir" '
        function decode(s) {
            gsub(/\\040/, " ", s); gsub(/\\011/, "\t", s)
            gsub(/\\012/, "\n", s); gsub(/\\134/, sprintf("%c", 92), s)
            return s
        }
        { mount = decode($5)
          if ((mount == substr(path, 1, 1) || path == mount || index(path, mount "/") == 1) && length(mount) >= best) {
              best = length(mount); options = $6
          }
        }
        END { print options }
    ' /proc/self/mountinfo)
fi
if [[ ",$mount_options," != *,noexec,* ]]; then
    echo "NOEXEC-TEST: SKIP (no noexec mount found)"
    exit 0
fi
message="CHECK: cargo target directory is on a noexec mount; set CARGO_TARGET_DIR to an exec-capable disk"
if output=$(CARGO_TARGET_DIR="$test_dir/chopgate-noexec-probe" CHOPGATE_NOEXEC_TEST=1 bash scripts/check.sh 2>&1); then
    echo "NOEXEC-TEST: FAIL (check unexpectedly succeeded)" >&2
    exit 1
fi
if [[ "$output" != *"$message"* ]]; then
    echo "NOEXEC-TEST: FAIL (expected preflight message missing)" >&2
    exit 1
fi
echo "NOEXEC-TEST: OK"
