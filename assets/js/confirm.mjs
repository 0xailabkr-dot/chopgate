/**
 * Pure confirmation decisions. No DOM and no network.
 * A transaction is failed only when a final RPC status has Failure.
 * Wallet errors, timeouts, and unread receipts stay unconfirmed.
 */

export const REREAD_MS = Object.freeze([5000, 15000, 30000]);
export const SILENT_MS = 120000;

export function isLastReadIndex(index) {
  return index === REREAD_MS.length - 1;
}

/** Indexes whose delay has elapsed since the send. */
export function readDue(elapsedMs) {
  const due = [];
  const elapsed = Number(elapsedMs) || 0;
  for (let i = 0; i < REREAD_MS.length; i += 1) {
    if (elapsed >= REREAD_MS[i]) due.push(i);
  }
  return due;
}

export function isFinalOutcome(result) {
  if (!result || typeof result !== "object") return false;
  const fin = result.final_execution_status;
  // EXECUTED_OPTIMISTIC is not final: the block holding the outcome can still be dropped.
  if (fin === "EXECUTED" || fin === "FINAL") return true;
  if (fin !== undefined && fin !== null) return false;
  const status = result.status;
  if (!status || typeof status !== "object") return false;
  if (status.Unknown) return false;
  return "SuccessValue" in status || "Failure" in status || "SuccessReceiptId" in status;
}

export function hasFailure(status) {
  if (!status || typeof status !== "object") return false;
  const parts = [status.status, status.transaction_outcome?.outcome?.status];
  const rows = status.receipts_outcome || [];
  for (let i = 0; i < rows.length; i += 1) parts.push(rows[i]?.outcome?.status);
  return parts.some((value) => value && typeof value === "object" && value.Failure != null);
}

