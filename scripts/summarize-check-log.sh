#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 1 || ! -f "$1" || ! -r "$1" ]]; then
    echo 'Measured summary: missing or unreadable check log' >&2
    exit 1
fi
if ! grep -q '^CHECK: ALL OK$' -- "$1"; then
    echo 'Measured summary: check log lacks CHECK: ALL OK' >&2
    exit 1
fi
awk '
BEGIN { print "## Measured summary"; print ""; print "```text" }
/^[[:space:]]*Running[[:space:]]/ { target=$0; next }
/^test result:/ { if (target != "") { print target; print; target="" }; next }
/^SCENE / || /^AGENT ECONOMY RESULT:/ || /^METRICS / || /^DEMO RESULT:/ || /JUDGMENT TIME/ || /^AGENT LOOP RESULT:/ || /^ℹ (tests|pass|fail)[[:space:]]/ || /^CHECK: elapsed / || /^CHECK: ALL OK$/ { print }
END { print "```" }
' "$1"
