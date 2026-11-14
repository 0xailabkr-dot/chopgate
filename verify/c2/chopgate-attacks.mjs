// ChopGate "break it with your wallet" — four attack buttons against the Run C testnet contract.
// The visitor's wallet signs and sends every transaction. Forged owner signatures (attacks 2 and 4)
// come from a throwaway ed25519 key made in this tab; it is never stored. No key is in this file.
//
// The FunctionCall is built inside runAttack, on the click, immediately before signAndSendTransaction.
// There is no prepared-call cache.
import * as E from "./chopgate-encode.mjs";

export const RUNC = Object.freeze({
  network: "testnet",
  contract: "gatec.chopgate-runc-cc790216.testnet",
  payee: "payeec.chopgate-runc-cc790216.testnet",
  decoySerial: 900,
  unknownSerial: 777777,
  fakeSerial: 4242,
  action: "transfer",
  instruction: "ChopGate live demo attack",
  amount: "1000000000000000000000",
  gas: "30000000000000",
  rpc: [
    "https://test.rpc.fastnear.com",
    "https://archival-rpc.testnet.fastnear.com",
    "https://rpc.testnet.near.org",
    "https://archival-rpc.testnet.near.org",
  ],
  explorer: (tx) => `https://testnet.nearblocks.io/txns/${tx}`,
});

export const FACTORY_ACCOUNT = "cg-u1f-fdf59d31.testnet";
export const GAS_MARGIN_NEAR = "0.02";
export const FALLBACK_TOTAL_NEAR = "5.6";

/* Non-display codes. Screen sentences live in i18n and are painted by try.js. */
export const NOTE_FORGED = "forged";
export const NOTE_DECOY = "decoy";
export const NOTE_SHARED = "shared";
export const NO_OPEN_HOLD = "no_open_hold";
export const ESCROW_UNAVAILABLE = "escrow_unavailable";
export const RESOLVED_NOTE = "resolved";
export const RECORDED_WRONG_CALLER = "JBnAvnB9R5SYs9BnGq9ABt69h5GvumaDhwBoWgKLoY6g";
export const RECORDED_HOLDS = Object.freeze([
  "Bz2AeYTguoAGq4YzCghHKRdt7TT2XBoym9x6GJjk8MYo",
  "HmM5ereopPwUtUroBbhnwN4rrMRgtE7JLAJKcvtWtEZw",
  "8Df3tAZMMm3nSVAPmxhyot7jwNW6n739rySEVfeJnXaL",
  "5BRvbZWqfD7Ant4ocViiWBSdx4ioQccmkGHsXWdYrwAb",
]);
export const RECORDED_ATTACK4 = Object.freeze([
  "FHt1Ccd2QMm7LoKSQRPQ4zRJVWWUVy1Z1w6WQwM9EsTh",
  "4vA7vayt4oR6MEvcabZbNcBNo9t4kfJfDiyydbr2AuVX",
]);

