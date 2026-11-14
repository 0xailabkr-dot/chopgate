import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  NO_ORIGINAL_EN,
  NO_ORIGINAL_KO,
  approvalFacts,
  chainEntries,
  findOriginal,
  withJobIds,
} from "../../site/assets/js/original.mjs";

const HASH = "ab".repeat(32);
const GATE = "gate.testnet";

function saved({ gate = GATE, serial = "1", jobId = "0", hash = HASH, text = "pay invoice 104", target = "a.testnet", max = "5", budget = "9" } = {}) {
  return {
    gate,
    serial,
    budget,
    entries: [{
      job_id: jobId,
      action: "transfer",
      target,
      max_amount: max,
      instruction: text,
      instruction_hash: hash,
    }],
  };
}

test("same hash with a different serial is not shown", () => {
  const records = [
    saved({ serial: "1", text: "alpha", target: "alpha.testnet", max: "1" }),
    saved({ serial: "2", text: "beta", target: "beta.testnet", max: "2" }),
  ];
  const hit = findOriginal(records, { gate: GATE, serial: "2", jobId: "0", instructionHash: HASH });
  assert.equal(hit.found, true);
  assert.equal(hit.text, "beta");
  const other = findOriginal(records, { gate: GATE, serial: "9", jobId: "0", instructionHash: HASH });
  assert.equal(other.found, false);
  assert.equal(other.text, "");
  assert.equal(other.message, NO_ORIGINAL_EN);
  assert.equal(other.text === "alpha", false);
  assert.equal(other.text === "beta", false);
});

test("a different gate is not shown", () => {
  const records = [saved({ text: "alpha", target: "alpha.testnet" })];
  const hit = findOriginal(records, { gate: "other.testnet", serial: "1", jobId: "0", instructionHash: HASH });
  assert.equal(hit.found, false);
  assert.equal(hit.text, "");
  assert.equal(hit.message, NO_ORIGINAL_EN);
});

test("two matching records show no original", () => {
  const records = [
    saved({ text: "one", target: "one.testnet", max: "1" }),
    saved({ text: "two", target: "two.testnet", max: "2" }),
  ];
  const hit = findOriginal(records, { gate: GATE, serial: "1", jobId: "0", instructionHash: HASH });
  assert.equal(hit.found, false);
  assert.equal(hit.text, "");
  assert.equal(hit.message, NO_ORIGINAL_EN);
  const view = approvalFacts(
    { id: 3, serial: "1", target: "payee.testnet", amount: "1000", job_id: "0", instruction_hash: HASH },
    records,
    GATE,
  );
  assert.equal(view.originalFound, false);
  assert.equal(view.original, "");
  assert.equal(view.message, NO_ORIGINAL_EN);
  assert.equal(view.target, "payee.testnet");
  assert.equal(view.amount, "1000");
});

test("an exact gate, serial, and job id is shown", () => {
  const records = [saved({ serial: "4", jobId: "1", text: "pay invoice 104" })];
  const hit = findOriginal(records, { gate: GATE, serial: 4, jobId: 1 });
  assert.equal(hit.found, true);
  assert.equal(hit.text, "pay invoice 104");
  assert.equal(hit.message, "");
  const hashOnly = findOriginal(records, { instructionHash: HASH });
  assert.equal(hashOnly.found, false);
  const otherJob = findOriginal(records, { gate: GATE, serial: "4", jobId: "0", instructionHash: HASH });
  assert.equal(otherJob.found, false);
});

test("a saved row without gate, serial, and job id is not found", () => {
  const old = [{
    gate: GATE,
    serial: "5",
    entries: [{ instruction: "legacy", instruction_hash: HASH, target: "x.testnet", max_amount: "9" }],
  }];
  const hit = findOriginal(old, { gate: GATE, serial: "5", jobId: "0", instructionHash: HASH });
  assert.equal(hit.found, false);
  assert.equal(hit.message, NO_ORIGINAL_EN);
  const noGate = [{ serial: "5", entries: [{ job_id: "0", instruction: "legacy" }] }];
  assert.equal(findOriginal(noGate, { gate: GATE, serial: "5", jobId: "0" }).found, false);
});

