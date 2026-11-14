import { TESTNET } from "./network.mjs";
import { stringifyCallArgs } from "./format.mjs";
import { confirmHostPair, probeErrorKind } from "./confirm.mjs";

const VIEW_TTL = 15000;
const HISTORY_TTL = 60000;
const COOL_MS = 20000;
const MAX_INFLIGHT = 4;
const memory = new Map();
const inflight = new Map();
const coolUntil = new Map();
const finals = new Map();
let active = 0;
const waiters = [];

function now() { return Date.now(); }

function cooled(host) { return (coolUntil.get(host) || 0) > now(); }

function punish(host) { coolUntil.set(host, now() + COOL_MS); }

function acquire() {
  if (active < MAX_INFLIGHT) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => { waiters.push(resolve); });
}

function release() {
  active -= 1;
  const next = waiters.shift();
  if (next) {
    active += 1;
    next();
  }
}

function cacheGet(key, ttl) {
  const hit = memory.get(key);
  if (hit && now() - hit.t < ttl) return hit.v;
  try {
    const raw = sessionStorage.getItem("cg.cache." + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (now() - parsed.t < ttl) {
      memory.set(key, parsed);
      return parsed.v;
    }
  } catch { /* private mode or bad json: skip the cache */ }
  return null;
}

function cacheSet(key, value) {
  const row = { t: now(), v: value };
  memory.set(key, row);
  try { sessionStorage.setItem("cg.cache." + key, JSON.stringify(row)); } catch { /* quota */ }
}

function finalKey(hash) { return "cg.final." + hash; }

export function readFinal(hash) {
  if (!hash) return null;
  if (finals.has(hash)) return finals.get(hash);
  try {
    const raw = sessionStorage.getItem(finalKey(hash));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    finals.set(hash, parsed);
    return parsed;
  } catch { return null; }
}

function writeFinal(hash, value) {
  if (!hash || value == null) return;
  finals.set(hash, value);
  try { sessionStorage.setItem(finalKey(hash), JSON.stringify(value)); } catch { /* quota */ }
}

export function isFinalStatus(result) {
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

export function rpcError(kind, message, extra) {
  const error = new Error(message || kind);
  error.kind = kind;
  if (extra) error.extra = extra;
  return error;
}

function archivalSet() {
  return new Set(TESTNET.archivalRpc || []);
}

/** EXPERIMENTAL_tx_status: FastNear archival first, then one other archival host. */
function archivalPair() {
  const listed = (TESTNET.archivalRpc || []).filter(Boolean);
  const fast = listed.find((host) => host.includes("fastnear.com"));
  const ordered = [];
  if (fast) ordered.push(fast);
  for (const host of listed) if (!ordered.includes(host)) ordered.push(host);
  const live = ordered.filter((host) => !cooled(host));
  if (!live.length) return [];
  const first = live[0];
  const second = live.find((host) => host !== first);
  return second ? [first, second] : [first];
}

function hostPair() {
  const live = (TESTNET.rpc || []).filter((host) => host && !cooled(host));
  if (!live.length) return [];
  const archival = archivalSet();
  const regular = live.filter((host) => !archival.has(host));
  const first = regular[0] || live[0];
  const second = live.find((host) => host !== first && archival.has(host)) || live.find((host) => host !== first);
  return second ? [first, second] : [first];
}

const PROBE_TIMEOUT_MS = 10000;

function onceLimited(host, method, params) {
  let timer = 0;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(rpcError("timeout", "timeout")), PROBE_TIMEOUT_MS);
  });
  return Promise.race([once(host, method, params), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Read one tx by hash from the primary RPC, then the configured fallback.
 * A final status stops the pair. UNKNOWN_TRANSACTION is miss. Timeouts and network errors are unread.
 */
export async function probeTxStatus(txHash, accountId) {
  const hosts = confirmHostPair(TESTNET.rpc, TESTNET.archivalRpc);
  const attempts = [];
  for (let i = 0; i < hosts.length; i += 1) {
    const host = hosts[i];
    let attempt;
    try {
      const result = await onceLimited(host, "EXPERIMENTAL_tx_status", {
        tx_hash: txHash,
        sender_account_id: accountId,
        wait_until: "NONE",
      });
      attempt = { host, answered: true, miss: false, result };
    } catch (error) {
      const kind = probeErrorKind(error);
      attempt = {
        host,
        answered: kind === "miss" || error?.kind === "rpc",
        miss: kind === "miss",
        result: null,
        kind: kind === "miss" ? "miss" : (error?.kind || "network"),
      };
    }
    attempts.push(attempt);
    if (attempt.result && isFinalStatus(attempt.result)) break;
  }
  return { attempts };
}

async function once(host, method, params) {
  const response = await fetch(host, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "cg", method, params }),
  });
  if (response.status === 429) {
    punish(host);
    throw rpcError("rate", "429");
  }
  if (!response.ok) {
    punish(host);
    throw rpcError("network", "http " + response.status);
  }
  const json = await response.json();
  if (json.error) {
    const text = JSON.stringify(json.error);
    if (/UNKNOWN_TRANSACTION|unknown transaction|does not exist|hasn't been found/i.test(text)) {
      throw rpcError("miss", text);
    }
    throw rpcError("rpc", text);
  }
  return json.result;
}

