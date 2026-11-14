import test from "node:test";
import assert from "node:assert/strict";
import { eventsFromStatus, isU64, maxWithdrawNonce } from "../../site/assets/js/events.mjs";

const GATE = "g69d4c038440a403cc5ca.cg-u1f-fdf59d31.testnet";
const ATTACKER = "attacker.testnet";

test("eventsFromStatus keeps only gate chopgate logs with a u64 nonce", () => {
  const attackerWithdraw = 'EVENT_JSON:{"standard":"chopgate","version":"1.0.0","event":"escrow_withdraw","data":[{"nonce":18446744073709551615}]}';
  const attackerPaid = 'EVENT_JSON:{"standard":"chopgate","version":"1.0.0","event":"payout_settled","data":[{"amount":"1","target":"attacker.testnet"}]}';
  const realWithdraw = 'EVENT_JSON:{"standard":"chopgate","version":"1.0.0","event":"escrow_withdraw","data":[{"nonce":3}]}';
  const otherStandard = 'EVENT_JSON:{"standard":"other","version":"1.0.0","event":"escrow_withdraw","data":[{"nonce":1}]}';
  const overU64 = 'EVENT_JSON:{"standard":"chopgate","version":"1.0.0","event":"escrow_withdraw","data":[{"nonce":"18446744073709551616"}]}';
  const status = {
    transaction_outcome: {
      outcome: {
        executor_id: ATTACKER,
        logs: [attackerWithdraw, attackerPaid],
      },
    },
    receipts_outcome: [
      { outcome: { executor_id: ATTACKER, logs: [attackerWithdraw, attackerPaid] } },
      { outcome: { executor_id: GATE, logs: [realWithdraw, otherStandard, overU64] } },
    ],
  };
  const events = eventsFromStatus(status, GATE);
  assert.deepEqual(events.map((item) => item.event), ["escrow_withdraw"]);
  assert.equal(String(events[0].data.nonce), "3");
  assert.equal(events.some((item) => item.event === "payout_settled"), false);
  assert.equal(events.some((item) => String(item.data?.nonce) === "18446744073709551616"), false);
  assert.equal(events.some((item) => String(item.data?.nonce) === "18446744073709551615"), false);
  assert.equal(maxWithdrawNonce([{ events }]), 3n);
  assert.equal(maxWithdrawNonce([{
    events: [{ event: "escrow_withdraw", data: { nonce: "18446744073709551616" } }],
  }]), 0n);
  assert.equal(isU64("18446744073709551615"), true);
  assert.equal(isU64("18446744073709551616"), false);
});
