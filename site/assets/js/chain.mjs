import { TESTNET, explorerTxUrl } from "./network.mjs";
import { clearCache, isFinalStatus, postIndexer, probeTxStatus, txStatus, viewAccessKeys, viewAccount, viewCall } from "./rpc.mjs";
import { decideOutcome, toAttempt } from "./confirm.mjs";
import { nsToMs, rawInt } from "./format.mjs";
import { eventsFromStatus, maxWithdrawNonce } from "./events.mjs";
import { availableYocto } from "./gateplan.mjs";
import {
  authorizationBytes,
  hex,
  pendingDecisionChecked,
  pendingRequestHash,
  signingBytesChecked,
  spendRulesBytes,
  tier2ConfigBytes,
  withdrawalBytes,
} from "./encoder.mjs";
import { signBytes } from "./keys.mjs";

export const GAS_HEAVY = "300000000000000";
export const GAS_CALL = "100000000000000";
export const GAS_LIGHT = "50000000000000";
export const U128_MAX = "340282366920938463463374607431768211455";
export const U32_MAX = 4294967295;
const HOLD = new Set([
  "tier2_escalate", "2b_per_tx_limit", "2b_per_day_limit", "2b_frequency", "2b_time_window",
  "2b_category_missing", "2b_category", "2b_low_confidence", "2a_unknown", "2a_low_confidence", "jev_missing",
]);
const OWNER_METHODS = new Set([
  "register", "set_spend_rules", "set_tier2_config", "approve_pending", "reject_pending", "deposit",
]);

export function u128(value) {
  if (value == null) return "0";
  if (typeof value === "object") return String(value.value ?? "0");
  return String(value);
}

export function isEmptyCode(hash) {
  return !hash || hash === TESTNET.emptyCodeHash;
}

export async function accountOf(id, { fresh = false } = {}) {
  try {
    return await viewAccount(id, { fresh });
  } catch (error) {
    const msg = String(error?.message || "");
    if (/does not exist|UNKNOWN_ACCOUNT|Account does not/i.test(msg)) return null;
    throw error;
  }
}

export async function availableBalance(accountId, { fresh = false } = {}) {
  const account = await accountOf(accountId, { fresh });
  if (!account) return null;
  return availableYocto(account);
}

export async function factoryState() {
  const account = await accountOf(TESTNET.factoryAccountId);
  if (!account || isEmptyCode(account.code_hash)) return { deployed: false, required: null, codeHash: null };
  let required = null;
  let codeHash = null;
  try { required = u128(await viewCall(TESTNET.factoryAccountId, "required_deposit", {})); } catch { required = null; }
  try {
    const hash = await viewCall(TESTNET.factoryAccountId, "gate_code_hash", {});
    codeHash = hash == null ? null : String(hash);
  } catch { codeHash = null; }
  return { deployed: true, required, codeHash };
}

/** Factory p5 view. Argument name is `owner`. Recheck when the contract is deployed. */
export async function gateAccountFor(ownerAccount) {
  const raw = await viewCall(TESTNET.factoryAccountId, "gate_account_for", { owner: ownerAccount });
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") return String(raw.account_id || raw.gate || "");
  return raw == null ? "" : String(raw);
}

export async function lookupOwnerGate(ownerAccount, localId) {
  const factory = await factoryState();
  let viewId = "";
  if (factory.deployed) {
    try { viewId = await gateAccountFor(ownerAccount); } catch { viewId = ""; }
  }
  const id = viewId || localId || "";
  let account = null;
  if (id) {
    try { account = await accountOf(id); } catch { account = null; }
  }
  const exists = !!(account && !isEmptyCode(account.code_hash));
  return {
    factory,
    viewId,
    localId: localId || "",
    id,
    exists,
    account,
    mismatch: !!(viewId && localId && viewId !== localId),
  };
}

export async function signatureDomain(gate, options = {}) {
  const raw = await viewCall(gate, "signature_domain", {}, { fresh: options?.fresh === true });
  if (!Array.isArray(raw) || raw.length < 3) {
    const error = new Error("signature domain");
    error.kind = "rpc";
    throw error;
  }
  if (String(raw[0]) !== TESTNET.chainId) {
    const error = new Error("signature domain chain");
    error.kind = "domain";
    throw error;
  }
  return { chainId: String(raw[0]), deploymentId: String(raw[1]), owner: String(raw[2]) };
}

