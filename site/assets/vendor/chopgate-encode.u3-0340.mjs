// Borsh payloads that the ChopGate contract (src/lib.rs) signs over. Pure JS, no dependencies.
const te = new TextEncoder();
const cat = (parts) => { const n = parts.reduce((a, p) => a + p.length, 0); const o = new Uint8Array(n); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };
const u32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; };
const u64 = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); return b; };
const u128 = (v) => { let x = BigInt(v); const b = new Uint8Array(16); for (let i = 0; i < 16; i++) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };
const str = (s) => { const b = te.encode(s); return cat([u32(b.length), b]); };
const bytes = (b) => cat([u32(b.length), b]);
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58encode(b) { let x = 0n; for (const c of b) x = (x << 8n) | BigInt(c); let s = ""; while (x > 0n) { s = B58[Number(x % 58n)] + s; x /= 58n; } for (const c of b) { if (c !== 0) break; s = "1" + s; } return s; }
export function b58decode(s) { let x = 0n; for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error("bad base58"); x = x * 58n + BigInt(i); } const out = []; while (x > 0n) { out.unshift(Number(x & 0xffn)); x >>= 8n; } for (const c of s) { if (c !== "1") break; out.unshift(0); } return new Uint8Array(out); }
export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const unhex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
const pubkey = (pk) => { const [t, k] = pk.split(":"); if (t !== "ed25519") throw new Error("ed25519 only"); const raw = b58decode(k); if (raw.length !== 32) throw new Error("bad key length"); // near_sdk::PublicKey borsh = Vec<u8>: u32 length 33, key type byte 0, 32 key bytes.
  return bytes(cat([new Uint8Array([0]), raw])); };
export async function sha256(b) { return new Uint8Array(await crypto.subtle.digest("SHA-256", b)); }
export async function sha256hex(s) { return hex(await sha256(te.encode(s))); }
function mandateBorsh(m) {
  const entries = cat([u32(m.entries.length), ...m.entries.map((e) => cat([str(e.action), str(e.target), u128(e.max_amount), str(e.instruction_hash)]))]);
  const parent = m.parent_serial == null ? new Uint8Array([0]) : cat([new Uint8Array([1]), u64(m.parent_serial)]);
  return cat([u64(m.serial), str(m.agent), entries, u128(m.budget), u64(m.expires_at), parent]);
}
export function signingBytes(contract, mandate) { return cat([te.encode("chopgate:owner-mandate:v1\0"), str(contract), mandateBorsh(mandate)]); }
export function authorizationBytes(chainId, deploymentId, ownerPk, payload) {
  return cat([te.encode("chopgate:authorization:v3\0"), str(chainId), str(deploymentId), pubkey(ownerPk), str("native:NEAR"), bytes(payload)]);
}
export async function pendingRequestHash(item) { return sha256(cat([str(item.action), str(item.target), u128(item.amount), u64(item.serial), str(item.instruction_hash)])); }
export function pendingDecisionV2Bytes(contract, id, approve, requestHash) { return cat([te.encode("chopgate:pending-decision:v2\0"), str(contract), u64(id), new Uint8Array([approve ? 1 : 0]), bytes(requestHash)]); }

// Integer checks for the payloads below. Amounts (u128) take a decimal string or bigint;
// a safe integer number is also accepted. Out-of-range values throw before any truncation.
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
function parseIntAny(name, v) {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new Error(`${name}: ${v} is not an integer`);
    if (!Number.isSafeInteger(v)) throw new Error(`${name}: ${v} is not a safe integer; use a decimal string or bigint`);
    return BigInt(v);
  }
  if (typeof v === "string") {
    if (!/^-?\d+$/.test(v)) throw new Error(`${name}: expected a decimal integer string`);
    return BigInt(v);
  }
  throw new Error(`${name}: expected a decimal string, bigint, or safe integer`);
}
function inRange(name, x, min, max) {
  if (x < min || x > max) throw new Error(`${name}: ${x} is outside ${min}..${max}`);
  return x;
}
const encU64 = (name, v) => u64(inRange(name, parseIntAny(name, v), 0n, U64_MAX));
const encU128 = (name, v) => u128(inRange(name, parseIntAny(name, v), 0n, U128_MAX));
const encU32 = (name, v) => u32(Number(inRange(name, parseIntAny(name, v), 0n, 4294967295n)));
function encU16(name, v) {
  const x = Number(inRange(name, parseIntAny(name, v), 0n, 65535n));
  const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, x, true); return b;
}
function encI32(name, v) {
  const x = Number(inRange(name, parseIntAny(name, v), -2147483648n, 2147483647n));
  const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, x, true); return b;
}
function expectStr(name, v) {
  if (typeof v !== "string") throw new Error(`${name}: expected a string`);
  return v;
}
function expectObj(name, v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error(`${name}: expected an object`);
  return v;
}
function take(obj, objName, key) {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) throw new Error(`${objName}: missing ${key}`);
  return obj[key];
}
function encBool(name, v) {
  if (typeof v !== "boolean") throw new Error(`${name}: expected a boolean`);
  return new Uint8Array([v ? 1 : 0]);
}
function encStrList(name, v) {
  if (!Array.isArray(v)) throw new Error(`${name}: expected an array of strings`);
  return cat([u32(v.length), ...v.map((s, i) => str(expectStr(`${name}[${i}]`, s)))]);
}
function encPayees(v) {
  if (!Array.isArray(v)) throw new Error("payees: expected an array");
  const parts = [u32(v.length)];
  v.forEach((p, i) => {
    const o = expectObj(`payees[${i}]`, p);
    parts.push(str(expectStr(`payees[${i}].alias`, take(o, `payees[${i}]`, "alias"))));
    parts.push(str(expectStr(`payees[${i}].account`, take(o, `payees[${i}]`, "account"))));
  });
  return cat(parts);
}
function encKeys(v) {
  if (!Array.isArray(v)) throw new Error("keys: expected an array");
  const parts = [u32(v.length)];
  v.forEach((k, i) => {
    if (typeof k !== "string") throw new Error(`keys[${i}]: expected a public key string`);
    try { parts.push(pubkey(k)); } catch (e) { throw new Error(`keys[${i}]: ${e.message}`); }
  });
  return cat(parts);
}