function yoctoNear(amount) {
  let raw = amount;
  if (raw && typeof raw === "object") raw = raw.amount ?? raw.value ?? "0";
  const s = String(raw ?? "0");
  if (!/^\d+$/.test(s) || s === "0") return "0";
  const pad = s.padStart(25, "0");
  const whole = pad.slice(0, -24).replace(/^0+(?=\d)/, "");
  const frac = pad.slice(-24).replace(/0+$/, "");
  return frac ? whole + "." + frac : whole;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_TOKEN = new RegExp(`(?:^|[^${B58}])([${B58}]{43,44})(?![${B58}])`, "g");
const HASH_KEYWORD = /transaction|\btx\b|hash|transaction\s*id/i;
const HOST_COOLDOWN_MS = 60000;
const downUntil = new Map();

function aliveHosts() {
  const now = Date.now();
  return RUNC.rpc.filter((url) => (downUntil.get(url) || 0) <= now);
}

function cool(url) {
  downUntil.set(url, Date.now() + HOST_COOLDOWN_MS);
}

function hostFailure(err) {
  const msg = String(err && (err.message || err) || "");
  return /429|408|CORS|Failed to fetch|NetworkError|network|abort|timed out|HTTP 5|HTTP 429/i.test(msg);
}

async function rpcOnce(url, method, params) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "cg", method, params }),
      signal: ctrl.signal,
    });
    if (r.status === 429 || r.status >= 500) {
      cool(url);
      throw new Error("RPC HTTP " + r.status);
    }
    if (!r.ok) throw new Error("RPC HTTP " + r.status);
    const j = await r.json();
    if (j.error) {
      const err = new Error("RPC " + (j.error.name || "error"));
      err.logical = true;
      throw err;
    }
    return j.result;
  } catch (e) {
    if (e && e.name === "AbortError") {
      cool(url);
      throw new Error("RPC timed out");
    }
    if (hostFailure(e)) cool(url);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function rpc(method, params) {
  const hosts = aliveHosts();
  if (!hosts.length) throw new Error("rpc-unavailable");
  let last;
  for (const url of hosts) {
    try {
      return await rpcOnce(url, method, params);
    } catch (e) {
      last = e;
    }
  }
  throw last || new Error("rpc-unavailable");
}

export async function viewOn(url, method, args = {}, at = { finality: "final" }) {
  const r = await rpcOnce(url, "query", {
    request_type: "call_function",
    ...at,
    account_id: RUNC.contract,
    method_name: method,
    args_base64: btoa(JSON.stringify(args)),
  });
  if (r.error || !r.result) throw new Error(`view ${method}: ${r.error ?? "no result"}`);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result)));
}

export async function view(method, args = {}, at = { finality: "final" }) {
  const hosts = aliveHosts();
  if (!hosts.length) throw new Error("rpc-unavailable");
  let last;
  for (const url of hosts) {
    try {
      return await viewOn(url, method, args, at);
    } catch (e) {
      last = e;
    }
  }
  throw last || new Error("rpc-unavailable");
}

async function balanceOn(url, id, at) {
  const r = await rpcOnce(url, "query", { request_type: "view_account", ...at, account_id: id });
  if (!r || r.amount == null) throw new Error("no balance");
  return r.amount;
}

async function readSnapshotOnce(url) {
  const block = await rpcOnce(url, "block", { finality: "final" });
  const height = block && block.header && block.header.height;
  if (height == null) throw new Error("no block");
  const at = { block_id: height };
  const [escrow, counters, pending, payee] = await Promise.all([
    viewOn(url, "escrow_balance", {}, at),
    viewOn(url, "block_counters", {}, at),
    viewOn(url, "pending_items", {}, at),
    balanceOn(url, RUNC.payee, at),
  ]);
  return {
    height,
    escrow,
    counters,
    pendingIds: (pending || []).map((p) => p.id),
    pending,
    payeeBalance: payee,
    rpc: url,
  };
}

// One RPC URL for every read in a snapshot. A flaky read retries that same URL once.
// A 429 or a network failure cools that host and the next attempt uses another URL.
async function readSnapshotPinned(url) {
  try {
    return await readSnapshotOnce(url);
  } catch (e) {
    if (hostFailure(e)) throw e;
    return await readSnapshotOnce(url);
  }
}

export async function snapshot() {
  const hosts = aliveHosts();
  if (!hosts.length) throw new Error("rpc-unavailable");
  let last;
  for (const url of hosts) {
    try {
      return await readSnapshotPinned(url);
    } catch (e) {
      last = e;
      if (hostFailure(e)) cool(url);
    }
  }
  throw last || new Error("rpc-unavailable");
}

export async function listOpenHolds() {
  const items = await view("pending_items");
  return Array.isArray(items) ? items : [];
}

