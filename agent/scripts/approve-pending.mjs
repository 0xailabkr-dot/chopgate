#!/usr/bin/env node
// Owner-side approval. The signing seed is read and used, never printed.
import fs from 'node:fs';
import { pendingDecisionV2Bytes, pendingRequestHash } from '../src/vendor/chopgate-encode.mjs';
import {
  blockTimestampNs,
  publicKeyFromSeed,
  readSeedFile,
  signOwnerPayload,
  submitOwnerCall,
  viewMethod,
} from '../src/chopgate-agent.mjs';

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function redact(text, seedHex) {
  let out = String(text);
  if (seedHex) out = out.split(seedHex).join('[redacted]');
  return out
    .replace(/ed25519:[1-9A-HJ-NP-Za-km-z]{60,}/g, 'ed25519:[redacted]')
    .replace(/\b[0-9a-fA-F]{64}\b/g, '[redacted-hex]');
}

function fail(message, seedHex) {
  console.error(redact(message, seedHex));
  process.exit(1);
}

function assertMode600(file, label) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === 'ELOOP' || error.code === 'EPERM') fail(`${label} must be a regular file`);
    fail(`${label} cannot be opened`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || (st.mode & 0o777) !== 0o600) {
      fail(`${label} must be a mode 600 regular file`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

const gate = arg('--gate');
const idText = arg('--id');
const approve = process.argv.includes('--approve');
const reject = process.argv.includes('--reject');
const network = arg('--network') || process.env.CHOPGATE_NETWORK || 'testnet';

if (!gate || !idText) fail('usage: approve-pending.mjs --gate ACCOUNT --id N --approve|--reject');
if (approve === reject) fail('pass exactly one of --approve or --reject');
if (!/^\d+$/.test(idText)) fail('--id must be an integer');
const idBig = BigInt(idText);
if (idBig > BigInt(Number.MAX_SAFE_INTEGER)) fail('--id is above the safe JSON integer range');
const id = Number(idBig);
if (BigInt(id) !== idBig) fail('--id is above the safe JSON integer range');

const seedPath = process.env.OWNER_SIGNING_KEY_FILE;
const submitterPath = process.env.SUBMITTER_KEY_FILE;
if (!seedPath) fail('OWNER_SIGNING_KEY_FILE is required');
if (!submitterPath) fail('SUBMITTER_KEY_FILE is required');
assertMode600(seedPath, 'OWNER_SIGNING_KEY_FILE');
assertMode600(submitterPath, 'SUBMITTER_KEY_FILE');

let seed;
let seedHex = '';
try {
  seed = readSeedFile(seedPath);
  seedHex = seed.toString('hex');
} catch (error) {
  fail(error.message || String(error));
}

let submitter;
try {
  submitter = JSON.parse(fs.readFileSync(submitterPath, 'utf8'));
} catch (error) {
  fail(`cannot read submitter key file: ${error.message || error}`, seedHex);
}
if (!submitter.account_id || !submitter.private_key) {
  fail('submitter key file must contain account_id and private_key', seedHex);
}

let item;
let domain;
try {
  item = await viewMethod(network, gate, 'pending_item', { id });
  domain = await viewMethod(network, gate, 'signature_domain', {});
} catch (error) {
  fail(`chain view failed: ${error.message || error}`, seedHex);
}

if (item === null || item === undefined) fail(`pending item ${id} is absent`, seedHex);
// pending_request_hash in lib.rs is sha256(Borsh(action, target, amount, serial, instruction_hash)).
// It does not include source, predecessor, created_at, deadline, or the report.
for (const key of ['action', 'target', 'amount', 'serial', 'instruction_hash', 'deadline']) {
  if (item[key] === undefined || item[key] === null || item[key] === '') {
    fail(`pending item ${id} is missing ${key}`, seedHex);
  }
}
function decimalInteger(value, label) {
  if (typeof value === 'bigint') {
    if (value < 0n) fail(`${label} is negative`, seedHex);
    return value.toString();
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  fail(`${label} is not a decimal integer`, seedHex);
}
// Do not pass the deadline through Number(). A u64 above 2^53 must stay a decimal string.
const deadlineText = typeof item.deadline === 'string' ? item.deadline.trim() : String(item.deadline);
if (!/^\d+$/.test(deadlineText)) fail('deadline is not an integer', seedHex);
const deadline = BigInt(deadlineText);
let now;
try {
  now = await blockTimestampNs(network);
} catch (error) {
  fail(`could not read block time: ${error.message || error}`, seedHex);
}
if (now >= deadline) fail(`pending item ${id} deadline has passed`, seedHex);

if (!Array.isArray(domain) || domain.length < 3) fail('signature_domain did not return chain_id, deployment_id, owner key', seedHex);
const [chainId, deploymentId, ownerPk] = domain;
if (typeof ownerPk !== 'string') fail('signature_domain owner key was not a string', seedHex);
const derived = publicKeyFromSeed(seed);
if (derived !== ownerPk) fail('owner signing key does not match signature_domain', seedHex);

const requestHash = await pendingRequestHash({
  action: String(item.action),
  target: String(item.target),
  amount: decimalInteger(item.amount, 'amount'),
  serial: decimalInteger(item.serial, 'serial'),
  instruction_hash: String(item.instruction_hash),
});
if (!(requestHash instanceof Uint8Array) || requestHash.length !== 32) {
  fail('pending request hash was not 32 bytes', seedHex);
}
const payload = pendingDecisionV2Bytes(gate, idBig, approve === true, requestHash);
const { signature } = signOwnerPayload(seed, chainId, deploymentId, ownerPk, payload);
const method = approve ? 'approve_pending' : 'reject_pending';

let result;
try {
  result = await submitOwnerCall({
    accountId: submitter.account_id,
    privateKey: submitter.private_key,
    networkName: network,
    contractId: gate,
    methodName: method,
    args: { id, signature },
  });
} catch (error) {
  fail(`submit failed: ${error.message || error}`, seedHex);
}

if (result.failure) {
  console.error(redact(`transaction ${result.tx_hash} failed on chain`, seedHex));
  console.log(JSON.stringify({
    tx_hash: result.tx_hash,
    explorer_url: result.explorer_url,
    events: result.events,
    failure: true,
  }, null, 2));
  process.exit(1);
}

const expectedEvent = approve ? 'pending_approved' : 'pending_rejected';
const names = (result.events || []).map((event) => event?.event);
console.log(JSON.stringify({
  tx_hash: result.tx_hash,
  explorer_url: result.explorer_url,
  events: result.events,
}, null, 2));
if (!names.includes(expectedEvent)) {
  fail(`expected ${expectedEvent}, saw ${names.filter(Boolean).join(',') || 'no events'}`, seedHex);
}
