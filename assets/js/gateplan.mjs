/** Pure gate-create decisions. The wallet popup stays closed unless unlock is true. */

import { asBig, nearToYocto } from "./format.mjs";
import { FALLBACK_TOTAL_NEAR, GAS_MARGIN_NEAR } from "./network.mjs";

const YOCTO = 10n ** 24n;
const HUNDREDTH = 10n ** 22n;

/** Protocol storage price used to turn storage_usage into locked yoctoNEAR. */
export const STORAGE_BYTE_YOCTO = 10n ** 19n;

/** Same floor C2 uses before it opens a send popup: 0.003 NEAR. */
export const MIN_SEND_YOCTO = 3000000000000000000000n;

const TENTH = 10n ** 23n;

export function availableYocto(account) {
  if (!account || account.amount == null) return null;
  let amount;
  let usage;
  try {
    amount = asBig(account.amount);
    usage = asBig(account.storage_usage ?? 0);
  } catch {
    return null;
  }
  if (usage < 0n) usage = 0n;
  const locked = usage * STORAGE_BYTE_YOCTO;
  if (amount <= locked) return 0n;
  return amount - locked;
}

/** Positive gap rounded up to one decimal NEAR. Null when nothing more is needed. */
export function ceilOneDecimalNear(gapYocto) {
  let gap;
  try { gap = typeof gapYocto === "bigint" ? gapYocto : asBig(gapYocto); }
  catch { return null; }
  if (gap <= 0n) return null;
  const units = (gap + TENTH - 1n) / TENTH;
  return `${units / 10n}.${units % 10n}`;
}

/** NEAR amount rounded up to two decimal places. Zero stays 0.00. */
export function ceilTwoDecimalNear(value) {
  let n;
  try { n = typeof value === "bigint" ? value : asBig(value); }
  catch { return null; }
  if (n < 0n) n = 0n;
  const units = (n + HUNDREDTH - 1n) / HUNDREDTH;
  const frac = (units % 100n).toString().padStart(2, "0");
  return `${units / 100n}.${frac}`;
}

