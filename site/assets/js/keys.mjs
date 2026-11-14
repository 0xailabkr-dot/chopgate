import { b58encode } from "./encoder.mjs";
import { loadStamp, patchDevice, readStampSlot, saveStamp } from "./store.mjs";

let edPromise;

function noble() {
  if (!edPromise) {
    edPromise = import("../vendor/near-connect-0.12.0.bundle.mjs").then((mod) => mod.ed);
  }
  return edPromise;
}

function hexToBytes(hex) {
  const clean = String(hex || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function publicKeyFromSeed(seed) {
  const ed = await noble();
  const pub = await ed.getPublicKeyAsync(seed);
  return `ed25519:${b58encode(pub)}`;
}

export async function createAgentKey() {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = await publicKeyFromSeed(seed);
  return { public_key: publicKey, secret_key: bytesToHex(seed) };
}

export async function createStamp() {
  const slot = await readStampSlot();
  if (slot.status !== "missing") return { ok: false, error: slot.status === "present" ? "exists" : slot.status };
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = await publicKeyFromSeed(seed);
  const record = {
    type: "chopgate-stamp-backup",
    version: 1,
    public_key: publicKey,
    secret_key: bytesToHex(seed),
  };
  await saveStamp(record);
  patchDevice({ backupDownloaded: false, backupFor: "" });
  return { ok: true, record };
}

function wipeSeed(seed) {
  if (seed && typeof seed.fill === "function") seed.fill(0);
}

/** "" only when the slot status is "missing". null when the slot is corrupt, error, or the public key cannot be derived. */
async function storedPublicKey() {
  const slot = await readStampSlot();
  if (slot?.status === "missing") return "";
  if (slot?.status === "present" && slot.record) {
    const existing = await stampFromRecord(slot.record);
    if (existing?.publicKey) {
      wipeSeed(existing.seed);
      return existing.publicKey;
    }
  }
  return null;
}

export async function importStamp(text, { replace = false, gateOwner = "", requireOwner = false } = {}) {
  let json;
  try { json = JSON.parse(text); } catch { return { ok: false, error: "backup.bad" }; }
  if (!json || json.type !== "chopgate-stamp-backup" || json.version !== 1) return { ok: false, error: "backup.bad" };
  const seed = hexToBytes(json.secret_key);
  if (!seed || typeof json.public_key !== "string") return { ok: false, error: "backup.bad" };
  let derived;
  try { derived = await publicKeyFromSeed(seed); } catch { wipeSeed(seed); return { ok: false, error: "backup.bad" }; }
  if (derived !== json.public_key) { wipeSeed(seed); return { ok: false, error: "backup.bad" }; }
  const owner = typeof gateOwner === "string" ? gateOwner : "";
  if ((requireOwner && !owner) || (owner && owner !== derived)) { wipeSeed(seed); return { ok: false, error: "backup.notOwner" }; }
  const current = await storedPublicKey();
  if (!replace && current == null) { wipeSeed(seed); return { ok: false, error: "backup.unreadable" }; }
  if (!replace && current && current !== derived) { wipeSeed(seed); return { ok: false, error: "backup.slotTaken" }; }
  const record = { type: "chopgate-stamp-backup", version: 1, public_key: json.public_key, secret_key: bytesToHex(seed) };
  wipeSeed(seed);
  await saveStamp(record);
  patchDevice({ backupDownloaded: false, backupFor: "" });
  return { ok: true, record };
}

export async function currentStamp() {
  const record = await loadStamp();
  if (!record) return null;
  const seed = hexToBytes(record.secret_key);
  if (!seed) return null;
  return { publicKey: record.public_key, seed, record };
}

/** Re-derive the public key from the seed. The stored public_key is not trusted. */
export async function stampFromRecord(record) {
  if (!record || typeof record.secret_key !== "string") return null;
  const seed = hexToBytes(record.secret_key);
  if (!seed) return null;
  let derived;
  try { derived = await publicKeyFromSeed(seed); } catch { return null; }
  const storedPublicKey = typeof record.public_key === "string" ? record.public_key : "";
  return {
    publicKey: derived,
    seed,
    record,
    storedPublicKey,
    storedMatches: storedPublicKey === derived,
  };
}

/** Stamp for compare and send. publicKey is publicKeyFromSeed(seed), never record.public_key. */
export async function verifiedStamp() {
  return stampFromRecord(await loadStamp());
}

export async function signBytes(seed, bytes) {
  const ed = await noble();
  const sig = await ed.signAsync(bytes, seed);
  return bytesToHex(sig);
}

export function downloadBackup(record) {
  const body = JSON.stringify({
    type: "chopgate-stamp-backup",
    version: 1,
    public_key: record.public_key,
    secret_key: record.secret_key,
  }, null, 2);
  const blob = new Blob([body], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "chopgate-stamp-backup.json";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
