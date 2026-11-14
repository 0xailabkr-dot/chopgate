/** Signing-flow controller. No DOM. Unit-tested with a fake wallet. */

import { classifySendError } from "./confirm.mjs";

const PANIC_KEYS = [
  ["unknown or resolved pending", "panic.resolved"],
  ["withdrawal nonce replay", "panic.withdrawNonce"],
  ["rules nonce replay", "panic.rulesNonce"],
  ["config nonce replay", "panic.configNonce"],
  ["invalid rules signature", "panic.rulesSig"],
  ["invalid config signature", "panic.configSig"],
  ["invalid withdrawal signature", "panic.withdrawSig"],
  ["invalid pending signature", "panic.pendingSig"],
  ["payout_unavailable: insufficient escrow", "panic.escrowShort"],
  ["payout_unavailable: invalid recipient", "panic.badRecipient"],
  ["payout_unavailable: escrow", "panic.escrow"],
  ["deposit must be positive", "panic.depositPositive"],
  ["invalid window", "panic.window"],
  ["invalid threshold", "panic.threshold"],
  ["invalid timezone", "panic.timezone"],
  ["positive ttl required", "panic.ttl"],
  ["pending not expired", "panic.notExpired"],
  ["ed25519 required", "panic.ed25519"],
  ["invalid label", "panic.label"],
  ["insufficient deposit", "panic.lowDeposit"],
  ["deposit exceeds cap", "panic.depositCap"],
  ["prepaid gas below 200 Tgas", "panic.gas"],
  ["too many gates for this account", "panic.tooManyGates"],
  ["signature domain required", "panic.domain"],
  ["callback mismatch", "panic.callback"],
  ["judge policy replay", "panic.judgeReplay"],
  ["invalid judge policy signature", "panic.judgeSig"],
];

export function isCancelError(error) {
  if (!error) return false;
  if (error.code === "cancel" || error.kind === "cancel") return true;
  const msg = `${error.name || ""} ${error.message || error}`.toLowerCase();
  return /user reject|user cancel|rejected by user|cancel|dismiss|closed the|popup closed|request rejected/.test(msg);
}

export function panicKey(raw) {
  const s = String(raw || "");
  for (const [needle, key] of PANIC_KEYS) {
    if (s.includes(needle)) return key;
  }
  return null;
}

export function failureKey(result) {
  if (!result) return "flow.failed";
  if (result.outcome === "unconfirmed" || result.unconfirmed) return "tx.unconfirmed";
  if (result.outcome === "cancelled") return "flow.cancelled";
  if (result.outcome === "need-key") return "flow.needKey";
  if (result.outcome === "mismatch") return "flow.mismatch";
  if (result.panic) return panicKey(result.panic) || "flow.failed";
  if (result.reasonCode) return `reason.${result.reasonCode}`;
  return "flow.failed";
}

/** How much to add to the withdrawal nonce after the owner presses Try again. */
export function bumpOnRetry(result) {
  if (result?.panic && String(result.panic).includes("withdrawal nonce replay")) return 1;
  if (result?.reasonCode === "nonce_reuse") return 0;
  return 0;
}

/**
 * One owner signing flow.
 * ctx.getStamp() -> { publicKey, seed } | null
 * ctx.sign(payload) -> hex signature. Called only when a stamp exists.
 * ctx.send(built, signature) -> wallet result, or throw on cancel/error.
 * ctx.readResult(sent) -> { ok, txHash, panic, reasonCode }
 * job.build() -> { payload, ...tx fields }
 */
export async function runSigningFlow(ctx, job) {
  const stamp = await ctx.getStamp();
  if (!stamp) return { outcome: "need-key", phase: "idle" };
  let built;
  try {
    built = await job.build(stamp);
  } catch (error) {
    return { outcome: "notsent", phase: "stamping", panic: String(error?.message || error) };
  }
  if (built?.mismatch) return { outcome: "mismatch", phase: "idle" };
  if (built?.refused) return { outcome: "failed", phase: "idle", kind: "gate", panic: String(built.refused) };
  let signature;
  try {
    signature = await ctx.sign(built.payload, stamp);
  } catch (error) {
    return { outcome: "notsent", phase: "stamping", panic: String(error?.message || error) };
  }
  let sent;
  try {
    sent = await ctx.send(built, signature);
  } catch (error) {
    const decision = classifySendError(error, isCancelError(error));
    if (decision.outcome === "cancelled") return { outcome: "cancelled", phase: "idle" };
    if (decision.outcome === "notsent") return { outcome: "notsent", phase: "idle", panic: String(error?.message || error) };
    if (decision.outcome === "failed") {
      return { outcome: "failed", phase: "wallet", panic: String(error?.message || error), kind: error?.kind || "" };
    }
    return { outcome: "unconfirmed", phase: "wallet", unconfirmed: true, txHash: error?.txHash || null, kind: error?.kind || "wallet" };
  }
  let parsed;
  try {
    parsed = await ctx.readResult(sent);
  } catch (error) {
    return { outcome: "unconfirmed", phase: "chain", txHash: sent?.txHash || null, unconfirmed: true };
  }
  if (parsed?.ok === true) return { outcome: "confirmed", phase: "confirmed", txHash: parsed.txHash || null };
  if (parsed == null || parsed.ok == null) {
    return { outcome: "unconfirmed", phase: "idle", txHash: parsed?.txHash || sent?.txHash || null, unconfirmed: true };
  }
  return {
    outcome: "failed",
    phase: "chain",
    panic: parsed?.panic || "",
    reasonCode: parsed?.reasonCode || "",
    txHash: parsed?.txHash || null,
  };
}