/** Deposit in NEAR with at most 5 decimal places. Extra digits are dropped, not rounded up. */
export function nearUpTo5(value) {
  let n;
  try { n = typeof value === "bigint" ? value : asBig(value); }
  catch { return null; }
  if (n < 0n) n = 0n;
  const whole = n / YOCTO;
  const frac = (n % YOCTO).toString().padStart(24, "0").slice(0, 5).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/**
 * Guidance for one gate.
 * readable: required_deposit parsed.
 * y: that deposit, at most 5 decimals.
 * x: Y + gas margin, rounded up to two decimals, or FALLBACK_TOTAL_NEAR when the view is missing.
 * totalYocto: the exact Y + margin when readable, otherwise the fallback. Shortfall and unlock use this.
 */
export function gateAmount(requiredDeposit, { gasMarginNear = GAS_MARGIN_NEAR, fallbackNear = FALLBACK_TOTAL_NEAR } = {}) {
  const fallbackYocto = nearToYocto(fallbackNear);
  const unread = { readable: false, x: String(fallbackNear), y: null, totalYocto: fallbackYocto, deposit: null };
  if (requiredDeposit == null || requiredDeposit === "") return unread;
  let deposit;
  try { deposit = asBig(requiredDeposit); } catch { return unread; }
  if (deposit <= 0n) return unread;
  const margin = nearToYocto(gasMarginNear);
  if (margin == null) return unread;
  const totalYocto = deposit + margin;
  const x = ceilTwoDecimalNear(totalYocto);
  const y = nearUpTo5(deposit);
  if (!x || !y) return unread;
  return { readable: true, x, y, totalYocto, deposit: String(requiredDeposit) };
}

export function neededYocto({ factoryDeployed, requiredDeposit, requiredTotalNear, gasMarginNear }) {
  if (factoryDeployed && requiredDeposit) {
    let deposit;
    try { deposit = asBig(requiredDeposit); } catch { return null; }
    const margin = nearToYocto(gasMarginNear);
    if (margin == null) return null;
    return deposit + margin;
  }
  return nearToYocto(requiredTotalNear);
}

/** Shown guidance total. The fallback constant stays as written. A live total rounds up to two decimals. */
export function formatNeed(needed, fallbackNear = FALLBACK_TOTAL_NEAR) {
  const total = nearToYocto(fallbackNear);
  if (needed == null) return "";
  if (total != null && needed === total) return String(fallbackNear);
  return ceilTwoDecimalNear(needed) || "";
}

/**
 * Whether Create my gate may open the wallet.
 * depositToAttach is the live required_deposit string, never a fixed amount.
 */
export function createGatePlan(input) {
  const needed = neededYocto(input);
  const have = input.balanceYocto == null ? null : BigInt(input.balanceYocto);
  const shortfall = needed != null && have != null ? ceilOneDecimalNear(needed - have) : null;
  const reasons = [];
  if (input.alreadyHasGate) reasons.push("already");
  if (!input.hasStamp) reasons.push("need-key");
  if (input.hasStamp && input.backupReady === false) reasons.push("need-backup");
  if (input.factoryError) reasons.push("factory-error");
  else if (!input.factoryKnown) reasons.push("loading");
  else if (!input.factoryDeployed) reasons.push("factory-locked");
  if (input.factoryDeployed && !input.requiredDeposit) reasons.push("deposit-unread");
  if (!input.walletConnected) reasons.push("need-wallet");
  else if (have == null) reasons.push("balance-unread");
  if (needed == null) reasons.push("need-total");
  if (shortfall) reasons.push("low-balance");
  if (!input.understood) reasons.push("need-check");
  const unlock = reasons.length === 0;
  const depositToAttach = unlock ? String(input.requiredDeposit) : null;
  return { unlock, reasons, needed, shortfall, have, depositToAttach };
}

export function createdGateView({ gateId, txHash, explorerTx }) {
  const id = gateId || "";
  return {
    done: !!id,
    gateId: id,
    copy: !!id,
    txUrl: txHash && explorerTx ? `${explorerTx}${txHash}` : "",
  };
}

export function resolveGateAccount({ localId, viewId, accountExists }) {
  const id = viewId || localId || "";
  return {
    id,
    mismatch: !!(viewId && localId && viewId !== localId),
    found: !!(id && accountExists),
  };
}

export function reloadFound({ localId, viewId, account, emptyCodeHash }) {
  const hash = account?.code_hash || "";
  const exists = !!hash && hash !== emptyCodeHash;
  const resolved = resolveGateAccount({ localId, viewId, accountExists: exists });
  return {
    stepDone: resolved.found,
    gateId: resolved.found ? resolved.id : "",
    mismatch: resolved.mismatch,
  };
}

/**
 * Compare signature_domain's owner (third element) with the key re-derived from this device.
 * A stored public_key that is not the derived key is a mismatch, even when it equals the gate owner.
 * No derived key locks the same owner actions.
 */
export function stampKeyMatch({ gateOwner = "", derivedPublicKey = "", storedPublicKey = "", domainRead = true } = {}) {
  const sentenceKey = "gate.stampMismatch";
  const derived = derivedPublicKey || "";
  const stored = storedPublicKey || "";
  if (!derived) return { unlocked: false, mismatch: true, reason: "no-stamp", sentenceKey };
  if (stored !== derived) return { unlocked: false, mismatch: true, reason: "tampered", sentenceKey };
  if (domainRead === false) return { unlocked: false, mismatch: false, reason: "unread", sentenceKey: "state.fail" };
  if (!gateOwner || gateOwner !== derived) return { unlocked: false, mismatch: true, reason: "different-key", sentenceKey };
  return { unlocked: true, mismatch: false, reason: "match", sentenceKey: "" };
}

/** Account lookup plus the stamp check. Step 3 is done only when the re-derived key matches. */
export function findGateAgain(input) {
  const located = reloadFound({
    localId: input.localId,
    viewId: input.viewId,
    account: input.account,
    emptyCodeHash: input.emptyCodeHash,
  });
  if (!located.stepDone) {
    return {
      stepDone: false,
      gateId: "",
      candidateId: "",
      accountMismatch: located.mismatch,
      stampLocked: false,
      reason: "absent",
      sentenceKey: "",
    };
  }
  const stamp = stampKeyMatch({
    gateOwner: input.gateOwner,
    derivedPublicKey: input.derivedPublicKey,
    storedPublicKey: input.storedPublicKey,
    domainRead: input.domainRead !== false,
  });
  if (!stamp.unlocked) {
    return {
      stepDone: false,
      gateId: "",
      candidateId: located.gateId,
      accountMismatch: located.mismatch,
      stampLocked: true,
      reason: stamp.reason,
      sentenceKey: stamp.sentenceKey,
    };
  }
  return {
    stepDone: true,
    gateId: located.gateId,
    candidateId: located.gateId,
    accountMismatch: located.mismatch,
    stampLocked: false,
    reason: "match",
    sentenceKey: "",
  };
}

export async function gateAccountId(ownerAccountId, factoryAccountId) {
  const bytes = new TextEncoder().encode(String(ownerAccountId));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `g${hex.slice(0, 20)}.${factoryAccountId}`;
}