function scrub(value) {
  return String(value ?? "")
    .replace(/ed25519:[1-9A-HJ-NP-Za-km-z]+/g, "ed25519:[redacted]")
    .replace(/\b[0-9a-f]{64,}\b/gi, "[redacted]")
    .slice(0, 400);
}

async function throwawaySign(ed, payload, domain) {
  const sk = crypto.getRandomValues(new Uint8Array(32));
  try {
    const pub = "ed25519:" + E.b58encode(await ed.getPublicKeyAsync(sk));
    const msg = E.authorizationBytes(domain.chain, domain.deployment, domain.ownerOverride ?? pub, payload);
    return { pub, sig: E.hex(await ed.signAsync(msg, sk)) };
  } finally {
    sk.fill(0);
  }
}

const fc = (methodName, args) => ({ type: "FunctionCall", params: { methodName, args, gas: RUNC.gas, deposit: "0" } });
const payArgs = (serial) => ({
  serial,
  action: RUNC.action,
  target: RUNC.payee,
  amount: RUNC.amount,
  instruction: RUNC.instruction,
  source: "owner_chat",
  judge_hint: "pass",
});

function attack4Blocked(err) {
  const wrapped = new Error(err && err.message ? String(err.message) : "rpc-unavailable");
  wrapped.attack4Blocked = true;
  return wrapped;
}

export async function buildAttack(n, visitor, ed) {
  if (n === 1) return { label: "Pay without a mandate", action: fc("authorize_and_pay_tiered", payArgs(RUNC.unknownSerial)), expect: ["unknown_mandate"] };
  if (n === 3) return { label: "Pay on someone else's mandate (#900)", action: fc("authorize_and_pay_tiered", payArgs(RUNC.decoySerial)), expect: ["wrong_caller", "auto_frozen"], note: NOTE_DECOY };
  if (n === 2) {
    const [chain, deployment] = await view("signature_domain");
    const ih = await E.sha256hex(RUNC.instruction);
    const mandate = {
      serial: RUNC.fakeSerial,
      agent: visitor,
      entries: [{ action: RUNC.action, target: RUNC.payee, max_amount: RUNC.amount, instruction_hash: ih }],
      budget: RUNC.amount,
      expires_at: 4000000000000000000,
      parent_serial: null,
    };
    const { pub, sig } = await throwawaySign(ed, E.signingBytes(RUNC.contract, mandate), { chain, deployment });
    return { label: "Register a mandate signed with a throwaway key (fake owner)", action: fc("register", { mandate, signer_public_key: pub, signature: sig }), expect: ["owner_impersonation"], note: NOTE_FORGED };
  }
  if (n === 4) {
    const label = "Approve a held payment with a throwaway key";
    let chain;
    let deployment;
    let ownerPk;
    let items;
    try {
      const domain = await view("signature_domain");
      chain = domain[0];
      deployment = domain[1];
      ownerPk = domain[2];
      const listed = await view("pending_items");
      items = Array.isArray(listed) ? listed : [];
    } catch (e) {
      throw attack4Blocked(e);
    }
    try {
      let id;
      let requestHash;
      let requestedAmount = "";
      const open = items.length > 0;
      if (!open) {
        // Call argument only. The preview must not show this as a hold number.
        id = 1;
        requestHash = new Uint8Array(32);
      } else {
        const item = items[0];
        id = item.id;
        requestHash = await E.pendingRequestHash(item);
        const raw = item.amount;
        if (raw && typeof raw === "object") requestedAmount = String(raw.value ?? raw.amount ?? "");
        else if (raw != null) requestedAmount = String(raw);
      }
      const payload = E.pendingDecisionV2Bytes(RUNC.contract, id, true, requestHash);
      const { sig } = await throwawaySign(ed, payload, { chain, deployment, ownerOverride: ownerPk });
      return {
        label: open ? `Approve held payment #${id} with a throwaway key` : label,
        action: fc("approve_pending", { id, signature: sig }),
        expect: open ? ["invalid pending signature"] : ["unknown or resolved pending"],
        note: NOTE_FORGED,
        pendingId: open ? id : "",
        noOpenHold: !open,
        requestedAmount,
      };
    } catch (e) {
      throw attack4Blocked(e);
    }
  }
  throw new Error("attack 1..4");
}