export async function readRules(gate, options = {}) {
  const fresh = options?.fresh === true;
  const [escrow, rules, tier2] = await Promise.all([
    viewCall(gate, "escrow_balance", {}, { fresh }),
    viewCall(gate, "spend_rules", {}, { fresh }),
    viewCall(gate, "tier2_config", {}, { fresh }),
  ]);
  return { escrow: u128(escrow), rules, tier2 };
}

export async function readPending(gate) {
  const rows = await viewCall(gate, "pending_items", {});
  if (!Array.isArray(rows)) return [];
  const id = String(gate ?? "");
  return rows.map((row) => (row && typeof row === "object" ? { ...row, gate: id } : row));
}

async function tourCall(fn) {
  try { return { ok: true, value: await fn() }; }
  catch (error) {
    if (error?.kind === "rate") throw error;
    return { ok: false, error };
  }
}

function keyCount(value) {
  if (Array.isArray(value?.keys)) return value.keys.length;
  return null;
}

function readYocto(value) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    const text = String(value).trim();
    if (!text) return null;
    return u128(text);
  }
  if (value && typeof value === "object" && !Array.isArray(value) && value.value != null) return u128(value);
  return null;
}

/** Live facts for the tour rules tab. A missed read stays null. It is not filled with 0. */
export async function readTourFacts(gate) {
  const [account, keys, escrow, rules, tier2, mandates] = await Promise.all([
    tourCall(() => accountOf(gate, { fresh: true })),
    tourCall(() => viewAccessKeys(gate, { fresh: true })),
    tourCall(() => viewCall(gate, "escrow_balance", {})),
    tourCall(() => viewCall(gate, "spend_rules", {})),
    tourCall(() => viewCall(gate, "tier2_config", {})),
    tourCall(() => viewCall(gate, "mandate_count", {})),
  ]);
  const facts = {
    escrow: null,
    review: null,
    keys: null,
    codeHash: null,
    hashMatches: false,
    mandates: null,
    rules: null,
    tier2: null,
    rulesError: null,
  };
  if (account.ok && account.value?.code_hash) {
    facts.codeHash = String(account.value.code_hash);
    facts.hashMatches = facts.codeHash === TESTNET.gateCodeHash;
  }
  if (keys.ok) facts.keys = keyCount(keys.value);
  if (escrow.ok) facts.escrow = readYocto(escrow.value);
  if (rules.ok) facts.rules = rules.value && typeof rules.value === "object" ? rules.value : null;
  else facts.rulesError = rules.error || Object.assign(new Error("rules"), { kind: "rpc" });
  if (tier2.ok && tier2.value && typeof tier2.value === "object" && tier2.value.amount_threshold != null) {
    facts.tier2 = tier2.value;
    facts.review = u128(tier2.value.amount_threshold);
  } else if (tier2.ok && tier2.value && typeof tier2.value === "object") facts.tier2 = tier2.value;
  if (mandates.ok) {
    const raw = readYocto(mandates.value);
    if (raw != null) {
      const num = Number(raw);
      facts.mandates = Number.isFinite(num) ? num : null;
    }
  }
  return facts;
}

export async function readRemaining(gate, serial) {
  try { return u128(await viewCall(gate, "remaining_budget", { serial: rawInt(serial) })); }
  catch { return null; }
}

export { eventsFromStatus, maxWithdrawNonce, isU64 } from "./events.mjs";

export function failureText(status) {
  const parts = [];
  const look = (value) => {
    if (!value) return;
    if (value.Failure != null) parts.push(typeof value.Failure === "string" ? value.Failure : JSON.stringify(value.Failure));
  };
  look(status?.status);
  look(status?.transaction_outcome?.outcome?.status);
  for (const row of status?.receipts_outcome || []) look(row?.outcome?.status);
  return parts.join(" ");
}

function field(row, names) {
  for (const name of names) if (row?.[name] != null && row[name] !== "") return row[name];
  return "";
}

