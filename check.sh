#!/usr/bin/env bash
# One command to verify the project
# It ends with "CHECK: ALL OK". No API key and no network judge call are needed.
set -euo pipefail
cd "$(dirname "$0")"
exec bash scripts/check.sh "$@"
