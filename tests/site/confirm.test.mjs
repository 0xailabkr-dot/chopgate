import test from "node:test";
import assert from "node:assert/strict";
import {
  REREAD_MS, SILENT_MS, classifySendError, confirmHostPair, decideOutcome, depositLanded,
  hasFailure, isFinalOutcome, isLastReadIndex, lockView, partialRulesKey, probeErrorKind,
  readDue, rulesEqual, tier2Equal, toAttempt,
} from "../../site/assets/js/confirm.mjs";

const successBody = {
  final_execution_status: "FINAL",
  status: { SuccessValue: "" },
  transaction_outcome: { outcome: { status: { SuccessReceiptId: "r" }, logs: [] } },
  receipts_outcome: [],
};

const failureBody = {
  final_execution_status: "FINAL",
  status: { Failure: { ActionError: "no" } },
  receipts_outcome: [],
};

test("schedule is 5s, 15s, and 30s, then 2 minutes of silence", () => {
  assert.deepEqual(REREAD_MS, [5000, 15000, 30000]);
  assert.equal(SILENT_MS, 120000);
  assert.deepEqual(readDue(0), []);
  assert.deepEqual(readDue(4999), []);
  assert.deepEqual(readDue(5000), [0]);
  assert.deepEqual(readDue(15000), [0, 1]);
  assert.deepEqual(readDue(30000), [0, 1, 2]);
  assert.equal(isLastReadIndex(2), true);
  assert.equal(isLastReadIndex(1), false);
});

test("host pair uses rpc[1], or archival when rpc[1] is missing", () => {
  assert.deepEqual(
    confirmHostPair(["https://primary.example", "https://second.example"], ["https://archival.example"]),
    ["https://primary.example", "https://second.example"],
  );
  assert.deepEqual(
    confirmHostPair(["https://primary.example"], ["https://archival.example", "https://archival-b.example"]),
    ["https://primary.example", "https://archival.example"],
  );
});

test("outcome classification", () => {
  const failure = toAttempt({ result: failureBody });
  const success = toAttempt({ result: successBody });
  const miss = toAttempt({ miss: true, kind: "miss" });
  const unread = toAttempt({ answered: false, kind: "timeout" });
  assert.equal(failure.failure, true);
  assert.equal(success.success, true);
  assert.equal(hasFailure(failureBody), true);
  assert.equal(isFinalOutcome(successBody), true);
  assert.equal(isFinalOutcome({ status: { Unknown: "" } }), false);
  assert.equal(probeErrorKind({ kind: "miss", message: "UNKNOWN_TRANSACTION" }), "miss");
  assert.equal(probeErrorKind({ kind: "timeout", message: "timeout" }), "unread");

  assert.equal(decideOutcome({ attempts: [failure], effect: true, action: "deposit" }).outcome, "failed");
  assert.equal(decideOutcome({ attempts: [unread], effect: true, action: "create" }).outcome, "success");
  assert.equal(decideOutcome({ attempts: [success], effect: null, action: "deposit" }).outcome, "success");
  assert.equal(decideOutcome({ attempts: [success], effect: false, action: "rules" }).outcome, "success");
  assert.equal(decideOutcome({ attempts: [success], effect: null, action: "create", isScheduledLast: false }).outcome, "unconfirmed");
  assert.equal(decideOutcome({ attempts: [success], effect: null, action: "create", isScheduledLast: true }).outcome, "success");
  assert.equal(decideOutcome({ attempts: [unread], effect: null, action: "withdraw" }).outcome, "unconfirmed");
  assert.equal(decideOutcome({ attempts: [success], effect: true, action: "withdraw" }).via, "status");

  const earlyMiss = decideOutcome({ attempts: [miss, miss], effect: null, action: "deposit", isScheduledLast: false });
  assert.equal(earlyMiss.outcome, "unconfirmed");
  assert.equal(earlyMiss.locked, true);
  const lateMiss = decideOutcome({ attempts: [miss, miss], effect: null, action: "other", isScheduledLast: true });
  assert.equal(lateMiss.outcome, "absent");
  assert.equal(lateMiss.locked, false);
  const oneMiss = decideOutcome({ attempts: [miss, unread], effect: null, action: "other", isScheduledLast: true });
  assert.equal(oneMiss.outcome, "unconfirmed");
  assert.equal(oneMiss.anyAnswered, true);
  const silent = decideOutcome({ attempts: [unread, unread], effect: null, action: "other", isScheduledLast: true });
  assert.equal(silent.anyAnswered, false);
  assert.equal(silent.outcome, "unconfirmed");
});