// tier2_config_bytes: "chopgate:tier2-config:v1\0" + Borsh(AccountId, Tier2Config).
// Field order: config_nonce u64, amount_threshold U128, pending_ttl_ns u64, new_payee_check bool,
// trusted_sources, known_payees, denied_targets (each Vec<String>).
export function tier2ConfigBytes(contract, cfg) {
  const o = expectObj("cfg", cfg);
  return cat([
    te.encode("chopgate:tier2-config:v1\0"),
    str(expectStr("contract", contract)),
    encU64("config_nonce", take(o, "cfg", "config_nonce")),
    encU128("amount_threshold", take(o, "cfg", "amount_threshold")),
    encU64("pending_ttl_ns", take(o, "cfg", "pending_ttl_ns")),
    encBool("new_payee_check", take(o, "cfg", "new_payee_check")),
    encStrList("trusted_sources", take(o, "cfg", "trusted_sources")),
    encStrList("known_payees", take(o, "cfg", "known_payees")),
    encStrList("denied_targets", take(o, "cfg", "denied_targets")),
  ]);
}

// spend_rules_bytes: "chopgate:spend-rules:v1\0" + Borsh(AccountId, SpendRules).
// Field order matches tier2.rs SpendRules: rules_nonce, enabled, per_tx_limit, per_day_limit,
// payees (alias then account), tz_offset_min i32, window_start_min, window_end_min, max_tx_per_day,
// allowed_categories, jev_threshold_permille u16, jev_required.
export function spendRulesBytes(contract, rules) {
  const o = expectObj("rules", rules);
  return cat([
    te.encode("chopgate:spend-rules:v1\0"),
    str(expectStr("contract", contract)),
    encU64("rules_nonce", take(o, "rules", "rules_nonce")),
    encBool("enabled", take(o, "rules", "enabled")),
    encU128("per_tx_limit", take(o, "rules", "per_tx_limit")),
    encU128("per_day_limit", take(o, "rules", "per_day_limit")),
    encPayees(take(o, "rules", "payees")),
    encI32("tz_offset_min", take(o, "rules", "tz_offset_min")),
    encU32("window_start_min", take(o, "rules", "window_start_min")),
    encU32("window_end_min", take(o, "rules", "window_end_min")),
    encU32("max_tx_per_day", take(o, "rules", "max_tx_per_day")),
    encStrList("allowed_categories", take(o, "rules", "allowed_categories")),
    encU16("jev_threshold_permille", take(o, "rules", "jev_threshold_permille")),
    encBool("jev_required", take(o, "rules", "jev_required")),
  ]);
}

// withdrawal_bytes: "chopgate:escrow-withdraw:v1\0" + Borsh(AccountId, U128, AccountId, u64).
export function withdrawalBytes(contract, amount, recipient, nonce) {
  return cat([
    te.encode("chopgate:escrow-withdraw:v1\0"),
    str(expectStr("contract", contract)),
    encU128("amount", amount),
    str(expectStr("recipient", recipient)),
    encU64("nonce", nonce),
  ]);
}

// judge_policy_bytes: "chopgate:judge-policy:v1\0" + Borsh(AccountId, JudgePolicy).
// JudgePolicy is nonce u64 then keys Vec<PublicKey>. PublicKey matches pubkey().
export function judgePolicyBytes(contract, policy) {
  const o = expectObj("policy", policy);
  return cat([
    te.encode("chopgate:judge-policy:v1\0"),
    str(expectStr("contract", contract)),
    encU64("nonce", take(o, "policy", "nonce")),
    encKeys(take(o, "policy", "keys")),
  ]);
}