function yoctoField(value) {
  if (value == null) return "";
  if (typeof value === "object") {
    const inner = value.value ?? value.amount;
    return inner == null ? "" : String(inner);
  }
  return String(value);
}

/** Display fields for the line shown before the wallet opens. Does not change the action. */
export function describeAttack(built) {
  const params = built && built.action && built.action.params ? built.action.params : {};
  const args = params.args || {};
  let requested = "";
  if (args.amount != null) requested = yoctoField(args.amount);
  else if (args.mandate && args.mandate.budget != null) requested = yoctoField(args.mandate.budget);
  else if (built && built.requestedAmount) requested = yoctoField(built.requestedAmount);
  const attached = params.deposit == null ? "0" : String(params.deposit);
  const noOpenHold = !!(built && built.noOpenHold);
  return {
    method: String(params.methodName || ""),
    contract: RUNC.contract,
    attachedNear: yoctoNear(attached),
    requestedNear: requested ? yoctoNear(requested) : "",
    holdId: noOpenHold ? "" : (built && built.pendingId != null && built.pendingId !== "" ? String(built.pendingId) : ""),
    noOpenHold,
  };
}

export function readOutcome(o) {
  const tx = o?.transaction?.hash ?? o?.transaction_outcome?.id;
  const st = o?.status ?? {};
  if ("SuccessValue" in st) {
    let d = null;
    try { d = JSON.parse(atob(st.SuccessValue)); } catch { /* not json */ }
    const code = d?.reason_code || "";
    // Decision.amount is the requested amount. A refusal still carries it and transfers nothing.
    let verdictKind = "unknown";
    if (code === "allowed") verdictKind = "paid";
    else if (code === "tier2_escalate") verdictKind = "held";
    else if (code) verdictKind = "refused";
    const paidNear = verdictKind === "paid" ? yoctoNear(d?.amount) : "0";
    return { tx, txSuccess: true, verdictKind, reason: code, paidNear };
  }
  if (!("Failure" in st)) return { tx, txSuccess: null, verdictKind: "unknown", reason: "", paidNear: null };
  const find = (x) => (x && typeof x === "object") ? (typeof x.ExecutionError === "string" ? x.ExecutionError : Object.values(x).map(find).find(Boolean)) : null;
  const raw = find(st.Failure) ?? JSON.stringify(st.Failure);
  const known = ["invalid pending signature", "unknown or resolved pending"].find((k) => raw.includes(k));
  const verdictKind = known === "unknown or resolved pending" ? "resolved" : "failed";
  return { tx, txSuccess: false, verdictKind, reason: known || "", paidNear: "0", rawError: scrub(raw) };
}

export function extractTxHash(message) {
  const text = String(message ?? "");
  const tokens = [];
  B58_TOKEN.lastIndex = 0;
  let m;
  while ((m = B58_TOKEN.exec(text))) {
    const hash = m[1];
    const index = m.index + m[0].indexOf(hash);
    const prefix = text.slice(Math.max(0, index - "ed25519:".length), index);
    if (prefix === "ed25519:") continue;
    tokens.push({ hash, index });
  }
  if (!tokens.length) return null;
  const window = 96;
  const near = tokens.find((t) => HASH_KEYWORD.test(text.slice(Math.max(0, t.index - window), t.index + t.hash.length + window)));
  return (near || tokens[tokens.length - 1]).hash;
}

export const MIN_SEND_YOCTO = 3000000000000000000000n;

export async function accountBalance(accountId) {
  const result = await rpc("query", {
    request_type: "view_account",
    finality: "final",
    account_id: accountId,
  });
  if (!result || result.amount == null) throw new Error("no balance");
  return String(result.amount);
}

