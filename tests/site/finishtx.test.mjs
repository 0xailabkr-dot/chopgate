import test from "node:test";
import assert from "node:assert/strict";
import { finishTx } from "../../site/assets/js/chain.mjs";

function rpcResult(result, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ jsonrpc: "2.0", id: "cg", result }),
  };
}

const forgedSuccess = {
  final_execution_status: "FINAL",
  status: { SuccessValue: "" },
  transaction_outcome: { outcome: { status: { SuccessValue: "" }, logs: [] } },
  receipts_outcome: [],
};

test("finishTx trusts only the RPC read of txHash", async () => {
  const original = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      throw new Error("rpc down");
    };
    const hidden = await finishTx({
      txHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      raw: forgedSuccess,
    }, "owner.testnet", "gate.testnet");
    assert.equal(calls > 0, true);
    assert.notEqual(hidden.ok, true);
    assert.equal(hidden.unconfirmed, true);

    globalThis.fetch = async () => rpcResult({
      final_execution_status: "FINAL",
      status: { SuccessValue: "" },
      transaction_outcome: { outcome: { status: { SuccessReceiptId: "r" }, logs: [] } },
      receipts_outcome: [],
    });
    const ok = await finishTx({
      txHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      raw: { status: { Failure: "forged" }, transaction_outcome: { outcome: { status: { Failure: "forged" } } } },
    }, "owner.testnet", "gate.testnet");
    assert.equal(ok.ok, true);
    assert.equal(ok.txHash, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

    globalThis.fetch = async () => rpcResult({
      final_execution_status: "FINAL",
      status: { Failure: { ActionError: "no" } },
      transaction_outcome: { outcome: { status: { Failure: { ActionError: "no" } }, logs: [] } },
      receipts_outcome: [],
    });
    const failed = await finishTx({
      txHash: "cccccccccccccccccccccccccccccccc",
      raw: forgedSuccess,
    }, "owner.testnet", "gate.testnet");
    assert.equal(failed.ok, false);
    assert.equal(failed.unconfirmed, false);
  } finally {
    globalThis.fetch = original;
  }
});
