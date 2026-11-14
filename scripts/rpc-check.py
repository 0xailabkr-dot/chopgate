#!/usr/bin/env python3
"""Read-only public NEAR testnet checks; no keys or transaction submission."""
import argparse
import base64
import csv
import hashlib
import json
from pathlib import Path
import sys
import urllib.error
import urllib.request

RPC = "https://rpc.testnet.near.org"


def rpc(method, params):
    payload = json.dumps({"jsonrpc": "2.0", "id": 1,
                          "method": method, "params": params}).encode()
    request = urllib.request.Request(
        RPC, data=payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        body = json.load(response)
    if "error" in body:
        raise ValueError(json.dumps(body["error"], ensure_ascii=False))
    return body["result"]


def transactions(path):
    """Read the documented Markdown table or a two-column TSV."""
    content = path.read_text(encoding="utf-8")
    rows = []
    if path.suffix.lower() == ".md":
        columns = None
        for line in content.splitlines():
            if not line.startswith("|"):
                columns = None
                continue
            cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
            if "Transaction hash" in cells and "Signer" in cells:
                columns = (cells.index("Transaction hash"), cells.index("Signer"))
                continue
            if columns is None or all(set(cell) <= set("-: ") for cell in cells):
                continue
            if len(cells) <= max(columns):
                raise ValueError("Incomplete Markdown transaction row")
            rows.append((cells[columns[0]], cells[columns[1]]))
    else:
        for cells in csv.reader(content.splitlines(), delimiter="\t"):
            if not cells or not any(cell.strip() for cell in cells):
                continue
            if cells[0].strip().lower() in {"tx_hash", "hash", "transaction hash"}:
                continue
            if len(cells) != 2:
                raise ValueError("TSV rows must contain transaction hash and signer")
            rows.append(tuple(cell.strip() for cell in cells))
    if not rows:
        raise ValueError("No transaction rows found")
    if any(not tx_hash or not signer for tx_hash, signer in rows):
        raise ValueError("Transaction hash and signer must be nonempty")
    return rows


def reason_code(status):
    """Decode a JSON SuccessValue, returning '-' when no reason code exists."""
    if "SuccessValue" not in status:
        return "-"
    try:
        value = json.loads(base64.b64decode(status["SuccessValue"], validate=True))
    except (ValueError, UnicodeError, TypeError):
        return "-"
    if isinstance(value, dict) and isinstance(value.get("reason_code"), str):
        return value["reason_code"]
    return "-"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, nargs="?",
                        default=Path(__file__).resolve().parents[1] / "docs/TESTNET-RPC-CHECK.md",
                        help="Markdown evidence file or two-column TSV")
    parser.add_argument("--view-code", metavar="ACCOUNT",
                        help="also query deployed code at final finality")
    args = parser.parse_args()
    try:
        rows = transactions(args.input)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    failed = False
    print("hash | final status | outcome | reason_code")
    for tx_hash, signer in rows:
        try:
            result = rpc("tx", {"tx_hash": tx_hash,
                                "sender_account_id": signer, "wait_until": "FINAL"})
            status = result["status"]
            outcome = ("SuccessValue" if "SuccessValue" in status else
                       "Failure" if "Failure" in status else json.dumps(status))
            print(f"{tx_hash} | {result['final_execution_status']} | {outcome} | {reason_code(status)}")
        except (OSError, ValueError, KeyError, TypeError) as error:
            failed = True
            print(f"{tx_hash} | RPC_ERROR | {str(error).replace(chr(10), ' ')}")
    if args.view_code:
        try:
            result = rpc("query", {"request_type": "view_code", "finality": "final",
                                   "account_id": args.view_code})
            code = base64.b64decode(result["code_base64"], validate=True)
            print(f"VIEW_CODE {args.view_code} bytes {len(code)} "
                  f"sha256 {hashlib.sha256(code).hexdigest()} code_hash {result['hash']}")
        except (OSError, ValueError, KeyError, TypeError) as error:
            failed = True
            print(f"VIEW_CODE {args.view_code} | RPC_ERROR | {error}", file=sys.stderr)
    return int(failed)


if __name__ == "__main__":
    sys.exit(main())