test("a hold without a job id shows the one stored job and not a second job", () => {
  const one = [saved({ serial: "3", jobId: "0", text: "only job", target: "local.testnet", max: "4" })];
  const hold = { id: 1, serial: 3, target: "payee.testnet", amount: "50", instruction_hash: HASH };
  const view = approvalFacts(hold, one, GATE);
  assert.equal(view.originalFound, true);
  assert.equal(view.original, "only job");
  assert.equal(view.target, "payee.testnet");
  assert.equal(view.amount, "50");
  const twoJobs = [
    saved({ serial: "3", jobId: "0", text: "job zero" }),
    saved({ serial: "3", jobId: "1", text: "job one" }),
  ];
  const ambiguous = approvalFacts(hold, twoJobs, GATE);
  assert.equal(ambiguous.originalFound, false);
  assert.equal(ambiguous.message, NO_ORIGINAL_EN);
  assert.equal(ambiguous.target, "payee.testnet");
  assert.equal(ambiguous.amount, "50");
  const otherSerial = approvalFacts(
    { id: 2, serial: 9, target: "payee.testnet", amount: "50", instruction_hash: HASH },
    one,
    GATE,
  );
  assert.equal(otherSerial.originalFound, false);
  assert.equal(otherSerial.original, "");
});

test("approval recipient and amount stay on the hold when the local record disagrees", () => {
  const hold = {
    id: 9,
    serial: 7,
    target: "payee.testnet",
    amount: "80000000000000000000000",
    action: "transfer",
    instruction_hash: HASH,
    job_id: "0",
  };
  const local = saved({
    serial: "7",
    jobId: "0",
    text: "pay invoice 104",
    target: "other.testnet",
    max: "1",
    budget: "2",
  });
  const view = approvalFacts(hold, [local], GATE);
  assert.equal(view.target, hold.target);
  assert.equal(view.amount, hold.amount);
  assert.equal(view.serial, "7");
  assert.equal(view.id, "9");
  assert.equal(view.original, "pay invoice 104");
  assert.equal(view.originalFound, true);
  assert.equal(view.target === local.entries[0].target, false);
  assert.equal(view.amount === local.entries[0].max_amount, false);
  assert.equal(view.amount === local.budget, false);
});

test("stamped jobs keep gate, serial, and job id, and the chain entry does not", () => {
  const stored = withJobIds([
    { action: "transfer", target: "a.testnet", max_amount: "1", instruction: "one", instruction_hash: "aa" },
    { action: "transfer", target: "b.testnet", max_amount: "2", instruction: "two", instruction_hash: "bb" },
  ]);
  const row = { gate: GATE, serial: "8", entries: stored };
  assert.equal(stored[0].job_id, "0");
  assert.equal(stored[1].job_id, "1");
  assert.equal(findOriginal([row], { gate: GATE, serial: "8", jobId: "1" }).text, "two");
  const chain = chainEntries(stored);
  assert.equal(chain[0].instruction, undefined);
  assert.equal(chain[0].job_id, undefined);
  assert.equal(chain[0].jobId, undefined);
  assert.equal(chain[0].action, "transfer");
  assert.equal(chain[0].target, "a.testnet");
  assert.equal(chain[0].max_amount, "1");
  assert.equal(chain[0].instruction_hash, "aa");
  assert.equal(Object.hasOwn(chain[1], "instruction"), false);
  assert.equal(Object.hasOwn(chain[1], "job_id"), false);
});

test("no-original copy is the same sentence in both languages", () => {
  const en = JSON.parse(readFileSync(new URL("../../site/assets/i18n/en.json", import.meta.url), "utf8"));
  const ko = JSON.parse(readFileSync(new URL("../../site/assets/i18n/ko.json", import.meta.url), "utf8"));
  assert.equal(en["hold.noOriginal"], NO_ORIGINAL_EN);
  assert.equal(ko["hold.noOriginal"], NO_ORIGINAL_KO);
  assert.equal(en["hold.noOriginal"], "This device has no original text for this job.");
  assert.equal(ko["hold.noOriginal"], "이 기기에 원문이 없습니다.");
});

test("a hold without a job id is not shown when the one stored job has a different hash or no hash", () => {
  const hold = { id: 4, serial: 5, target: "payee.testnet", amount: "50", instruction_hash: HASH };
  const other = approvalFacts(hold, [saved({ serial: "5", hash: "cd".repeat(32) })], GATE);
  assert.equal(other.originalFound, false);
  assert.equal(other.original, "");
  const noHash = [saved({ serial: "5" })];
  delete noHash[0].entries[0].instruction_hash;
  const missing = approvalFacts(hold, noHash, GATE);
  assert.equal(missing.originalFound, false);
  assert.equal(missing.target, "payee.testnet");
  assert.equal(missing.amount, "50");
});
