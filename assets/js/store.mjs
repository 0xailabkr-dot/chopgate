const KEY = "chopgate.device.v1";

function blank() {
  return { backupDownloaded: false, backupFor: "", gates: [], mandates: [], flags: {} };
}

export function loadDevice() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return blank();
    const parsed = JSON.parse(raw);
    return { ...blank(), ...parsed, gates: parsed.gates || [], mandates: parsed.mandates || [], flags: parsed.flags || {} };
  } catch {
    return blank();
  }
}

export function saveDevice(data) {
  localStorage.setItem(KEY, JSON.stringify(data));
}

export function patchDevice(partial) {
  const next = { ...loadDevice(), ...partial };
  saveDevice(next);
  return next;
}

export function rememberGate(gate) {
  const data = loadDevice();
  const gates = data.gates.filter((row) => row.id !== gate.id);
  gates.unshift(gate);
  data.gates = gates.slice(0, 20);
  saveDevice(data);
  return data;
}

export function rememberMandate(mandate) {
  const data = loadDevice();
  const mandates = data.mandates.filter((row) => !(row.gate === mandate.gate && String(row.serial) === String(mandate.serial)));
  mandates.unshift(mandate);
  data.mandates = mandates.slice(0, 50);
  saveDevice(data);
  return data;
}

export function markMandate(gate, serial, patch) {
  const data = loadDevice();
  data.mandates = data.mandates.map((row) => (
    row.gate === gate && String(row.serial) === String(serial) ? { ...row, ...patch } : row
  ));
  saveDevice(data);
  return data;
}

const DB = "chopgate-stamp";
const STORE = "keys";

function idb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("no idb")); return; }
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error || new Error("idb"));
  });
}

export async function saveStamp(record) {
  try {
    const db = await idb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(record, "current");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("idb write"));
    });
    db.close();
    localStorage.removeItem("chopgate.stamp.fallback");
    return "idb";
  } catch {
    localStorage.setItem("chopgate.stamp.fallback", JSON.stringify(record));
    return "local";
  }
}

function classifyRecord(record) {
  if (!record || typeof record !== "object") return "corrupt";
  if (typeof record.secret_key !== "string" || typeof record.public_key !== "string") return "corrupt";
  if (!record.secret_key || !record.public_key) return "corrupt";
  return "present";
}

/** missing | present | corrupt | error. A read error is not an empty slot. */
export async function readStampSlot() {
  let idbStatus = "unavailable";
  let idbRecord = null;
  try {
    const db = await idb();
    idbRecord = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get("current");
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error("idb read"));
    });
    db.close();
    idbStatus = "read";
  } catch (error) {
    idbStatus = String(error?.message || error) === "no idb" ? "unavailable" : "error";
  }
  if (idbStatus === "error") return { status: "error", record: null };
  if (idbStatus === "read" && idbRecord) {
    return { status: classifyRecord(idbRecord), record: idbRecord };
  }
  try {
    const raw = localStorage.getItem("chopgate.stamp.fallback");
    if (!raw) return { status: "missing", record: null };
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return { status: "corrupt", record: null }; }
    return { status: classifyRecord(parsed), record: parsed };
  } catch {
    return { status: "error", record: null };
  }
}

export async function loadStamp() {
  const slot = await readStampSlot();
  if (slot.status !== "present") return null;
  return slot.record;
}

const LANG_KEY = "chopgate-c1-lang";
const LANG_OLD = "chopgate.lang";

export function lang() {
  let stored = null;
  try { stored = localStorage.getItem(LANG_KEY); } catch { stored = null; }
  if (stored !== "ko" && stored !== "en") {
    try { stored = localStorage.getItem(LANG_OLD); } catch { stored = null; }
    if (stored === "ko" || stored === "en") {
      try { localStorage.setItem(LANG_KEY, stored); } catch { /* ignore */ }
    }
  }
  return stored === "ko" ? "ko" : "en";
}

export function setLang(value) {
  const next = value === "ko" ? "ko" : "en";
  localStorage.setItem(LANG_KEY, next);
}

/** Public account id only, so a reload can call gate_account_for without a popup. */
export function rememberedOwner() {
  let id = "";
  try { id = localStorage.getItem("chopgate.owner") || ""; } catch { return ""; }
  // only a testnet account (named .testnet, 64-hex implicit or 0x) is used as the owner.
  return /\.testnet$/.test(id) || /^[0-9a-f]{64}$/.test(id) || /^0x[0-9a-f]{40}$/.test(id) ? id : "";
}

export function rememberOwner(id) {
  try {
    if (id) localStorage.setItem("chopgate.owner", id);
    else localStorage.removeItem("chopgate.owner");
  } catch { /* private mode */ }
}

const WITHDRAW_NONCE_KEY = "chopgate.withdrawNonce.v1";

function withdrawNonceText(value) {
  const text = String(value ?? "").trim();
  return /^(0|[1-9]\d*)$/.test(text) ? text : "";
}

/** Last withdrawal nonce this browser confirmed for a gate, or "". */
export function readLastWithdrawNonce(gate) {
  try {
    const raw = localStorage.getItem(WITHDRAW_NONCE_KEY);
    if (!raw) return "";
    const map = JSON.parse(raw);
    if (!map || typeof map !== "object" || Array.isArray(map)) return "";
    return withdrawNonceText(map[String(gate || "")]);
  } catch {
    return "";
  }
}

/** Remember the nonce text a confirmed withdraw actually sent. */
export function writeLastWithdrawNonce(gate, nonce) {
  try {
    const id = String(gate || "");
    const text = withdrawNonceText(nonce);
    if (!id || !text) return;
    let map = {};
    try {
      const raw = localStorage.getItem(WITHDRAW_NONCE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) map = parsed;
    } catch { map = {}; }
    map[id] = text;
    localStorage.setItem(WITHDRAW_NONCE_KEY, JSON.stringify(map));
  } catch { /* private mode */ }
}
