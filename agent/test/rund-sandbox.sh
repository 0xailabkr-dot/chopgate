#!/bin/sh
# Run D against a local near-sandbox. Deletes .sandbox-tmp when the runner finishes.
# Sandbox has no transaction index, so the first pay of each case is refused locally
# with freeze_risk_not_sent because the freeze state is unknown. RUND_CONFIRM_FREEZE=1
# is the operator's explicit confirmation of that unknown state. The runner still
# refuses to confirm a "next block would freeze" result, and without this variable
# a freeze_risk_not_sent is a recorded stop.
set -eu
cd "$(dirname "$0")/.."
export CHOPGATE_NETWORK=sandbox
export RUND_STATE="${RUND_STATE:-./logs/rund-sandbox-state.json}"
export RUND_CONFIRM_FREEZE=1
exec node scripts/rund.mjs