function nearStringToYocto(raw) {
  const m = /^(\d+)(?:\.(\d{1,24}))?$/.exec(String(raw == null ? "" : raw).trim());
  if (!m) return null;
  const frac = (m[2] || "").padEnd(24, "0");
  return BigInt(m[1]) * (10n ** 24n) + BigInt(frac);
}

export function formatDepositNear(yocto) {
  let raw;
  try { raw = BigInt(String(yocto).trim()); } catch (e) { return null; }
  if (raw < 0n) return null;
  const whole = raw / (10n ** 24n);
  const digits = (raw % (10n ** 24n)) / (10n ** 19n);
  if (digits === 0n) return whole.toString();
  const frac = digits.toString().padStart(5, "0").replace(/0+$/, "");
  return whole.toString() + "." + frac;
}

export function formatGateTotal(yocto) {
  let raw;
  try { raw = BigInt(String(yocto).trim()); } catch (e) { return null; }
  if (raw < 0n) return null;
  const margin = nearStringToYocto(GAS_MARGIN_NEAR);
  if (margin == null) return null;
  const cent = 10n ** 22n;
  const cents = (raw + margin + cent - 1n) / cent;
  const frac = (cents % 100n).toString().padStart(2, "0");
  return (cents / 100n).toString() + "." + frac;
}