export function verdictFor(code) {
  if (code === "allowed") return "paid";
  if (HOLD.has(code)) return "held";
  if (!code) return "recorded";
  return "refused";
}

export function reasonKeyFor(code, eventName) {
  if (code) return `reason.${code}`;
  if (eventName && eventName !== "decision") return `event.${eventName}`;
  return "event.decision";
}

function primaryEvent(events) {
  return events.find((item) => item.event === "decision")
    || events.find((item) => item.event === "pending_created")
    || events.find((item) => item.event.startsWith("pending_"))
    || events.find((item) => item.event === "payout_settled" || item.event === "payout")
    || events[0]
    || null;
}

export function methodNameFromTx(tx) {
  const actions = tx?.actions || tx?.transaction?.actions || [];
  for (const action of actions) {
    if (!action || typeof action !== "object") continue;
    if (typeof action.method_name === "string" && action.method_name) return action.method_name;
    const call = action.FunctionCall || action.function_call;
    if (call && typeof call === "object" && call.method_name) return String(call.method_name);
  }
  return "";
}

export function signerFromTx(tx) {
  const body = tx?.transaction || tx || {};
  return String(body.signer_id || body.signer_account_id || "");
}

function hasPayout(events, method) {
  if (method === "on_payout") return true;
  return events.some((item) => item.event === "payout" || item.event === "payout_settled" || item.event === "on_payout");
}

function withActor(meta) {
  const method = String(meta.method || "");
  const signer = String(meta.signer || meta.agent || "");
  let agentKind = "unknown";
  if (OWNER_METHODS.has(method)) agentKind = "owner";
  else if (method.startsWith("authorize_and_pay") && signer) agentKind = "account";
  else if (signer) agentKind = "account";
  return { ...meta, method, signer, agent: signer, agentKind };
}

export function rowFromTx(meta, events, panic) {
  const actor = withActor(meta);
  const list = Array.isArray(events) ? events : [];
  if (list.length === 0 && !panic) {
    // A final, successful transaction that logged no event (set_tier2_config logs none).
    return {
      ...actor,
      unread: false,
      verdict: "recorded",
      reasonCode: "",
      reasonKey: actor.method === "set_tier2_config" ? "hist.reviewSaved" : "hist.noEvent",
      panic: "",
      amount: "0",
      amountKind: "",
      target: "",
      paidZero: false,
      events: [],
    };
  }
  if (panic && list.length === 0) {
    return {
      ...actor,
      verdict: "refused",
      reasonCode: "",
      reasonKey: "flow.failed",
      panic,
      amount: "0",
      amountKind: "",
      target: "",
      paidZero: true,
      events: list,
    };
  }
  const main = primaryEvent(list);
  const code = main?.data?.reason_code || (main?.data?.reasons || [])[0] || "";
  const method = actor.method;
  const payout = hasPayout(list, method);
  let verdict = "recorded";
  let reasonKey = reasonKeyFor(code, main?.event);
  let reasonCode = code;
  let amountKind = "";
  if (main?.event === "decision" || main?.event === "tier2_decision") verdict = verdictFor(code);
  else if (main?.event === "pending_created") verdict = "held";
  else if (main?.event === "pending_approved" || main?.event === "payout_settled" || main?.event === "withdraw_settled") verdict = "paid";
  else if (main?.event === "pending_rejected" || main?.event === "pending_expired" || main?.event === "payout_refunded" || main?.event === "withdraw_refunded") verdict = "refused";
  const explicitPaid = main?.event === "pending_approved" || main?.event === "withdraw_settled";
  if (verdict === "paid" && !payout && !explicitPaid) {
    verdict = "recorded";
    if (code === "allowed") reasonKey = "event.decision";
  }
  if (method === "register" && !panic && !payout && (!code || code === "allowed")) {
    verdict = "registered";
    amountKind = "budget";
    reasonKey = "verdict.registered";
    reasonCode = "";
  }
  const amount = u128(main?.data?.amount ?? main?.data?.budget ?? "0");
  return {
    ...actor,
    verdict,
    reasonCode,
    reasonKey,
    panic: panic || "",
    amount,
    amountKind,
    target: String(main?.data?.target || main?.data?.recipient || ""),
    paidZero: verdict === "refused",
    events: list,
    unread: false,
  };
}