export function probeErrorKind(error) {
  // Only a tx-specific "not found" answer counts as a miss; "account does not exist" does not.
  const text = String(error?.message || "");
  if (/UNKNOWN_TRANSACTION|unknown transaction|hasn't been found/i.test(text)) return "miss";
  return "unread";
}

/** One host result -> { answered, miss, final, failure, success }. */
export function toAttempt(probe) {
  if (!probe) return { answered: false, miss: false, final: false, failure: false, success: false };
  if (probe.miss || probe.kind === "miss") {
    return { answered: true, miss: true, final: false, failure: false, success: false };
  }
  if (!probe.result) {
    return { answered: probe.answered === true, miss: false, final: false, failure: false, success: false };
  }
  const final = isFinalOutcome(probe.result);
  const failure = final && hasFailure(probe.result);
  return { answered: true, miss: false, final, failure, success: final && !failure };
}

/**
 * Primary host is rpc[0]. Fallback is rpc[1], or the first archival host when rpc[1] is absent.
 */
export function confirmHostPair(rpc, archivalRpc) {
  const list = Array.isArray(rpc) ? rpc.filter(Boolean) : [];
  const archival = Array.isArray(archivalRpc) ? archivalRpc.filter(Boolean) : [];
  const primary = list[0] || "";
  const second = list[1] || archival[0] || "";
  const hosts = [];
  if (primary) hosts.push(primary);
  if (second && second !== primary) hosts.push(second);
  return hosts;
}

function amountText(value) {
  if (value && typeof value === "object" && value.value != null) return String(value.value);
  return value == null ? "" : String(value);
}

function asBig(value) {
  if (value == null || value === "") return null;
  if (typeof value === "bigint") return value;
  if (typeof value === "object" && value.value != null) return asBig(value.value);
  const text = String(value).trim();
  if (!/^-?\d+$/.test(text)) return null;
  try { return BigInt(text); } catch { return null; }
}

/** True when escrow grew by exactly the sent amount. Null when an input is missing. */
export function depositLanded(before, sent, after) {
  const start = asBig(before);
  const amount = asBig(sent);
  const end = asBig(after);
  if (start == null || amount == null || end == null) return null;
  if (amount <= 0n) return false;
  return end - start === amount;
}

function listText(value) {
  return (Array.isArray(value) ? value : []).map((item) => String(item).trim()).filter(Boolean);
}

function payeeText(value) {
  return JSON.stringify((Array.isArray(value) ? value : []).map((row) => ({
    alias: String(row?.alias || ""),
    account: String(row?.account || ""),
  })));
}

export function rulesEqual(view, sent) {
  if (!view || !sent || typeof view !== "object" || typeof sent !== "object") return false;
  if (view.rules_nonce != null && sent.rules_nonce != null && String(view.rules_nonce) !== String(sent.rules_nonce)) return false;
  return !!view.enabled === !!sent.enabled
    && amountText(view.per_tx_limit) === amountText(sent.per_tx_limit)
    && amountText(view.per_day_limit) === amountText(sent.per_day_limit)
    && Number(view.max_tx_per_day) === Number(sent.max_tx_per_day)
    && Number(view.tz_offset_min || 0) === Number(sent.tz_offset_min || 0)
    && Number(view.window_start_min || 0) === Number(sent.window_start_min || 0)
    && Number(view.window_end_min || 0) === Number(sent.window_end_min || 0)
    && Number(view.jev_threshold_permille) === Number(sent.jev_threshold_permille)
    && !!view.jev_required === !!sent.jev_required
    && listText(view.allowed_categories).join(",") === listText(sent.allowed_categories).join(",")
    && payeeText(view.payees) === payeeText(sent.payees);
}

export function tier2Equal(view, sent) {
  if (!view || !sent || typeof view !== "object" || typeof sent !== "object") return false;
  if (view.config_nonce != null && sent.config_nonce != null && String(view.config_nonce) !== String(sent.config_nonce)) return false;
  return amountText(view.amount_threshold) === amountText(sent.amount_threshold)
    && String(view.pending_ttl_ns) === String(sent.pending_ttl_ns)
    && !!view.new_payee_check === !!sent.new_payee_check
    && JSON.stringify(listText(view.trusted_sources)) === JSON.stringify(listText(sent.trusted_sources))
    && JSON.stringify(listText(view.known_payees)) === JSON.stringify(listText(sent.known_payees))
    && JSON.stringify(listText(view.denied_targets)) === JSON.stringify(listText(sent.denied_targets));
}

/**
 * action "create" confirms from the gate effect, and from a final success status only on the 30s read.
 * "deposit" and "rules" confirm from the effect or from a final success status.
 * Any other action confirms from the tx status only.
 * Failure always wins. Both hosts reporting UNKNOWN_TRANSACTION counts as absent only on the 30s read.
 */
export function decideOutcome({ attempts = [], effect = null, action = "other", isScheduledLast = false } = {}) {
  const rows = Array.isArray(attempts) ? attempts : [];
  const anyAnswered = rows.some((row) => row && row.answered);
  const failure = rows.some((row) => row && row.failure);
  const success = rows.some((row) => row && row.success);
  const bothMiss = rows.length >= 2 && rows.every((row) => row && row.miss);
  if (failure) return { outcome: "failed", locked: false, anyAnswered: true, absent: false };
  const effectAction = action === "create" || action === "deposit" || action === "rules";
  if (effect === true && effectAction) return { outcome: "success", locked: false, anyAnswered: true, absent: false, via: "effect" };
  if (success && action !== "create") return { outcome: "success", locked: false, anyAnswered: true, absent: false, via: "status" };
  if (success && action === "create" && isScheduledLast) return { outcome: "success", locked: false, anyAnswered: true, absent: false, via: "status" };
  if (isScheduledLast && bothMiss) return { outcome: "absent", locked: false, anyAnswered: true, absent: true };
  return { outcome: "unconfirmed", locked: true, anyAnswered, absent: false };
}

export function lockView({ outcome = "unconfirmed", elapsedMs = 0, anyRpcAnswered = false, overrideUsed = false } = {}) {
  if (overrideUsed || outcome === "success" || outcome === "failed" || outcome === "absent" || outcome === "cancelled") {
    return { locked: false, offerOverride: false };
  }
  const offerOverride = anyRpcAnswered !== true && Number(elapsedMs) >= SILENT_MS;
  return { locked: true, offerOverride };
}

/** Balance checks are local. Every other non-cancel send error stays unconfirmed. */
export function classifySendError(error, cancelled) {
  if (cancelled) return { outcome: "cancelled", locked: false };
  if (error?.kind === "balance") return { outcome: "failed", locked: false, kind: "balance" };
  if (error && error.walletOpened !== true && !error.txHash) return { outcome: "notsent", locked: false };
  return { outcome: "unconfirmed", locked: true };
}

export function partialRulesKey(outcome) {
  if (outcome === "unconfirmed") return "rules.partialUnconfirmed";
  return "rules.partial";
}
