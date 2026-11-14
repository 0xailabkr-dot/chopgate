import test from "node:test";
import assert from "node:assert/strict";
import { STORAGE_BYTE_YOCTO, TOP_UP_STEP_YOCTO, withdrawalSlack } from "../../site/assets/js/storage.mjs";

function row(slackYocto) {
  const usage = 100n;
  const escrow = 5n * (10n ** 24n);
  const amount = usage * STORAGE_BYTE_YOCTO + escrow + slackYocto;
  return withdrawalSlack({ amount, storageUsage: usage, escrow });
}

test("negative slack blocks a full withdrawal and adds the 0.001 buffer", () => {
  const got = row(-1n);
  assert.equal(got.slack, -1n);
  assert.equal(got.blocked, true);
  assert.equal(got.topUpYocto, 2n * TOP_UP_STEP_YOCTO);
  assert.equal(got.topUpNear, "0.002");
});

test("zero slack does not block and sends nothing", () => {
  const got = row(0n);
  assert.equal(got.slack, 0n);
  assert.equal(got.blocked, false);
  assert.equal(got.topUpYocto, 0n);
  assert.equal(got.topUpNear, "0");
});

test("positive slack does not block and sends nothing", () => {
  const extra = 3n * TOP_UP_STEP_YOCTO;
  const got = row(extra);
  assert.equal(got.slack, extra);
  assert.equal(got.blocked, false);
  assert.equal(got.topUpYocto, 0n);
  assert.equal(got.topUpNear, "0");
});

test("buffer rounding stays on an exact 0.001 and rounds a remainder up", () => {
  const exact = row(-(2n * TOP_UP_STEP_YOCTO));
  assert.equal(exact.blocked, true);
  assert.equal(exact.topUpYocto, 3n * TOP_UP_STEP_YOCTO);
  assert.equal(exact.topUpNear, "0.003");

  const remainder = row(-(TOP_UP_STEP_YOCTO + 1n));
  assert.equal(remainder.slack, -(TOP_UP_STEP_YOCTO + 1n));
  assert.equal(remainder.topUpYocto, 3n * TOP_UP_STEP_YOCTO);
  assert.equal(remainder.topUpNear, "0.003");

  const onStep = row(-TOP_UP_STEP_YOCTO);
  assert.equal(onStep.topUpYocto, 2n * TOP_UP_STEP_YOCTO);
  assert.equal(onStep.topUpNear, "0.002");
});