test("lock stays until success, failure, absence, or the explorer override", () => {
  assert.deepEqual(lockView({ outcome: "unconfirmed", elapsedMs: 119999, anyRpcAnswered: false }), { locked: true, offerOverride: false });
  assert.deepEqual(lockView({ outcome: "unconfirmed", elapsedMs: 120000, anyRpcAnswered: false }), { locked: true, offerOverride: true });
  assert.deepEqual(lockView({ outcome: "unconfirmed", elapsedMs: 120000, anyRpcAnswered: true }), { locked: true, offerOverride: false });
  assert.deepEqual(lockView({ outcome: "success", elapsedMs: 0 }), { locked: false, offerOverride: false });
  assert.deepEqual(lockView({ outcome: "failed", elapsedMs: 999999, anyRpcAnswered: false }), { locked: false, offerOverride: false });
  assert.deepEqual(lockView({ outcome: "absent" }), { locked: false, offerOverride: false });
  assert.deepEqual(lockView({ outcome: "unconfirmed", elapsedMs: 120000, anyRpcAnswered: false, overrideUsed: true }), { locked: false, offerOverride: false });
});

test("deposit, rules, and tier-2 views", () => {
  assert.equal(depositLanded("10", "5", "15"), true);
  assert.equal(depositLanded("10", "5", "14"), false);
  assert.equal(depositLanded(null, "5", "15"), null);
  const sent = {
    rules_nonce: "2",
    enabled: true,
    per_tx_limit: "5",
    per_day_limit: "9",
    max_tx_per_day: 3,
    tz_offset_min: 540,
    window_start_min: 0,
    window_end_min: 60,
    jev_threshold_permille: 900,
    jev_required: false,
    allowed_categories: ["a"],
    payees: [{ alias: "p", account: "pay.testnet" }],
  };
  assert.equal(rulesEqual({ ...sent, rules_nonce: 2, per_tx_limit: { value: "5" } }, sent), true);
  assert.equal(rulesEqual({ ...sent, rules_nonce: 1 }, sent), false);
  const tier = {
    config_nonce: "4",
    amount_threshold: "7",
    pending_ttl_ns: "11",
    new_payee_check: true,
    trusted_sources: ["owner_signed"],
    known_payees: [],
    denied_targets: [],
  };
  assert.equal(tier2Equal({ ...tier, config_nonce: 4, amount_threshold: { value: "7" } }, tier), true);
  assert.equal(tier2Equal({ ...tier, amount_threshold: "8" }, tier), false);
});

test("send errors and the second rules message", () => {
  assert.equal(classifySendError({ message: "closed" }, true).outcome, "cancelled");
  assert.equal(classifySendError({ kind: "balance", message: "low" }, false).outcome, "failed");
  assert.equal(classifySendError({ message: "wallet exploded", walletOpened: true }, false).outcome, "unconfirmed");
  assert.equal(partialRulesKey("unconfirmed"), "rules.partialUnconfirmed");
  assert.equal(partialRulesKey("failed"), "rules.partial");
});

test("EXECUTED_OPTIMISTIC is not final", async () => {
  const { isFinalOutcome, toAttempt } = await import("../../site/assets/js/confirm.mjs");
  const { isFinalStatus } = await import("../../site/assets/js/rpc.mjs");
  const optimistic = { final_execution_status: "EXECUTED_OPTIMISTIC", status: { SuccessValue: "" } };
  assert.equal(isFinalOutcome(optimistic), false);
  assert.equal(isFinalStatus(optimistic), false);
  assert.equal(toAttempt({ result: optimistic }).success, false);
  const final = { final_execution_status: "FINAL", status: { SuccessValue: "" } };
  assert.equal(isFinalOutcome(final), true);
  assert.equal(isFinalStatus(final), true);
});

test("t8r5 review fixes: not-sent errors, no-hash override, narrow miss", async () => {
  const m = await import("../../site/assets/js/confirm.mjs");
  assert.equal(m.classifySendError(new Error("stamp missing"), false).outcome, "notsent");
  const opened = Object.assign(new Error("wallet exploded"), { walletOpened: true });
  assert.equal(m.classifySendError(opened, false).outcome, "unconfirmed");
  assert.equal(m.probeErrorKind({ kind: "miss", message: "account cg-x.testnet does not exist" }), "unread");
  assert.equal(m.probeErrorKind({ kind: "rpc", message: "UNKNOWN_TRANSACTION" }), "miss");
  assert.equal(m.lockView({ outcome: "unconfirmed", elapsedMs: m.SILENT_MS, anyRpcAnswered: false }).offerOverride, true);
});