function unreadMeta(meta) {
  return {
    ...withActor(meta),
    unread: true,
    verdict: "",
    reasonCode: "",
    reasonKey: "hist.unread",
    panic: "",
    amount: "",
    amountKind: "",
    target: "",
    paidZero: false,
    events: [],
    source: "unread",
  };
}

export async function reloadHistoryRow(gate, row) {
  const hash = String(row?.txHash || "");
  const signer = String(row?.signer || row?.agent || gate || "");
  const meta = {
    txHash: hash,
    agent: signer,
    signer,
    method: row?.method || "",
    timeMs: row?.timeMs || 0,
    explorer: row?.explorer || explorerTxUrl(hash),
  };
  if (!hash) return unreadMeta(meta);
  try {
    const packed = await txStatus(hash, signer || gate, { fresh: true });
    const events = eventsFromStatus(packed.result, gate);
    const panic = failureText(packed.result);
    meta.method = methodNameFromTx(packed.result) || meta.method;
    meta.signer = signerFromTx(packed.result) || meta.signer;
    meta.agent = meta.signer;
    if (!isFinalStatus(packed.result)) return unreadMeta(meta);
    return { ...rowFromTx(meta, events, panic), source: packed.source, unread: false };
  } catch (error) {
    if (error?.kind === "rate") throw error;
    return unreadMeta(meta);
  }
}

export async function loadHistory(gate, { limit = 8, fresh = false } = {}) {
  const index = await postIndexer(gate, { limit });
  if (!index || !Array.isArray(index.account_txs)) {
    const error = new Error("indexer");
    error.kind = "indexer";
    throw error;
  }
  const txs = index.account_txs.slice(0, limit);
  const rows = [];
  for (const tx of txs) {
    const hash = String(field(tx, ["transaction_hash", "hash", "tx_hash"]));
    const listedSigner = String(field(tx, ["signer_id", "signer_account_id", "predecessor_account_id", "predecessor_id", "signer"]));
    const listedMethod = String(field(tx, ["method_name", "method"]));
    const timeMs = nsToMs(field(tx, ["tx_block_timestamp", "block_timestamp"]) || 0);
    if (!hash) continue;
    const meta = { txHash: hash, agent: listedSigner, signer: listedSigner, method: listedMethod, timeMs, explorer: explorerTxUrl(hash) };
    try {
      const packed = await txStatus(hash, listedSigner || gate, { fresh });
      const events = eventsFromStatus(packed.result, gate);
      const panic = failureText(packed.result);
      meta.method = methodNameFromTx(packed.result) || listedMethod;
      meta.signer = signerFromTx(packed.result) || listedSigner;
      meta.agent = meta.signer;
      if (!isFinalStatus(packed.result)) rows.push(unreadMeta(meta));
      else rows.push({ ...rowFromTx(meta, events, panic), source: packed.source });
    } catch (error) {
      if (error?.kind === "rate") throw error;
      rows.push(unreadMeta(meta));
    }
  }
  return rows;
}

/**
 * Next withdrawal nonce as a decimal string. No Number() on the nonce.
 * indexerMax is a bigint or a decimal string (0 when none). storedNonce and previousNonce
 * count only when they match /^(0|[1-9]\d*)$/. bump is 0 or 1 from bumpOnRetry.
 * base = max(indexerMax, stored, 0) + 1. A previous attempt is used only when it is higher.
 */
export function nextWithdrawNonce(indexerMax, storedNonce, previousNonce, consumed, bump) {
  const asNonce = (value) => {
    if (typeof value === "bigint") return value;
    const text = String(value ?? "").trim();
    if (!/^(0|[1-9]\d*)$/.test(text)) return null;
    return BigInt(text);
  };
  let seen = 0n;
  const indexed = asNonce(indexerMax);
  if (indexed != null && indexed > seen) seen = indexed;
  const stored = asNonce(storedNonce);
  if (stored != null && stored > seen) seen = stored;
  let nonce = seen + 1n;
  const prev = asNonce(previousNonce);
  if (prev == null) return nonce.toString();
  const extra = consumed ? 1n : BigInt(bump);
  const fromLast = prev + extra;
  if (fromLast > nonce) nonce = fromLast;
  return nonce.toString();
}

