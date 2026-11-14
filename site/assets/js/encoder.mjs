/**
 * Adapter over the vendor encoder. Swap this import when a review-passed
 * encoder replaces site/assets/vendor/chopgate-encode.u3-0340.mjs.
 * Do not edit the vendor file. Byte layout stays the vendor's.
 *
 * The vendor README says every function uses the strict integer parser.
 * signingBytes, authorizationBytes, pendingRequestHash, and
 * pendingDecisionV2Bytes in the vendored file do not: they call BigInt /
 * DataView directly, and pendingDecisionV2Bytes does not require a 32-byte
 * request hash. This adapter checks those inputs before calling through,
 * and still returns the vendor bytes for values the vendor accepts.
 */
import {
  authorizationBytes,
  hex,
  pendingDecisionV2Bytes,
  pendingRequestHash,
  sha256hex,
  signingBytes,
  spendRulesBytes,
  tier2ConfigBytes,
  withdrawalBytes,
  judgePolicyBytes,
  b58encode,
} from "../vendor/chopgate-encode.u3-0340.mjs";

export {
  authorizationBytes,
  hex,
  pendingDecisionV2Bytes,
  pendingRequestHash,
  sha256hex,
  signingBytes,
  spendRulesBytes,
  tier2ConfigBytes,
  withdrawalBytes,
  judgePolicyBytes,
  b58encode,
};

const U64 = (1n << 64n) - 1n;
const U128 = (1n << 128n) - 1n;

function asUint(name, value, max) {
  let x;
  if (typeof value === "bigint") x = value;
  else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`${name}: use a decimal string`);
    x = BigInt(value);
  } else if (typeof value === "string" && /^-?\d+$/.test(value)) x = BigInt(value);
  else throw new Error(`${name}: expected an integer`);
  if (x < 0n || x > max) throw new Error(`${name}: outside range`);
  return x;
}

function asU64(name, value) { return asUint(name, value, U64); }
function asU128(name, value) { return asUint(name, value, U128); }

export function signingBytesChecked(contract, mandate) {
  if (!contract || typeof contract !== "string") throw new Error("contract: expected a string");
  if (!mandate || !Array.isArray(mandate.entries) || mandate.entries.length < 1) {
    throw new Error("mandate: at least one entry");
  }
  asU64("serial", mandate.serial);
  asU128("budget", mandate.budget);
  asU64("expires_at", mandate.expires_at);
  if (mandate.parent_serial != null) asU64("parent_serial", mandate.parent_serial);
  for (const entry of mandate.entries) {
    asU128("max_amount", entry.max_amount);
    if (typeof entry.instruction_hash !== "string" || !/^[0-9a-f]{64}$/.test(entry.instruction_hash)) {
      throw new Error("instruction_hash: expected 64 lowercase hex chars");
    }
  }
  return signingBytes(contract, mandate);
}

export function pendingDecisionChecked(contract, id, approve, requestHash) {
  asU64("id", id);
  if (typeof approve !== "boolean") throw new Error("approve: expected a boolean");
  if (!(requestHash instanceof Uint8Array) || requestHash.length !== 32) {
    throw new Error("requestHash: expected 32 bytes");
  }
  return pendingDecisionV2Bytes(contract, id, approve, requestHash);
}

/** Lowercase hex ed25519 signature over authorization_bytes. */
export async function signAuthorization(ed, seed, chainId, deploymentId, ownerPk, payload) {
  const bytes = authorizationBytes(chainId, deploymentId, ownerPk, payload);
  const sig = await ed.signAsync(bytes, seed);
  const hexSig = hex(sig);
  if (!/^[0-9a-f]{128}$/.test(hexSig)) throw new Error("signature: expected 128 lowercase hex chars");
  return hexSig;
}