function viewBytesToYocto(result) {
  if (!result || result.result == null) return null;
  let text;
  try {
    text = new TextDecoder().decode(new Uint8Array(result.result));
  } catch (e) {
    return null;
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { return null; }
  if (typeof parsed !== "string" || !/^\d+$/.test(parsed)) return null;
  return parsed;
}

// required_deposit is current state. Non-archival hosts only, FastNear first.
// A browser logs a CORS failure for an archival host even when this catch swallows it.
const DEPOSIT_HOSTS = [
  "https://rpc.testnet.fastnear.com",
  "https://test.rpc.fastnear.com",
];

// First host, then one retry. A miss returns null and does not log.
export async function readRequiredDeposit() {
  const params = {
    request_type: "call_function",
    finality: "final",
    account_id: FACTORY_ACCOUNT,
    method_name: "required_deposit",
    args_base64: btoa("{}"),
  };
  const hosts = DEPOSIT_HOSTS;
  for (let i = 0; i < hosts.length; i++) {
    try {
      const yocto = viewBytesToYocto(await rpcOnce(hosts[i], "query", params));
      if (yocto != null) return yocto;
    } catch (e) { /* try the other host, then stop */ }
  }
  return null;
}

export function accountExplorer(accountId) {
  return "https://testnet.nearblocks.io/address/" + encodeURIComponent(accountId || "");
}

export async function fetchOutcome(tx, sender) {
  for (let i = 0; ; i++) {
    try {
      return await rpc("EXPERIMENTAL_tx_status", { tx_hash: tx, sender_account_id: sender, wait_until: "FINAL" });
    } catch (e) {
      if (i >= 4 || !/UNKNOWN_TRANSACTION|TIMEOUT|timed out|fetch|HTTP 429|rpc-unavailable/i.test(String(e?.message ?? e))) throw e;
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
}

let busy = false;
export function isBusy() { return busy; }

function settled(promise) {
  return promise.then((res) => ({ ok: true, res }), (err) => ({ ok: false, err }));
}

async function softSnapshot() {
  const job = settled(snapshot());
  const timeout = new Promise((resolve) => setTimeout(() => resolve({ ok: false, err: new Error("snapshot timed out") }), 20000));
  return Promise.race([job, timeout]);
}

export async function runAttack(n, wallet, ed, visitor, beforeSend) {
  if (busy) return { n, error: "busy", notSent: "busy" };
  busy = true;
  try {
    const a = await buildAttack(n, visitor, ed);
    if (!wallet || typeof wallet.signAndSendTransaction !== "function") {
      return { n, label: a.label, error: "no_wallet", notSent: "connect" };
    }
    if (typeof beforeSend === "function") {
      beforeSend(describeAttack(a));
      await new Promise((resolve) => {
        if (typeof requestAnimationFrame !== "function") {
          resolve();
          return;
        }
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        requestAnimationFrame(finish);
        setTimeout(finish, 300);
      });
    }
    const sendP = wallet.signAndSendTransaction({ receiverId: RUNC.contract, actions: [a.action] });
    const sendSettled = settled(sendP);
    const beforeR = await softSnapshot();
    const sent = await sendSettled;
    let tx = null;
    let sendError = null;
    if (sent.ok) {
      const res = sent.res;
      tx = res?.transaction?.hash ?? res?.transaction_outcome?.id ?? null;
    } else {
      // Hash first. scrub() is display-only and slices to 400 chars, which drops a token that follows.
      const rawSend = sent.err?.message ?? sent.err;
      tx = extractTxHash(rawSend);
      sendError = scrub(rawSend);
    }
    if (!tx) {
      const msg = String(sendError || "");
      let notSent = "generic";
      if (/reject|denied|cancel|dismiss|user closed|closed by user/i.test(msg)) notSent = "cancel";
      else if (/insufficient|not enough|lack balance|enough balance|enough near/i.test(msg)) notSent = "balance";
      else if (/rpc-unavailable|rpc http|could not read|failed to fetch|network|timed out|429/i.test(msg)) notSent = "rpc";
      return {
        n,
        label: a.label,
        note: a.note,
        error: sendError || "no_tx_hash",
        noHash: true,
        notSent,
        accountExplorer: accountExplorer(visitor),
        account: visitor,
      };
    }
    const explorer = RUNC.explorer(tx);
    let full = null;
    let outcomeError = null;
    try { full = await fetchOutcome(tx, visitor); }
    catch (e) { outcomeError = scrub(e?.message ?? e); }
    const out = full ? readOutcome(full) : { tx, txSuccess: null, verdictKind: "unknown", reason: "", paidNear: null };
    const afterR = full ? await softSnapshot() : { ok: false };
    const before = beforeR.ok ? beforeR.res : null;
    const after = afterR.ok ? afterR.res : null;
    const snapOk = Boolean(before && after);
    const resolved = out.reason === "unknown or resolved pending";
    const matched = a.expect ? a.expect.includes(out.reason) : null;
    const row = {
      n,
      label: a.label,
      note: a.note,
      expect: a.expect,
      matched: resolved ? false : matched,
      notSurprise: resolved,
      resolvedNote: resolved ? RESOLVED_NOTE : null,
      ...out,
      tx,
      explorer,
      sendError,
      outcomeError,
      snapshotUnavailable: !snapOk,
      escrowPaid: snapOk ? null : ESCROW_UNAVAILABLE,
      caveat: NOTE_SHARED,
    };
    if (snapOk) {
      row.paidToPayeeYocto = (BigInt(after.payeeBalance) - BigInt(before.payeeBalance)).toString();
      row.escrowBefore = before.escrow;
      row.escrowAfter = after.escrow;
      row.escrowUnchanged = before.escrow === after.escrow;
      row.blocks = [before.height, after.height];
      row.countersBefore = before.counters;
      row.countersAfter = after.counters;
      row.escrowPaid = row.paidToPayeeYocto;
    }
    if (n === 3 && out.reason === "auto_frozen") {
      row.wrongCallerTx = RECORDED_WRONG_CALLER;
    }
    if (outcomeError && !full) row.error = "outcome_unread";
    return row;
  } catch (e) {
    const message = scrub(e?.message ?? e);
    if (n === 4 && e && e.attack4Blocked) {
      return { n, error: message, notSent: "attack4-rpc" };
    }
    return { n, error: message, notSent: "rpc-detail", rpcMessage: message };
  } finally {
    busy = false;
  }
}