/**
 * throw, skip, or keep for one indexer row in the withdraw-nonce scan.
 * A listed method other than withdraw_escrow is skip.
 * A row that could be withdraw_escrow (listed method empty or withdraw_escrow)
 * is throw when its status was not read or is not final.
 * After a final status, skip when the method is not withdraw_escrow, otherwise keep.
 * Rate limits are not decided here.
 */
export function withdrawNonceRowPlan({ listedMethod = "", read = false, final = false, method = "" } = {}) {
  if (listedMethod && listedMethod !== "withdraw_escrow") return "skip";
  if (!read || !final) return "throw";
  if ((method || listedMethod) !== "withdraw_escrow") return "skip";
  return "keep";
}

/**
 * Highest escrow_withdraw nonce on one indexer page (default 200). 0n when none.
 * One postIndexer request. A listed method other than withdraw_escrow skips status.
 * FastNEAR rows omit method_name, so a missing method still reads status.
 * A candidate row whose status is missing or not final throws kind "indexer".
 * Rate errors still throw as rate. A final method other than withdraw_escrow is skipped.
 */
export async function loadWithdrawNonceMax(gate, { limit = 200, fresh = false } = {}) {
  const index = await postIndexer(gate, { limit });
  if (!index || !Array.isArray(index.account_txs)) {
    const error = new Error("indexer");
    error.kind = "indexer";
    throw error;
  }
  const txs = index.account_txs.slice(0, limit);
  const rows = [];
  for (const tx of txs) {
    const hash = String(field(tx, ["transaction_hash", "hash", "tx_hash"]));
    const listedSigner = String(field(tx, ["signer_id", "signer_account_id", "predecessor_account_id", "predecessor_id", "signer"]));
    const listedMethod = String(field(tx, ["method_name", "method"]));
    if (!hash) continue;
    if (listedMethod && listedMethod !== "withdraw_escrow") continue;
    let packed;
    try {
      packed = await txStatus(hash, listedSigner || gate, { fresh });
    } catch (error) {
      if (error?.kind === "rate") throw error;
      const failure = new Error("indexer");
      failure.kind = "indexer";
      throw failure;
    }
    const method = methodNameFromTx(packed.result) || listedMethod;
    const final = isFinalStatus(packed.result);
    const plan = withdrawNonceRowPlan({ listedMethod, read: true, final, method });
    if (!final || plan === "throw") {
      const error = new Error("indexer");
      error.kind = "indexer";
      throw error;
    }
    if (plan !== "keep") continue;
    const signer = signerFromTx(packed.result) || listedSigner;
    const meta = {
      txHash: hash,
      agent: signer,
      signer,
      method,
      timeMs: nsToMs(field(tx, ["tx_block_timestamp", "block_timestamp"]) || 0),
      explorer: explorerTxUrl(hash),
    };
    const events = eventsFromStatus(packed.result, gate);
    const panic = failureText(packed.result);
    rows.push({ ...rowFromTx(meta, events, panic), source: packed.source });
  }
  return maxWithdrawNonce(rows);
}

export async function ownerSignature(domain, stamp, payload) {
  const bytes = authorizationBytes(domain.chainId, domain.deploymentId, stamp.publicKey, payload);
  return signBytes(stamp.seed, bytes);
}

export function mandatePayload(gate, mandate) {
  return signingBytesChecked(gate, mandate);
}

export function rulesPayload(gate, rules) {
  return spendRulesBytes(gate, rules);
}

export function tier2Payload(gate, config) {
  return tier2ConfigBytes(gate, config);
}

export function withdrawPayload(gate, amount, recipient, nonce) {
  return withdrawalBytes(gate, amount, recipient, nonce);
}

/**
 * Amount and nonce stay decimal text. amount is a JSON string (U128). nonce is rawInt (u64).
 * The payload is withdrawPayload of those same two texts.
 */
