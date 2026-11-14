/** Pure tx-log helpers. No browser globals, so Node tests can import this file. */

const U64_MAX = 18446744073709551615n;

/**
 * True when value is a decimal integer in 0..2^64-1.
 * A JSON number that is not a safe integer is not an exact decimal, so it is false
 * unless the caller already replaced it with the digit string from the log.
 */
export function isU64(value) {
  let n;
  if (typeof value === "bigint") n = value;
  else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return false;
    n = BigInt(value);
  } else if (typeof value === "string") {
    const text = value.trim();
    if (!/^(0|[1-9]\d*)$/.test(text)) return false;
    n = BigInt(text);
  } else return false;
  return n >= 0n && n <= U64_MAX;
}

function quoteNonceDigits(fragment) {
  return fragment.replace(/("nonce"\s*:\s*)(0|[1-9]\d*)(?=\s*[,}\]])/g, '$1"$2"');
}

/** EVENT_JSON rows whose executor_id is the gate and whose standard is chopgate. */
export function eventsFromStatus(status, gate) {
  const lines = [];
  const take = (outcome) => {
    if (!outcome || outcome.executor_id !== gate) return;
    for (const line of outcome.logs || []) lines.push(line);
  };
  take(status?.transaction_outcome?.outcome);
  for (const row of status?.receipts_outcome || []) take(row?.outcome);
  const events = [];
  for (const line of lines) {
    const at = line.indexOf("EVENT_JSON:");
    if (at < 0) continue;
    try {
      const fragment = quoteNonceDigits(line.slice(at + "EVENT_JSON:".length));
      const json = JSON.parse(fragment);
      if (json.standard !== "chopgate") continue;
      const data = Array.isArray(json.data) ? json.data : [json.data];
      for (const item of data) {
        const row = item && typeof item === "object" ? item : {};
        if (row.nonce != null && !isU64(row.nonce)) continue;
        events.push({ event: json.event || "", data: row });
      }
    } catch { /* a non-json log is not a row */ }
  }
  return events;
}

function u64Value(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  return BigInt(String(value).trim());
}

/** Highest escrow_withdraw nonce. Nonces outside u64 are ignored. 0n when none. */
export function maxWithdrawNonce(rows) {
  let max = 0n;
  for (const row of rows || []) {
    for (const event of row.events || []) {
      if (event.event !== "escrow_withdraw" || event.data?.nonce == null) continue;
      if (!isU64(event.data.nonce)) continue;
      const nonce = u64Value(event.data.nonce);
      if (nonce > max) max = nonce;
    }
  }
  return max;
}
