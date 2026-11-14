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
