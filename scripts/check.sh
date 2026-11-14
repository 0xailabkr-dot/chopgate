#!/usr/bin/env bash
set -euo pipefail
SECONDS=0
# Prerequisites: fail immediately with one diagnostic line.
missing() { printf 'CHECK: missing prerequisite: %s - install: %s\n' "$1" "$2" >&2; exit 1; }
command -v node >/dev/null 2>&1 || missing node 'install Node.js 24'
for tool in cargo rustc; do
    command -v "$tool" >/dev/null 2>&1 || missing "$tool" 'rustup toolchain install 1.86.0 --profile minimal'
done
version=$(rustc --version 2>/dev/null) || missing 'rustc >= 1.86.0' 'rustup toolchain install 1.86.0 --profile minimal'
if [[ "$version" =~ ^rustc\ ([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
    (( BASH_REMATCH[1] > 1 || (BASH_REMATCH[1] == 1 && BASH_REMATCH[2] >= 86) )) || missing 'rustc >= 1.86.0' 'rustup toolchain install 1.86.0 --profile minimal'
else
    missing 'rustc >= 1.86.0' 'rustup toolchain install 1.86.0 --profile minimal'
fi
command -v cargo-near >/dev/null 2>&1 || missing cargo-near 'cargo install cargo-near --version 0.20.3 --locked'
target_libdir=$(rustc --print target-libdir --target wasm32-unknown-unknown 2>/dev/null) || target_libdir=
target_installed=0
if [[ -n "$target_libdir" && -d "$target_libdir" ]]; then
    for target_file in "$target_libdir"/*; do
        if [[ -f "$target_file" ]]; then target_installed=1; break; fi
    done
fi
[[ "$target_installed" == 1 ]] || missing wasm32-unknown-unknown 'rustup target add wasm32-unknown-unknown'
if [[ ${NEAR_SANDBOX_BIN_PATH+x} ]]; then
    sandbox_bin=$NEAR_SANDBOX_BIN_PATH
else
    sandbox_bin="$HOME/.near/near-sandbox-2.13.4/near-sandbox"
fi
[[ -f "$sandbox_bin" && -x "$sandbox_bin" ]] || missing near-sandbox 'download https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Linux-x86_64/2.13.4/near-sandbox.tar.gz (macOS: Darwin-arm64), unpack it so the executable is at $HOME/.near/near-sandbox-2.13.4/near-sandbox, or set NEAR_SANDBOX_BIN_PATH to that executable'
if [[ ${CHOPGATE_PREREQ_ONLY:-0} == 1 ]]; then
    echo 'CHECK: prerequisites OK'
    exit 0
fi
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
# Resolve the nearest existing ancestor without creating the target directory.
if [[ -r /proc/self/mountinfo ]]; then
    target_dir=${CARGO_TARGET_DIR:-./target}
    while [[ ! -d "$target_dir" ]]; do
        target_dir=${target_dir%/}
        case "$target_dir" in
            */*) parent_dir=${target_dir%/*}; target_dir=${parent_dir:-${target_dir:0:1}} ;;
            *) target_dir=. ;;
        esac
    done
    target_dir=$(cd -- "$target_dir" && pwd -P)
    mount_options=$(awk -v path="$target_dir" '
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
    if [[ ",$mount_options," == *,noexec,* ]]; then
        echo "CHECK: cargo target directory is on a noexec mount; set CARGO_TARGET_DIR to an exec-capable disk" >&2
        exit 1
    fi
else
    echo "WARNING: cannot read mountinfo; cargo target noexec check skipped" >&2
fi
if [[ "${CHOPGATE_NOEXEC_TEST:-0}" != 1 ]]; then
    bash scripts/test-noexec.sh
fi
bash scripts/test-prereqs.sh
echo "CHECK: unit tests"
cargo test --lib --locked
echo "CHECK: tests (includes attack suite A regressions)"
cargo test --tests --locked
echo "CHECK: demo"
demo_output=$(cargo run --locked --example demo)
printf '%s\n' "$demo_output"
demo_pattern="DEMO RESULT: ([0-9]+)/([0-9]+) steps as expected"
[[ "$demo_output" =~ $demo_pattern ]]
[[ "${BASH_REMATCH[1]}" == "${BASH_REMATCH[2]}" ]]
(( 10#${BASH_REMATCH[1]} >= 8 ))
agent_output=$(cargo run --locked --example agent_loop)
printf '%s\n' "$agent_output"
[[ "$agent_output" == *"AGENT LOOP RESULT: PASS"* ]]
economy_output=$(cargo run --locked --example agent_economy)
printf '%s\n' "$economy_output"
[[ "$economy_output" == *"AGENT ECONOMY RESULT: PASS"* ]]
attack_pattern='METRICS attacks_blocked=([0-9]+)/([0-9]+)'
[[ "$economy_output" =~ $attack_pattern ]]
[[ "${BASH_REMATCH[1]}" == "${BASH_REMATCH[2]}" ]]
(( 10#${BASH_REMATCH[2]} >= 4 ))
normal_pattern='METRICS false_blocks_on_normal=([0-9]+)/([0-9]+)'
[[ "$economy_output" =~ $normal_pattern ]]
(( 10#${BASH_REMATCH[1]} == 0 && 10#${BASH_REMATCH[2]} >= 2 ))
# Human approvals count only the normal owner flow.
[[ "$economy_output" =~ (^|$'\n')METRICS\ human_approvals=1($|$'\n') ]]
node --test --test-isolation=none webapp/test/logic.test.mjs
echo "CHECK: ui tests OK"
# Static check of docs/. No network.
# Prefix needles are two pieces so this file does not contain them whole.
NEEDLE_HOME='/ho''me/'
NEEDLE_WORKSPACE='/work''space/'
NEEDLE_ROOT='/ro''ot/'
docs_static_fail() { printf 'CHECK: docs static: %s\n' "$1" >&2; exit 1; }
docs_text_forbidden() {
    local file=$1 status=0
    LC_ALL=C grep -F -q \
        -e 'private_key' \
        -e 'secret_key' \
        -e 'seed_phrase' \
        -e 'BEGIN PRIVATE KEY' \
        -e "$NEEDLE_HOME" \
        -e "$NEEDLE_WORKSPACE" \
        -e "$NEEDLE_ROOT" \
        -- "$file" || status=$?
    if [[ $status -eq 0 ]]; then
        return 0
    fi
    if [[ $status -gt 1 ]]; then
        docs_static_fail "scan failed: $file"
    fi
    status=0
    LC_ALL=C grep -E -q -- 'ed25519:[1-9A-HJ-NP-Za-km-z]{80,}' "$file" || status=$?
    if [[ $status -eq 0 ]]; then
        return 0
    fi
    if [[ $status -gt 1 ]]; then
        docs_static_fail "scan failed: $file"
    fi
    return 1
}
for docs_file in \
    docs/index.html \
    docs/app.js \
    docs/style.css \
    docs/.nojekyll \
    docs/i18n/en.json \
    docs/i18n/ko.json \
    docs/data/scene-txs.json \
    docs/receipt-viewer.html \
    docs/favicon.svg \
    docs/chopgate-demo-b.mp4 \
    docs/chopgate-demo-b.en.vtt \
    docs/chopgate-demo-b.en.srt \
    docs/fonts/NOTICE.txt \
    docs/fonts/OFL.txt
do
    [[ -f "$docs_file" ]] || docs_static_fail "missing file: $docs_file"
done
if ! node --check docs/app.js >/dev/null 2>&1; then
    docs_static_fail "node --check failed: docs/app.js"
fi
docs_json_count=0
while IFS= read -r -d '' docs_json; do
    docs_json_count=$((docs_json_count + 1))
    if ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$docs_json" >/dev/null 2>&1; then
        docs_static_fail "invalid JSON: $docs_json"
    fi
done < <(find docs -type f -name '*.json' -print0)
[[ "$docs_json_count" -gt 0 ]] || docs_static_fail "no JSON files under docs/"
if ! i18n_key_report=$(node -e '
const fs = require("fs");
function keys(path) {
  return Object.keys(JSON.parse(fs.readFileSync(path, "utf8")));
}
const en = keys("docs/i18n/en.json");
const ko = keys("docs/i18n/ko.json");
const enSet = new Set(en);
const koSet = new Set(ko);
const missingFromKo = en.filter(function (key) { return !koSet.has(key); });
const missingFromEn = ko.filter(function (key) { return !enSet.has(key); });
const lines = [];
if (missingFromKo.length) lines.push("missing from docs/i18n/ko.json: " + missingFromKo.join(", "));
if (missingFromEn.length) lines.push("missing from docs/i18n/en.json: " + missingFromEn.join(", "));
if (lines.length) {
  process.stdout.write(lines.join("; "));
  process.exit(1);
}
'); then
    docs_static_fail "i18n keys differ: ${i18n_key_report}"
fi
docs_text_count=0
while IFS= read -r -d '' docs_text; do
    docs_text_count=$((docs_text_count + 1))
    if docs_text_forbidden "$docs_text"; then
        docs_static_fail "forbidden string: $docs_text"
    fi
done < <(find docs -type f \( \
    -name '*.html' -o -name '*.js' -o -name '*.css' -o -name '*.json' \
    -o -name '*.md' -o -name '*.vtt' -o -name '*.srt' -o -name '*.txt' \
\) -print0)
[[ "$docs_text_count" -gt 0 ]] || docs_static_fail "no text files under docs/"
echo "CHECK: docs static OK"
# Whole-repository text scan for machine-local absolute directory prefixes.
# Skip binary files, any target directory, and this script (its needles are split).
repo_prefix_fail() { printf 'CHECK: repo prefix: %s\n' "$1" >&2; exit 1; }
repo_file_is_binary() {
    local file=$1 status=0
    LC_ALL=C grep -q $'\0' -- "$file" 2>/dev/null || status=$?
    if [[ $status -eq 0 ]]; then
        return 0
    fi
    if [[ $status -gt 1 ]]; then
        repo_prefix_fail "scan failed: $file"
    fi
    return 1
}
repo_file_has_prefix() {
    local file=$1 status=0
    LC_ALL=C grep -I -F -q \
        -e "$NEEDLE_HOME" \
        -e "$NEEDLE_WORKSPACE" \
        -e "$NEEDLE_ROOT" \
        -- "$file" || status=$?
    if [[ $status -eq 0 ]]; then
        return 0
    fi
    if [[ $status -gt 1 ]]; then
        repo_prefix_fail "scan failed: $file"
    fi
    return 1
}
while IFS= read -r -d '' repo_file; do
    if [[ "$repo_file" -ef "${BASH_SOURCE[0]}" ]]; then
        continue
    fi
    if repo_file_is_binary "$repo_file"; then
        continue
    fi
    if repo_file_has_prefix "$repo_file"; then
        repo_prefix_fail "forbidden prefix: $repo_file"
    fi
done < <(find . -type d -name target -prune -o -type f -print0)
echo "CHECK: repo prefixes OK"
echo "CHECK: elapsed ${SECONDS}s"
echo "CHECK: ALL OK"
