// Device-local mandate text. A row is usable only when it carries a gate
// account id, a mandate serial, and a job id (entry index). Instruction hash
// is not a lookup key.

export const NO_ORIGINAL_EN = "This device has no original text for this job.";
export const NO_ORIGINAL_KO = "이 기기에 원문이 없습니다.";

const NONE = { found: false, text: "", message: NO_ORIGINAL_EN };

function idText(value) {
  if (value == null) return "";
  return String(value).trim();
}

function explicitJobId(value) {
  if (!value || typeof value !== "object") return "";
  for (const key of ["job_id", "jobId", "entry_index", "entryIndex"]) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const text = idText(value[key]);
    if (text) return text;
  }
  return "";
}

/** Entry index stored with each job when this device stamps a mandate. */
export function withJobIds(entries) {
  return (entries || []).map((entry, index) => {
    const source = entry && typeof entry === "object" ? entry : {};
    const { jobId, entry_index, entryIndex, ...rest } = source;
    return { ...rest, job_id: String(index) };
  });
}

/** Registration payload. The contract entry has no job id and no instruction text. */
export function chainEntries(entries) {
  return (entries || []).map((entry) => {
    if (!entry || typeof entry !== "object") return {};
    const { instruction, job_id, jobId, entry_index, entryIndex, ...rest } = entry;
    return rest;
  });
}

function chainAmount(hold) {
  const amount = hold?.amount;
  if (amount == null) return "0";
  if (typeof amount === "object") return String(amount.value ?? "0");
  return String(amount);
}

/** Flat list of originals that carry gate, serial, and job id. */
export function listOriginals(records) {
  const out = [];
  for (const row of records || []) {
    if (!row || typeof row !== "object") continue;
    const gate = idText(row.gate);
    const serial = idText(row.serial);
    if (!gate || !serial) continue;
    if (Array.isArray(row.entries)) {
      for (const entry of row.entries) {
        const jobId = explicitJobId(entry);
        if (!jobId) continue;
        out.push({
          gate,
          serial,
          jobId,
          instruction: typeof entry?.instruction === "string" ? entry.instruction : "",
          instructionHash: typeof entry?.instruction_hash === "string" ? entry.instruction_hash : "",
        });
      }
      continue;
    }
    const jobId = explicitJobId(row);
    if (!jobId) continue;
    out.push({
      gate,
      serial,
      jobId,
      instruction: typeof row.instruction === "string" ? row.instruction : "",
      instructionHash: typeof row.instruction_hash === "string" ? row.instruction_hash : "",
    });
  }
  return out;
}

/**
 * One original, or none. Zero hits and more than one hit are the same result.
 * `instructionHash` on the query is ignored.
 */
export function findOriginal(records, query) {
  const gate = idText(query?.gate);
  const serial = idText(query?.serial);
  const jobId = explicitJobId(query);
  if (!gate || !serial || !jobId) return { ...NONE };
  const hits = listOriginals(records).filter((row) => row.gate === gate && row.serial === serial && row.jobId === jobId);
  if (hits.length !== 1) return { ...NONE };
  return { found: true, text: hits[0].instruction, message: "" };
}

/**
 * Hold text. An explicit job id on the hold must match that job.
 * With no job id, the hold matches only when this gate and serial have one stored job.
 * Instruction hash is only a check on that single match: when the hold carries one, the stored job must carry the same hash.
 */
export function originalForHold(records, hold, gate) {
  const g = idText(gate || hold?.gate);
  const serial = idText(hold?.serial);
  const explicit = explicitJobId(hold);
  if (explicit) return findOriginal(records, { gate: g, serial, job_id: explicit });
  const hits = listOriginals(records).filter((row) => row.gate === g && row.serial === serial);
  if (hits.length !== 1) return { ...NONE };
  // The hash is a check on the single gate+serial match, never a lookup key.
  const holdHash = idText(hold?.instruction_hash);
  // A stored job with no hash cannot pass this check, so it is not shown.
  if (holdHash && hits[0].instructionHash !== holdHash) return { ...NONE };
  return findOriginal(records, { gate: g, serial, job_id: hits[0].jobId });
}

/** Recipient, amount, serial, and id are copied from the hold. Local rows do not fill them. */
export function approvalFacts(hold, records, gate) {
  const match = originalForHold(records, hold, gate);
  return {
    target: hold?.target == null ? "" : String(hold.target),
    amount: chainAmount(hold),
    serial: idText(hold?.serial),
    id: idText(hold?.id),
    original: match.found ? match.text : "",
    originalFound: match.found,
    message: match.found ? "" : NO_ORIGINAL_EN,
  };
}