async function callHosts(method, params, preferred) {
  const hosts = preferred && preferred.length ? preferred : hostPair();
  if (!hosts.length) throw rpcError("rate", "429");
  try {
    return await once(hosts[0], method, params);
  } catch (error) {
    if (error?.kind === "rpc" || !hosts[1]) throw error?.kind ? error : rpcError("network", String(error?.message || error));
    try {
      return await once(hosts[1], method, params);
    } catch (second) {
      if (error?.kind === "rate" || second?.kind === "rate") throw rpcError("rate", "429");
      throw second?.kind ? second : rpcError("network", String(second?.message || second));
    }
  }
}

export async function rpcCall(method, params, { ttl = VIEW_TTL, cacheKey, hosts } = {}) {
  const key = cacheKey || `${method}:${JSON.stringify(params)}`;
  if (ttl > 0) {
    const cached = cacheGet(key, ttl);
    if (cached != null) return cached;
  }
  if (inflight.has(key)) return inflight.get(key);
  const task = (async () => {
    await acquire();
    try {
      const result = await callHosts(method, params, hosts);
      if (ttl > 0) cacheSet(key, result);
      return result;
    } finally { release(); }
  })();
  inflight.set(key, task);
  try { return await task; } finally { inflight.delete(key); }
}

function bytesToString(result) {
  const bytes = result?.result;
  if (!bytes) return "";
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

export async function viewAccount(accountId, { fresh = false } = {}) {
  return rpcCall("query", {
    request_type: "view_account",
    finality: "final",
    account_id: accountId,
  }, { cacheKey: `acct:${accountId}`, ttl: fresh ? 0 : VIEW_TTL });
}

export async function viewAccessKeys(accountId, { fresh = false } = {}) {
  return rpcCall("query", {
    request_type: "view_access_key_list",
    finality: "final",
    account_id: accountId,
  }, { cacheKey: `keys:${accountId}`, ttl: fresh ? 0 : VIEW_TTL });
}

export async function viewCall(accountId, methodName, args = {}, options = {}) {
  const fresh = options?.fresh === true;
  const args_base64 = btoa(stringifyCallArgs(args));
  const result = await rpcCall("query", {
    request_type: "call_function",
    finality: "final",
    account_id: accountId,
    method_name: methodName,
    args_base64,
  }, { cacheKey: `view:${accountId}:${methodName}:${args_base64}`, ttl: fresh ? 0 : VIEW_TTL });
  const text = bytesToString(result);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

export async function txStatus(txHash, accountId, { fresh = false, waitUntil = "NONE" } = {}) {
  if (!fresh) {
    const saved = readFinal(txHash);
    if (saved) return { result: saved, source: "recorded" };
  }
  const result = await rpcCall("EXPERIMENTAL_tx_status", {
    tx_hash: txHash,
    sender_account_id: accountId,
    wait_until: waitUntil,
  }, { ttl: 0, cacheKey: `tx:${txHash}`, hosts: archivalPair() });
  // Optimistic execution is not final. Cache only a FINAL wait, or a body that says FINAL.
  if (waitUntil === "FINAL" || result?.final_execution_status === "FINAL") writeFinal(txHash, result);
  return { result, source: "live" };
}

export async function postIndexer(accountId, { limit = 8 } = {}) {
  const key = `idx:${accountId}:${limit}`;
  const cached = cacheGet(key, HISTORY_TTL);
  if (cached) return cached;
  if (inflight.has(key)) return inflight.get(key);
  const host = TESTNET.txIndexer;
  const task = (async () => {
    await acquire();
    try {
      if (cooled(host)) throw rpcError("rate", "429");
      let response;
      try {
        response = await fetch(host, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            account_id: accountId,
            is_receiver: true,
            is_function_call: true,
            limit,
            desc: true,
          }),
        });
      } catch {
        punish(host);
        throw rpcError("indexer", "indexer unreachable");
      }
      if (response.status === 429) { punish(host); throw rpcError("rate", "429"); }
      if (!response.ok) { punish(host); throw rpcError("indexer", "indexer " + response.status); }
      const json = await response.json();
      if (!Array.isArray(json.account_txs)) throw rpcError("indexer", "indexer shape");
      cacheSet(key, json);
      return json;
    } finally { release(); }
  })();
  inflight.set(key, task);
  try { return await task; } finally { inflight.delete(key); }
}

export function isRate(error) { return error?.kind === "rate"; }

export function clearCache() {
  memory.clear();
  inflight.clear();
  try {
    const keys = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key && key.startsWith("cg.cache.")) keys.push(key);
    }
    for (const key of keys) sessionStorage.removeItem(key);
  } catch { /* private mode */ }
}
