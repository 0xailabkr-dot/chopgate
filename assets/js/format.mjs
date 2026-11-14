const YOCTO = 10n ** 24n;

export function asBig(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("amount is not a safe integer");
    return BigInt(value);
  }
  const s = String(value ?? "").trim();
  if (!/^-?\d+$/.test(s)) throw new Error("amount is not an integer");
  return BigInt(s);
}

export function nearToYocto(input) {
  const s = String(input ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  if (frac.length > 24) return null;
  if (whole.length > 1 && whole.startsWith("0")) return null;
  try {
    return BigInt(whole) * YOCTO + BigInt((frac + "0".repeat(24)).slice(0, 24));
  } catch {
    return null;
  }
}

export function yoctoToNear(value) {
  let n;
  try { n = asBig(value); } catch { return "0"; }
  if (n < 0n) n = 0n;
  const whole = n / YOCTO;
  const frac = (n % YOCTO).toString().padStart(24, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function validAccount(id) {
  if (typeof id !== "string") return false;
  if (id.length < 2 || id.length > 64) return false;
  if (/^[0-9a-f]{64}$/.test(id)) return true;
  if (!/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(id)) return false;
  return id.split(".").every((part) => part.length > 0 && part.length <= 64);
}

/** Factory label: 2..32 of [a-z0-9], single '-' or '_' separators, not at the ends. */
export function validLabel(label) {
  if (typeof label !== "string") return false;
  if (label.length < 2 || label.length > 32) return false;
  return /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(label);
}

export function labelFromAccount(account) {
  const raw = String(account || "");
  if (/^[0-9a-f]{64}$/.test(raw)) return ("g" + raw.slice(0, 8)).slice(0, 32);
  let base = raw.split(".")[0].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  base = base.replace(/-+/g, "-");
  if (base.length > 32) base = base.slice(0, 32).replace(/[-_]$/g, "");
  if (!validLabel(base)) return "mygate";
  return base;
}

export function formatKst(ms, lang) {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  const formatted = new Intl.DateTimeFormat(lang === "ko" ? "ko-KR" : "en-GB", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return `${formatted} KST`;
}

export function nsToMs(ns) {
  try { return Number(asBig(ns) / 1000000n); } catch { return 0; }
}

export function shortHash(hex) {
  const s = String(hex || "");
  if (s.length <= 14) return s;
  return `${s.slice(0, 8)}...${s.slice(-4)}`;
}

export function nowNs() {
  return BigInt(Date.now()) * 1000000n;
}

const RAW_INT = "__raw_int__";

/** Mark an unsigned integer so call args can write it as a JSON number without Number(). */
export function rawInt(value) {
  const s = typeof value === "bigint" ? value.toString() : String(value ?? "").trim();
  if (!/^(0|[1-9]\d*)$/.test(s)) throw new Error("rawInt: expected an unsigned decimal");
  return { [RAW_INT]: s };
}

function isRawInt(value) {
  return !!value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, RAW_INT) && Object.keys(value).length === 1;
}

/** JSON body for a contract call. rawInt and bigint fields are unquoted decimal numbers. */
export function stringifyCallArgs(value) {
  const parts = [];
  const json = JSON.stringify(value, (key, v) => {
    if (typeof v === "bigint" || isRawInt(v)) {
      const s = typeof v === "bigint" ? v.toString() : v[RAW_INT];
      if (!/^(0|[1-9]\d*)$/.test(s)) throw new Error("stringifyCallArgs: bad int");
      const i = parts.length;
      parts.push(s);
      return "<<<CGRAW" + i + ">>>";
    }
    return v;
  });
  return json.replace(/"<<<CGRAW(\d+)>>>"/g, (_, i) => {
    const s = parts[Number(i)];
    if (!/^(0|[1-9]\d*)$/.test(s)) throw new Error("stringifyCallArgs: bad int");
    return s;
  });
}

export function encodeCallArgs(args) {
  if (args instanceof Uint8Array) return args;
  if (typeof args === "string") return new TextEncoder().encode(args);
  return new TextEncoder().encode(stringifyCallArgs(args ?? {}));
}

/**
 * Call args for the wallet connector: a plain object. The connector serialises args with JSON.stringify,
 * and a byte array does not survive that path. Each rawInt or bigint field must be a number that
 * JSON.stringify writes back digit for digit. If one is not, this throws and nothing is sent.
 */
export function walletCallArgs(args) {
  const text = JSON.stringify(args ?? {}, (key, v) => {
    if (typeof v === "bigint" || isRawInt(v)) {
      const s = typeof v === "bigint" ? v.toString() : v[RAW_INT];
      if (!/^(0|[1-9]\d*)$/.test(s) || JSON.stringify(Number(s)) !== s) {
        const error = new Error("walletCallArgs: " + (key || "value") + " cannot be sent exactly");
        error.kind = "inexact";
        throw error;
      }
      return Number(s);
    }
    return v;
  });
  const plain = JSON.parse(text);
  if (plain === null || typeof plain !== "object" || Array.isArray(plain)) throw new Error("walletCallArgs: args must be an object");
  return plain;
}

export function countdown(deadlineNs) {
  const ms = nsToMs(deadlineNs) - Date.now();
  if (ms <= 0) return "00:00:00";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}
