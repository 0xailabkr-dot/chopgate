#!/bin/bash
# Offline funding check for a factory deploy. No network.
# Usage: bash deploy.sh <factory_fund_yocto>
# The fund is the balance the factory account will hold when the wasm is deployed.
# Free float is fund minus the factory code stake (wasm bytes * 10^19) minus
# 0.001 NEAR of state slack. It must be at least one required_deposit
# (about 6 NEAR): (gate wasm bytes + 2500) * 10^19 + 0.1 NEAR.
set -euo pipefail
cd "$(dirname "$0")"
fund="${1:-}"
if [ -z "${fund}" ]; then
  echo "usage: bash deploy.sh <factory_fund_yocto>"
  exit 2
fi
factory_wasm="out/chopgate_factory.wasm"
gate_wasm="res/chopgate.wasm"
if [ ! -f "${factory_wasm}" ]; then
  echo "STOP: missing ${factory_wasm}; run build.sh first"
  exit 1
fi
fw="$(wc -c < "${factory_wasm}" | tr -d ' ')"
gw="$(wc -c < "${gate_wasm}" | tr -d ' ')"
python3 - "${fund}" "${fw}" "${gw}" << 'PY'
import sys
fund = int(sys.argv[1])
fw = int(sys.argv[2])
gw = int(sys.argv[3])
byte = 10**19
required = (gw + 2500) * byte + 10**23
stake = fw * byte + 10**21
free = fund - stake
print(f"required_deposit_yocto={required}")
print(f"estimated_factory_stake_yocto={stake}")
print(f"estimated_free_float_yocto={free}")
if free < required:
    print("STOP: free float is below one required_deposit (about 6 NEAR)")
    sys.exit(1)
print("OK: free float covers one required_deposit")
PY