export function withdrawCallParts(gate, amount, recipient, nonce) {
  if (typeof amount !== "string" || typeof nonce !== "string") {
    throw new Error("withdraw amount and nonce must be decimal strings");
  }
  const amountText = amount;
  const nonceText = nonce;
  if (!/^(0|[1-9]\d*)$/.test(amountText)) throw new Error("withdraw amount text");
  if (!/^(0|[1-9]\d*)$/.test(nonceText)) throw new Error("withdraw nonce text");
  return {
    amountText,
    nonceText,
    payload: withdrawPayload(gate, amountText, recipient, nonceText),
    args: {
      amount: amountText,
      recipient,
      nonce: rawInt(nonceText),
    },
  };
}

export async function pendingPayload(gate, item, approve) {
  const hash = await pendingRequestHash(item);
  return pendingDecisionChecked(gate, item.id, approve, hash);
}

export function txOutcome(sent, gate) {
  const status = sent?.raw || {};
  const txHash = sent?.txHash || status?.transaction?.hash || null;
  const panic = failureText(status);
  if (panic) return { ok: false, txHash, panic };
  const events = eventsFromStatus(status, gate || "");
  const decision = events.find((item) => item.event === "decision");
  const code = decision?.data?.reason_code || "";
  if (code && code !== "allowed") return { ok: false, txHash, reasonCode: code };
  return { ok: true, txHash };
}

function attemptBody(probed, wantFailure) {
  const rows = probed?.attempts || [];
  for (let i = 0; i < rows.length; i += 1) {
    const view = toAttempt(rows[i]);
    if (rows[i]?.result && (wantFailure ? view.failure : view.success)) return rows[i].result;
  }
  return null;
}

/** Status and failure come only from the RPC read of txHash. The wallet raw body is ignored. */
export async function finishTx(sent, signer, gate) {
  const txHash = sent?.txHash || null;
  if (!txHash || !signer) return { ok: null, txHash, unconfirmed: true };
  let probed;
  try {
    probed = await probeTxStatus(txHash, signer);
  } catch {
    return { ok: null, txHash, unconfirmed: true };
  }
  const attempts = (probed?.attempts || []).map(toAttempt);
  const decision = decideOutcome({ attempts, effect: null, action: "other", isScheduledLast: false });
  if (decision.outcome === "failed") {
    const parsed = txOutcome({ txHash, raw: attemptBody(probed, true) || {} }, gate);
    return { ok: false, txHash, panic: parsed.panic || "", reasonCode: parsed.reasonCode || "", unconfirmed: false };
  }
  if (decision.outcome === "success") return txOutcome({ txHash, raw: attemptBody(probed, false) || {} }, gate);
  return { ok: null, txHash, unconfirmed: true };
}

export async function probeOutcome(txHash, signer) {
  if (!txHash || !signer) return { attempts: [], anyAnswered: false };
  try {
    const probed = await probeTxStatus(txHash, signer);
    const attempts = (probed?.attempts || []).map(toAttempt);
    return { attempts, anyAnswered: attempts.some((row) => row.answered) };
  } catch {
    return { attempts: [], anyAnswered: false };
  }
}

/**
 * Owner actions call this before a wallet window opens.
 * reason is an i18n key. Check order: wallet, code hash, factory suffix, then exact gate_account_for.
 * An empty wallet fails closed. The gate id must equal gate_account_for(walletId), so a nested name does not pass.
 */
export async function verifyGateForOwner(gateId, walletId) {
  const id = String(gateId || "").trim();
  const owner = String(walletId || "").trim();
  if (!owner) return { ok: false, reason: "funds.needWallet" };
  let account = null;
  try {
    account = await accountOf(id, { fresh: true });
  } catch (error) {
    return { ok: false, reason: error?.kind === "rate" ? "state.rate" : "state.fail" };
  }
  const hash = account?.code_hash ? String(account.code_hash) : "";
  if (hash !== TESTNET.gateCodeHash) return { ok: false, reason: "gate.badCode" };
  if (!id.endsWith("." + TESTNET.factoryAccountId)) return { ok: false, reason: "gate.notFactory" };
  let expected = "";
  try {
    expected = await gateAccountFor(owner);
  } catch (error) {
    return { ok: false, reason: error?.kind === "rate" ? "state.rate" : "state.fail" };
  }
  if (id !== String(expected || "")) return { ok: false, reason: "gate.notYours" };
  return { ok: true, reason: "" };
}

export { clearCache, hex };
