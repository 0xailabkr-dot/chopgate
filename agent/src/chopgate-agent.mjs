// ChopGate agent library. The agent signs with its own NEAR account key.
// The gate, not this module, decides whether a payment is inside the mandate.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Account,
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  PublicKey,
  actions,
  baseDecode,
  baseEncode,
  createTransaction,
  encodeTransaction,
  getTransactionLastResult,
} from 'near-api-js';
import {
  authorizationBytes,
  b58encode,
  sha256,
  sha256hex,
} from './vendor/chopgate-encode.mjs';
import {
  FREEZE_LOCAL_BOUND_EN,
  FREEZE_LOCAL_BOUND_KO,
  FREEZE_RISK_NEXT_EN,
  FREEZE_RISK_NEXT_KO,
  FREEZE_RISK_UNKNOWN_EN,
  FREEZE_RISK_UNKNOWN_KO,
  POST_DECISION_UNKNOWN_EN,
  POST_DECISION_UNKNOWN_KO,
  FREEZE_UNKNOWN_EN,
  FREEZE_UNKNOWN_KO,
  FREEZE_WARNING_EN,
  FREEZE_WARNING_KO,
  REASONS,
  STATE_UNVERIFIED_NOTE,
  describeReason,
} from './reasons.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_NETWORKS = path.resolve(HERE, '../config/networks.json');
const YN = 10n ** 24n;
const U128_MAX = (1n << 128n) - 1n;
const MAX_GAS = 300_000_000_000_000n;
const LOCK_WAIT_MS = 3000;
const LOCK_POLL_MS = 100;
const STALE_LOCK_MS = 60_000;
const SOURCE_MAX = 200;
// near-api-js 7.5.3 treats `retries` as the attempt count (`attempt <= retries`).
// Zero resends means one attempt. Passing 0 would skip the HTTP call.
export const SEND_RESENDS = 0;
const ALLOWED_NETWORK_IDS = new Set(['sandbox', 'testnet']);
// near-sandbox `init --chain-id sandbox` reports RPC status chain_id "sandbox".
// That id is accepted only when the configured networkId is sandbox.
const SANDBOX_CHAIN_ID = 'sandbox';
const ALLOWED_CHAIN_IDS = new Set(['testnet', SANDBOX_CHAIN_ID]);
const RESULT_APPEND_TRIES = 5;
const RESULT_APPEND_WAIT_MS = 150;

function positiveMs(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function callTimeoutMs() {
  return positiveMs('CHOPGATE_RPC_TIMEOUT_MS', 8000);
}

function viewTimeoutMs() {
  return positiveMs('CHOPGATE_VIEW_TIMEOUT_MS', 20_000);
}

function sendTimeoutMs() {
  return positiveMs('CHOPGATE_SEND_TIMEOUT_MS', 60_000);
}

function replayDeadlineMs() {
  return positiveMs('CHOPGATE_REPLAY_DEADLINE_MS', 20000);
}

// Tests wrap the JSON-RPC provider. Production leaves this unset.
let providerHook = null;
export function setProviderHookForTests(hook) {
  providerHook = typeof hook === 'function' ? hook : null;
}

const LOCAL_REASONS = new Set([
  'duplicate_attempt_not_sent',
  'frozen_not_sent',
  'freeze_risk_not_sent',
  'network_not_enabled',
  'chain_id_refused',
  'execution_failure',
  'rpc_uncertain',
  'rpc_preflight',
  'ledger_corrupt',
  'ledger_locked',
  'amount_refused',
  'agent_mismatch_not_sent',
  'mandate_expired_not_sent',
  'over_max_not_sent',
  'over_budget_not_sent',
  'entry_used_not_sent',
  'bad_source',
  'key_refused',
  'full_access_key_refused',
  'key_scope_mismatch',
  'internal_error',
]);
// These receipts do not change used-bits or the freeze counter.
const NO_STATE = new Set([
  'zero_amount',
  'invalid_recipient',
  'pending_limit',
  'unknown_mandate',
]);
// Tier-1 allow, including a hold or a tier-2 deny: the entry and budget are consumed.
const CONSUME = new Set(['allowed', 'tier2_escalate', 'tier2_deny']);

export function redact(text) {
  return String(text ?? '')
    .replace(/ed25519:[1-9A-HJ-NP-Za-km-z]{60,}/g, 'ed25519:[redacted]')
    .replace(/\b[0-9a-fA-F]{64}\b/g, '[redacted-hex]')
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{80,}\b/g, '[redacted]');
}

function coded(code, message) {
  const error = new Error(redact(message || describeReason(code).reason_en));
  error.code = code;
  return error;
}

export function networksPath() {
  return process.env.CHOPGATE_NETWORKS_FILE || DEFAULT_NETWORKS;
}

export function loadNetworks() {
  const file = networksPath();
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!cfg || typeof cfg !== 'object') throw new Error('networks config is not an object');
  return cfg;
}

function urlList(value) {
  if (Array.isArray(value)) return value.map((s) => String(s).trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

// A mainnet account id ends in .near and is not the sandbox genesis namespace test.near.
export function isProductionNearAccount(accountId) {
  const id = String(accountId || '').toLowerCase();
  if (!id.endsWith('.near')) return false;
  if (id === 'test.near' || id.endsWith('.test.near')) return false;
  return true;
}

export function assertAccountNotMainnet(accountId) {
  if (isProductionNearAccount(accountId)) {
    throw coded('network_not_enabled', 'a non-testnet .near account is refused');
  }
}

export function assertNetworkEnabled(name) {
  const label = String(name ?? '');
  if (label.toLowerCase() === 'mainnet') {
    throw coded('network_not_enabled', 'network mainnet is refused');
  }
  const cfg = loadNetworks();
  const net = cfg[name];
  if (!net || net.enabled !== true) {
    throw coded('network_not_enabled', `network ${label} is not enabled`);
  }
  const networkId = String(net.networkId || '');
  if (!networkId || urlList(net.rpc).length === 0) {
    throw coded('network_not_enabled', `network ${label} has no networkId or rpc`);
  }
  if (networkId.toLowerCase() === 'mainnet') {
    throw coded('network_not_enabled', 'networkId mainnet is refused');
  }
  // The default file and CHOPGATE_NETWORKS_FILE may only name sandbox or testnet.
  if (!ALLOWED_NETWORK_IDS.has(networkId)) {
    throw coded('network_not_enabled', `networkId ${networkId} is refused`);
  }
  return net;
}

export function explorerUrl(networkName, txHash) {
  const net = assertNetworkEnabled(networkName);
  const base = String(net.explorer || '');
  if (!base || !txHash) return '';
  return base.endsWith('/') ? `${base}${txHash}` : `${base}/${txHash}`;
}

function providerFor(url, { send = false } = {}) {
  const retries = send ? SEND_RESENDS + 1 : 1;
  const provider = new JsonRpcProvider({ url }, { retries, wait: 200, backoff: 1 });
  return providerHook ? providerHook(provider, { url, send }) : provider;
}

function withTimeout(promise, ms, label) {
  if (!(ms > 0)) return Promise.reject(coded('rpc_preflight', `${label} exceeded the replay deadline. Nothing was sent.`));
  const work = Promise.resolve(promise);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(coded('rpc_preflight', `${label} timed out. Nothing was sent.`));
    }, ms);
  });
  // If an outer race wins first, a later rejection of this promise must not surface unhandled.
  work.catch(() => {});
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

// The broadcast may already be on the wire when this fires. The caller records sent:"unknown".
function withSendDeadline(promise) {
  const ms = sendTimeoutMs();
  const work = Promise.resolve(promise);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`send deadline exceeded after ${ms}ms`));
    }, ms);
  });
  work.catch(() => {});
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function chainAllowed(networkId, chainId) {
  if (chainId === 'mainnet') return false;
  if (!ALLOWED_CHAIN_IDS.has(chainId)) return false;
  if (chainId !== networkId) return false;
  // The sandbox node's chain_id is allowed only for the sandbox network.
  if (chainId === SANDBOX_CHAIN_ID && networkId !== 'sandbox') return false;
  return true;
}

// RPC method "status". A wrong chain_id refuses. A timeout or an unreachable node is rpc_preflight.
export async function assertRpcChain(networkName) {
  const net = assertNetworkEnabled(networkName);
  const networkId = String(net.networkId);
  const urls = urlList(net.rpc);
  let lastError = null;
  for (const url of urls) {
    try {
      const provider = providerFor(url);
      const status = await withTimeout(provider.viewNodeStatus(), callTimeoutMs(), 'rpc status');
      const chainId = String(status?.chain_id ?? '');
      if (!chainAllowed(networkId, chainId)) {
        throw coded(
          'chain_id_refused',
          `rpc chain_id ${chainId || 'missing'} does not match ${networkId}. Nothing was sent.`,
        );
      }
      return { chainId, url };
    } catch (error) {
      if (error?.code === 'chain_id_refused' || error?.code === 'rpc_preflight') throw error;
      lastError = error;
    }
  }
  throw coded('rpc_preflight', `rpc status failed (${lastError?.message || 'no rpc'}). Nothing was sent.`);
}

async function firstRpc(networkName, fn) {
  const net = assertNetworkEnabled(networkName);
  const urls = urlList(net.rpc);
  let last;
  for (const url of urls) {
    try {
      return await fn(providerFor(url), url);
    } catch (error) {
      last = error;
    }
  }
  throw last || new Error(`no rpc for ${networkName}`);
}

export async function viewMethod(networkName, contractId, method, args, options) {
  const call = (provider) => provider.callFunction({
    contractId,
    method,
    args,
    blockQuery: { finality: 'final' },
  });
  const work = options?.url ? call(providerFor(options.url)) : firstRpc(networkName, call);
  return withTimeout(work, viewTimeoutMs(), 'view method');
}

export async function blockTimestampNs(networkName) {
  const block = await withTimeout(
    firstRpc(networkName, (provider) => provider.viewBlock({ finality: 'final' })),
    viewTimeoutMs(),
    'block timestamp',
  );
  const header = block?.header || block;
  const raw = header?.timestamp_nanosec ?? header?.timestamp;
  if (raw === undefined || raw === null) throw new Error('block timestamp missing');
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return BigInt(raw);
  const text = String(raw);
  if (!/^\d+$/.test(text)) throw new Error('block timestamp is not an integer');
  return BigInt(text);
}

export async function viewAccountAmount(networkName, accountId) {
  const view = await firstRpc(networkName, (provider) => provider.viewAccount({
    accountId,
    blockQuery: { finality: 'final' },
  }));
  return BigInt(view.amount);
}

export async function viewAccessKey(networkName, accountId, publicKey, options) {
  const call = (provider) => provider.viewAccessKey({
    accountId,
    publicKey,
    finalityQuery: { finality: 'final' },
  });
  const work = options?.url ? call(providerFor(options.url)) : firstRpc(networkName, call);
  return withTimeout(work, viewTimeoutMs(), 'view access key');
}

export async function viewAccessKeyList(networkName, accountId, options) {
  const call = (provider) => provider.viewAccessKeyList({
    accountId,
    finalityQuery: { finality: 'final' },
  });
  if (options?.url) return call(providerFor(options.url));
  return firstRpc(networkName, call);
}

export async function viewCodeHash(networkName, contractId, options) {
  const call = (provider) => provider.viewContractCode({
    contractId,
    blockQuery: { finality: 'final' },
  });
  const view = options?.url ? await call(providerFor(options.url)) : await firstRpc(networkName, call);
  return view.hash;
}

// The only key the agent may hold. An empty method list is not this list.
const AGENT_METHOD_NAMES = ['authorize_and_pay_tiered'];

export const FINITE_ALLOWANCE_EN = 'A finite allowance is not accepted. Nothing was sent.';
export const FINITE_ALLOWANCE_KO = '유한한 허용량은 받지 않습니다. 보내지 않았습니다.';

function functionCallOf(permission) {
  if (!permission || typeof permission !== 'object' || Array.isArray(permission)) return null;
  const call = permission.FunctionCall;
  if (!call || typeof call !== 'object' || Array.isArray(call)) return null;
  return call;
}

function methodsExact(call) {
  const methods = Array.isArray(call.method_names) ? call.method_names : null;
  return Boolean(
    methods
    && methods.length === AGENT_METHOD_NAMES.length
    && methods.every((name, index) => name === AGENT_METHOD_NAMES[index]),
  );
}

function receiverExact(call, gateId) {
  return typeof call.receiver_id === 'string' && call.receiver_id === gateId;
}

function isFullAccessShape(permission) {
  if (permission === 'FullAccess') return true;
  if (!permission || typeof permission !== 'object' || Array.isArray(permission)) return false;
  if (Object.prototype.hasOwnProperty.call(permission, 'FullAccess')) return true;
  if (Object.prototype.hasOwnProperty.call(permission, 'GasKeyFullAccess')) return true;
  return false;
}

// Public keys and permission fields only. Never include a secret.
export function summarizeAccessKeys(list) {
  const keys = Array.isArray(list?.keys) ? list.keys : [];
  return keys.map((row) => {
    const permission = row?.access_key?.permission ?? null;
    const call = permission && typeof permission === 'object' ? permission.FunctionCall : null;
    let summary = permission;
    if (permission === 'FullAccess') summary = 'FullAccess';
    else if (call) {
      summary = {
        FunctionCall: {
          receiver_id: call.receiver_id ?? null,
          method_names: Array.isArray(call.method_names) ? call.method_names : [],
          allowance: call.allowance ?? null,
        },
      };
    }
    return {
      public_key: typeof row?.public_key === 'string' ? row.public_key : null,
      permission: summary,
    };
  });
}

export function agentKeyScopeCode(permission, gateId) {
  if (isFullAccessShape(permission)) return 'full_access_key_refused';
  const call = functionCallOf(permission);
  if (!call || !receiverExact(call, gateId) || !methodsExact(call)) return 'key_scope_mismatch';
  // null and a missing field are unlimited. Any other value is a finite allowance.
  if (call.allowance != null) return 'key_scope_mismatch';
  return null;
}

function finiteAllowanceOnly(permission, gateId) {
  const call = functionCallOf(permission);
  if (!call || !receiverExact(call, gateId) || !methodsExact(call)) return false;
  return call.allowance != null;
}

export function describeAgentKeyScope(permission, gateId) {
  const code = agentKeyScopeCode(permission, gateId);
  if (!code) return null;
  if (finiteAllowanceOnly(permission, gateId)) {
    return { code, reason_en: FINITE_ALLOWANCE_EN, reason_ko: FINITE_ALLOWANCE_KO };
  }
  const described = describeReason(code);
  return { code, reason_en: described.reason_en, reason_ko: described.reason_ko };
}

function scopeError(permission, gateId) {
  const described = describeAgentKeyScope(permission, gateId);
  if (!described) return null;
  const error = coded(described.code, described.reason_en);
  error.reason_en = described.reason_en;
  error.reason_ko = described.reason_ko;
  return error;
}

function rpcErrorNames(error) {
  const names = [];
  const seen = new Set();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (typeof current.name === 'string' && current.name && !names.includes(current.name)) names.push(current.name);
    if (typeof current.type === 'string' && current.type && !names.includes(current.type)) names.push(current.type);
    const ctor = current.constructor && current.constructor.name;
    if (typeof ctor === 'string' && ctor && ctor !== 'Object' && !names.includes(ctor)) names.push(ctor);
    current = current.cause;
  }
  return names;
}

// Unknown access key is a scope failure. Every other read failure is rpc_preflight.
// Classification uses the structured name, not the message text.
export function keyReadError(error) {
  if (
    error?.code === 'rpc_preflight'
    || error?.code === 'chain_id_refused'
    || error?.code === 'key_refused'
    || error?.code === 'full_access_key_refused'
    || error?.code === 'key_scope_mismatch'
  ) return error;
  const names = rpcErrorNames(error);
  if (names.includes('UNKNOWN_ACCESS_KEY') || names.includes('AccessKeyDoesNotExistError')) {
    const described = describeReason('key_scope_mismatch');
    const mapped = coded('key_scope_mismatch', described.reason_en);
    mapped.reason_en = described.reason_en;
    mapped.reason_ko = described.reason_ko;
    return mapped;
  }
  const detail = redact(error?.name || error?.message || 'error');
  return coded('rpc_preflight', `Could not read the agent access key (${detail}). Nothing was sent.`);
}

// Reads view_access_key for the account and the public key derived from private_key.
// Throws full_access_key_refused or key_scope_mismatch. Does not send.
export async function assertAgentFunctionCallKey(networkName, gateId, signer = null, rpcUrl = null) {
  const key = signer || loadAgentKey();
  assertAccountNotMainnet(key.accountId);
  let view;
  try {
    view = await viewAccessKey(networkName, key.accountId, key.publicKey, rpcUrl ? { url: rpcUrl } : undefined);
  } catch (error) {
    throw keyReadError(error);
  }
  const problem = scopeError(view?.permission, gateId);
  if (problem) throw problem;
  return view;
}

// pay() amounts are decimal NEAR by default. "5" and "5 NEAR" are 5 NEAR.
// A yocto or yoctonear suffix is an integer count of yoctoNEAR.
// Zero is parsed here and refused by pay() before a transaction is built.
export function parseAmount(input) {
  if (typeof input === 'bigint') {
    if (input < 0n) throw new Error('amount must be non-negative');
    if (input > U128_MAX) throw new Error('amount exceeds u128');
    return input;
  }
  if (typeof input !== 'string') throw new Error('amount must be a string');
  const compact = input.trim().toLowerCase().replace(/[\s_]/g, '');
  let mode = 'near';
  let num = compact;
  if (compact.endsWith('yoctonear')) {
    mode = 'yocto';
    num = compact.slice(0, -'yoctonear'.length);
  } else if (compact.endsWith('yocto')) {
    mode = 'yocto';
    num = compact.slice(0, -'yocto'.length);
  } else if (compact.endsWith('near')) {
    num = compact.slice(0, -'near'.length);
  }
  if (mode === 'yocto') {
    if (!/^\d+$/.test(num)) throw new Error('yocto amount must be an integer string');
    const value = BigInt(num);
    if (value > U128_MAX) throw new Error('amount exceeds u128');
    return value;
  }
  if (!/^\d+(\.\d+)?$/.test(num)) throw new Error('not a NEAR amount');
  const [whole, frac = ''] = num.split('.');
  if (frac.length > 24) throw new Error('NEAR amount has more than 24 decimal places');
  const value = BigInt(whole) * YN + BigInt(frac.padEnd(24, '0'));
  if (value > U128_MAX) throw new Error('amount exceeds u128');
  return value;
}

// Mandate files store the signed U128. A bare integer is yocto. A decimal or a
// NEAR suffix is decimal NEAR. pay() is different: a bare integer there is NEAR.
function parseMandateAmount(input) {
  if (typeof input === 'bigint') {
    if (input < 0n || input > U128_MAX) throw new Error('mandate amount is out of range');
    return input;
  }
  if (typeof input === 'number') {
    if (!Number.isSafeInteger(input) || input < 0) throw new Error('mandate amount must be a string');
    return BigInt(input);
  }
  const compact = String(input).trim().toLowerCase().replace(/[\s_]/g, '');
  if (compact.endsWith('yocto') || compact.endsWith('yoctonear') || compact.endsWith('near') || compact.includes('.')) {
    return parseAmount(String(input).trim());
  }
  if (!/^\d+$/.test(compact)) throw new Error('bad mandate amount');
  const value = BigInt(compact);
  if (value > U128_MAX) throw new Error('mandate amount exceeds u128');
  return value;
}

function yoctoText(value) {
  return parseMandateAmount(value).toString();
}

function canonSerial(value) {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new Error('serial must be non-negative');
    return value.toString();
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('serial must be a safe integer or a decimal string');
    return String(value);
  }
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw new Error('serial must be an integer');
  return BigInt(text).toString();
}

function chainSerial(serial) {
  const value = BigInt(canonSerial(serial));
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return value.toString();
  return Number(value);
}

function expiresAtNs(value) {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new Error('expires_at must be non-negative');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('expires_at must be a decimal string');
    return BigInt(value);
  }
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw new Error('expires_at must be an integer');
  return BigInt(text);
}

function nowNs() {
  return BigInt(Date.now()) * 1_000_000n;
}

// Stored as given when it is printable and at most 200 characters. Otherwise rejected.
export function acceptedSource(source) {
  if (typeof source !== 'string') return null;
  if (source.length > SOURCE_MAX) return null;
  if (typeof source.isWellFormed === 'function' && !source.isWellFormed()) return null;
  for (let i = 0; i < source.length; i++) {
    const c = source.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) return null;
  }
  return source;
}

function defaultAgentKeyPath() {
  return process.env.CHOPGATE_AGENT_KEY || path.join(os.homedir(), '.chopgate', 'agent-key.json');
}

function defaultMandatesDir() {
  return process.env.CHOPGATE_MANDATES || path.join(os.homedir(), '.chopgate', 'mandates');
}

function ledgerFile() {
  return process.env.CHOPGATE_LEDGER || path.join(os.homedir(), '.chopgate', 'ledger.jsonl');
}

export function loadAgentKey(file = defaultAgentKeyPath()) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === 'ELOOP') throw coded('key_refused', 'agent key must be a regular file');
    throw error;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw coded('key_refused', 'agent key must be a regular file');
    if ((st.mode & 0o077) !== 0 || (st.mode & 0o777) !== 0o600) {
      throw coded('key_refused', 'agent key must be mode 600 (no group or other access)');
    }
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) {
      const n = fs.readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    let json;
    try {
      json = JSON.parse(buf.subarray(0, off).toString('utf8'));
    } catch {
      throw coded('key_refused', 'agent key file is not valid JSON');
    }
    // null, arrays, and other non-objects are not a key file. JSON.parse of
    // those values succeeds, then property access would throw a raw TypeError.
    if (json === null || typeof json !== 'object' || Array.isArray(json)) {
      throw coded('key_refused', 'agent key file must be a JSON object');
    }
    const accountId = json.account_id;
    const publicKey = json.public_key;
    // Console download: type chopgate-agent-key and numeric version 1. Any other
    // version of that type is refused and does not fall through to private_key.
    // Both secret fields on one object are ambiguous. Every other object stays
    // the NEAR CLI shape. Console errors name secret_key.
    const resolved = privateKeyFromAgentFile(json);
    const privateKey = resolved.privateKey;
    const secretField = resolved.secretField;
    if (typeof accountId !== 'string' || typeof publicKey !== 'string' || typeof privateKey !== 'string') {
      throw coded('key_refused', `agent key file must contain account_id, public_key, and ${secretField} strings`);
    }
    if (!privateKey.startsWith('ed25519:')) throw coded('key_refused', 'agent key must be an ed25519 NEAR secret key');
    let derivedPublic;
    try {
      derivedPublic = KeyPair.fromString(privateKey).getPublicKey().toString();
    } catch {
      throw coded('key_refused', 'agent key must be an ed25519 NEAR secret key');
    }
    // view_access_key must query this key. A file public_key that names another key is refused.
    if (derivedPublic !== publicKey) {
      throw coded('key_refused', `agent key public_key does not match the key derived from ${secretField}`);
    }
    const signer = {
      accountId,
      publicKey: derivedPublic,
      toJSON() {
        return { accountId, publicKey: derivedPublic };
      },
      account(nearProvider) {
        return new Account(accountId, nearProvider, privateKey);
      },
      // Nonce and block hash come from the same final view_access_key used for the scope check.
      async signCheckedTransaction({ receiverId, actions: txActions, accessKeyView }) {
        const nonceRaw = accessKeyView?.nonce;
        const blockHash = accessKeyView?.block_hash;
        if (nonceRaw === undefined || nonceRaw === null || typeof blockHash !== 'string' || blockHash.length === 0) {
          throw new Error('access key view is missing the nonce or the block hash');
        }
        const tx = createTransaction(
          accountId,
          PublicKey.from(derivedPublic),
          receiverId,
          BigInt(nonceRaw) + 1n,
          txActions,
          baseDecode(blockHash),
        );
        const { signedTransaction } = await KeyPairSigner.fromSecretKey(privateKey).signTransaction(tx);
        return signedTransaction;
      },
    };
    return signer;
  } finally {
    fs.closeSync(fd);
  }
}

function keyFromSeed(seed) {
  const raw = Buffer.isBuffer(seed) ? seed : Buffer.from(seed);
  if (raw.length !== 32) throw new Error('owner signing seed must be 32 bytes');
  const pkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    raw,
  ]);
  const privateKey = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const spki = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const pub = new Uint8Array(spki.subarray(spki.length - 32));
  return {
    publicKey: `ed25519:${b58encode(pub)}`,
    publicBytes: pub,
    sign(message) {
      return new Uint8Array(crypto.sign(null, Buffer.from(message), privateKey));
    },
  };
}

// NEAR KeyPairEd25519 reads the first 32 bytes as the seed. The secret string is
// ed25519: plus base58(seed || public_32). The string stays in memory.
function nearPrivateKeyFromSeed(seed) {
  const raw = Buffer.isBuffer(seed) ? seed : Buffer.from(seed);
  const derived = keyFromSeed(raw);
  if (derived.publicBytes.length !== 32) throw new Error('ed25519 public key must be 32 bytes');
  return `ed25519:${baseEncode(Buffer.concat([raw, Buffer.from(derived.publicBytes)]))}`;
}

function privateKeyFromAgentFile(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw coded('key_refused', 'agent key file must be a JSON object');
  }
  const hasSecret = Object.prototype.hasOwnProperty.call(json, 'secret_key');
  const hasPrivate = Object.prototype.hasOwnProperty.call(json, 'private_key');
  // Exact type with any version other than the number 1, including a missing
  // version or the string "1". Do not fall through to private_key.
  if (json.type === 'chopgate-agent-key' && json.version !== 1) {
    throw coded('key_refused', 'unsupported key file version');
  }
  // Ambiguous which secret to use, with or without the console type and version.
  if (hasSecret && hasPrivate) {
    throw coded('key_refused', 'ambiguous which secret to use');
  }
  if (json.type === 'chopgate-agent-key') {
    const secret = typeof json.secret_key === 'string' ? json.secret_key.trim() : '';
    if (!/^[0-9a-fA-F]{64}$/.test(secret)) {
      throw coded('key_refused', 'agent key secret_key must be 64 hex characters');
    }
    try {
      return {
        privateKey: nearPrivateKeyFromSeed(Buffer.from(secret, 'hex')),
        secretField: 'secret_key',
      };
    } catch (error) {
      if (error && error.code === 'key_refused') throw error;
      throw coded('key_refused', 'agent key secret_key must be an ed25519 seed');
    }
  }
  return { privateKey: json.private_key, secretField: 'private_key' };
}

export function publicKeyFromSeed(seed) {
  return keyFromSeed(seed).publicKey;
}

export function readSeedFile(file) {
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(text)) throw new Error('owner signing key file must be 64 hex characters');
  return Buffer.from(text, 'hex');
}

// Signs authorizationBytes(domain, payload). The seed never leaves this function's return value.
export function signOwnerPayload(seed, chainId, deploymentId, ownerPk, payload) {
  const key = keyFromSeed(seed);
  const message = authorizationBytes(chainId, deploymentId, ownerPk, payload);
  const signature = Buffer.from(key.sign(message)).toString('hex');
  return { publicKey: key.publicKey, signature };
}

export async function loadMandates(dir = defaultMandatesDir()) {
  if (!fs.existsSync(dir)) throw new Error(`mandates directory not found: ${dir}`);
  const names = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  const mandates = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!json || !Array.isArray(json.entries)) {
      throw new Error(`mandate ${name} has no entries array`);
    }
    if (!json.gate || json.serial === undefined || !json.network || !json.agent) {
      throw new Error(`mandate ${name} is missing network, gate, agent, or serial`);
    }
    const serial = canonSerial(json.serial);
    const entries = [];
    for (let index = 0; index < json.entries.length; index++) {
      const entry = json.entries[index];
      if (typeof entry.instruction !== 'string') throw new Error(`mandate ${name} entry ${index} has no instruction`);
      const hash = await sha256hex(entry.instruction);
      if (entry.instruction_hash !== undefined && entry.instruction_hash !== null && entry.instruction_hash !== '') {
        if (String(entry.instruction_hash).toLowerCase() !== hash) {
          throw new Error(`mandate ${name} entry ${index} instruction_hash does not match sha256(instruction)`);
        }
      }
      entries.push({
        index,
        action: String(entry.action),
        target: String(entry.target),
        max_amount: yoctoText(entry.max_amount),
        max_amount_yocto: parseMandateAmount(entry.max_amount),
        instruction: entry.instruction,
        instruction_hash: hash,
      });
    }
    mandates.push({
      file,
      network: String(json.network),
      gate: String(json.gate),
      agent: String(json.agent || ''),
      serial,
      budget: yoctoText(json.budget),
      budget_yocto: parseMandateAmount(json.budget),
      expires_at: expiresAtNs(json.expires_at).toString(),
      entries,
    });
  }
  return mandates;
}

function entryId(mandate, index) {
  return `${mandate.gate}#${mandate.serial}:${index}`;
}

function parseEntryId(entryIdText) {
  const match = /^(.+)#(\d+):(\d+)$/.exec(String(entryIdText));
  if (!match) throw new Error('entry_id must look like <gate>#<serial>:<index>');
  return { gate: match[1], serial: canonSerial(match[2]), index: Number(match[3]) };
}

// Same tuple serde_json emits for (action, target, U128, instruction_hash, caller).
export function fingerprintOf(action, target, amountYocto, instructionHash, caller) {
  return JSON.stringify([action, target, amountYocto, instructionHash, caller]);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function inspectLock(lockFile) {
  let st;
  try {
    st = fs.statSync(lockFile);
  } catch (error) {
    if (error.code === 'ENOENT') return { missing: true };
    throw error;
  }
  const age = Date.now() - st.mtimeMs;
  let pid = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    if (parsed && Number.isInteger(parsed.pid)) pid = parsed.pid;
  } catch {
    /* the owner may still be writing the lock body */
  }
  const alive = pidAlive(pid);
  const stale = age > STALE_LOCK_MS || (pid !== null && !alive && age > 1000);
  return { missing: false, pid, age, alive, stale };
}

// Exclusive lock around ledger check and append. The wait is at most a few seconds.
// A stale lock is reported. It is not deleted and it is not spun on.
export function withLedgerLock(fn) {
  const lockFile = `${ledgerFile()}.lock`;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd = null;
  while (fd === null) {
    try {
      fd = fs.openSync(lockFile, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = inspectLock(lockFile);
      if (info.missing) continue;
      if (info.stale) {
        throw coded(
          'ledger_locked',
          `stale ledger lock at ${lockFile} (pid ${info.pid ?? 'unknown'}, age ${Math.round(info.age)}ms). Nothing was sent. Remove the lock file only if no ChopGate process is running.`,
        );
      }
      if (Date.now() >= deadline) {
        throw coded(
          'ledger_locked',
          `ledger lock held by pid ${info.pid ?? 'unknown'} at ${lockFile}. Nothing was sent.`,
        );
      }
      sleepMs(LOCK_POLL_MS);
    }
  }
  try {
    fs.writeSync(fd, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
    fs.fsyncSync(fd);
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(lockFile); } catch { /* already removed */ }
  }
}

function readLedger() {
  const file = ledgerFile();
  if (!fs.existsSync(file)) return { rows: [], corrupt: false, corrupt_lines: 0 };
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const rows = [];
  let corrupt = false;
  let corrupt_lines = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') continue;
    try {
      const row = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        corrupt = true;
        corrupt_lines += 1;
        rows.push({ parse_error: true, line: i + 1 });
      } else {
        rows.push(row);
      }
    } catch {
      corrupt = true;
      corrupt_lines += 1;
      rows.push({ parse_error: true, line: i + 1 });
    }
  }
  return { rows, corrupt, corrupt_lines };
}

function readLedgerLocked() {
  return withLedgerLock(() => readLedger());
}

function appendLedgerRaw(row) {
  const file = ledgerFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(row)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try { fs.chmodSync(file, 0o600); } catch { /* the create mode is 600 */ }
}

function recordRow(row) {
  try {
    withLedgerLock(() => appendLedgerRaw(row));
  } catch (error) {
    if (error.code !== 'ledger_locked') throw error;
  }
}

// Retries only the local ledger append. It never broadcasts again.
function appendResultWithRetry(row) {
  let last = null;
  for (let attempt = 0; attempt < RESULT_APPEND_TRIES; attempt++) {
    try {
      withLedgerLock(() => appendLedgerRaw(row));
      return { ok: true };
    } catch (error) {
      last = error;
      if (attempt + 1 < RESULT_APPEND_TRIES) sleepMs(RESULT_APPEND_WAIT_MS);
    }
  }
  return { ok: false, error: last };
}

function sameLedgerAttempt(row, gate, serial, fp) {
  return row.gate === gate && String(row.serial) === String(serial) && row.fingerprint === fp;
}

// A fingerprint was already attempted when an intent has no closing result, or a
// result says the broadcast happened or the outcome is unknown. A result that
// says broadcast did not happen closes the intent and does not block a later call.
// The contract fingerprint is per mandate, so the match includes serial.
export function broadcastPossible(rows, gate, serial, fp) {
  const resultsByAttempt = new Map();
  for (const row of rows) {
    if (!row || row.parse_error || row.phase === 'intent' || !row.attempt_id) continue;
    if (!sameLedgerAttempt(row, gate, serial, fp)) continue;
    const list = resultsByAttempt.get(row.attempt_id) || [];
    list.push(row);
    resultsByAttempt.set(row.attempt_id, list);
  }
  const seenIntent = new Set();
  for (const row of rows) {
    if (!row || row.parse_error) continue;
    if (!sameLedgerAttempt(row, gate, serial, fp)) continue;
    if (row.phase === 'intent') {
      seenIntent.add(row.attempt_id);
      const results = resultsByAttempt.get(row.attempt_id) || [];
      if (results.length === 0) return true;
      const closedSafe = results.every((item) => item.broadcast === false && item.sent === false);
      if (!closedSafe) return true;
      continue;
    }
    if (row.attempt_id && seenIntent.has(row.attempt_id)) continue;
    if (row.broadcast === true || row.sent === true || row.sent === 'unknown') return true;
  }
  return false;
}

function collectLogs(outcome) {
  const logs = [];
  const push = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const line of arr) if (typeof line === 'string') logs.push(line);
  };
  push(outcome?.transaction_outcome?.outcome?.logs);
  for (const receipt of outcome?.receipts_outcome || []) push(receipt?.outcome?.logs);
  return logs;
}

export function parseEventLogs(logs) {
  const events = [];
  for (const line of logs) {
    const at = line.indexOf('EVENT_JSON:');
    if (at < 0) continue;
    try {
      events.push(JSON.parse(line.slice(at + 'EVENT_JSON:'.length)));
    } catch {
      /* a non-json log line is not a ChopGate event */
    }
  }
  return events;
}

export function interpretOutcome(outcome) {
  const events = parseEventLogs(collectLogs(outcome));
  const decisionEvent = events.find((event) => event.event === 'decision');
  const fromReturn = getTransactionLastResult(outcome);
  const decision = decisionEvent?.data?.[0] || (fromReturn && fromReturn.reason_code ? fromReturn : null);
  const pending = events.find((event) => event.event === 'pending_created');
  const pendingId = pending?.data?.[0]?.id;
  const failure = outcome?.status && typeof outcome.status === 'object' ? outcome.status.Failure : undefined;
  const txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id || null;
  return { events, decision, pendingId, failure, txHash };
}

// NEAR tx hash is base58(sha256(borsh(Transaction))), without the signature.
async function hashTransaction(signed) {
  const tx = signed?.transaction;
  if (!tx) throw new Error('signed transaction has no transaction body');
  const bytes = encodeTransaction(tx);
  return baseEncode(await sha256(bytes));
}

function preflightTimeout(error) {
  if (!error) return false;
  if (error.code === 'rpc_preflight' || error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  return /timed out|aborted/i.test(String(error.message || ''));
}

async function listIndexTxs(api, gate, budget) {
  const rows = [];
  let resume;
  for (let page = 0; page < 25; page++) {
    budget.ensure('tx index');
    const timeoutMs = Math.min(callTimeoutMs(), budget.left());
    const body = {
      account_id: gate,
      is_receiver: true,
      is_function_call: true,
      limit: 200,
      desc: false,
    };
    if (resume) body.resume_token = resume;
    let response;
    try {
      response = await fetch(api, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (preflightTimeout(error)) {
        throw coded('rpc_preflight', 'tx index timed out. Nothing was sent.');
      }
      throw error;
    }
    if (!response.ok) throw new Error(`tx index HTTP ${response.status}`);
    const json = await response.json();
    if (!Array.isArray(json.account_txs)) throw new Error('tx index response has no account_txs');
    rows.push(...json.account_txs);
    if (!json.resume_token || json.account_txs.length === 0) return rows;
    resume = json.resume_token;
  }
  throw new Error('tx index history is longer than the page cap; not guessing from a partial list');
}

async function txStatus(networkName, gate, txHash) {
  const net = assertNetworkEnabled(networkName);
  const urls = urlList(net.archivalRpc);
  if (urls.length === 0) urls.push(...urlList(net.rpc));
  let last;
  for (const url of urls) {
    try {
      const provider = providerFor(url);
      return await withTimeout(
        provider.viewTransactionStatusWithReceipts({
          txHash,
          accountId: gate,
          waitUntil: 'FINAL',
        }),
        viewTimeoutMs(),
        'tx status',
      );
    } catch (error) {
      last = error;
    }
  }
  throw last || new Error('no archival rpc');
}

export async function chainDecisions(networkName, gate) {
  const net = assertNetworkEnabled(networkName);
  const api = String(net.txIndexApi || '').trim();
  if (!api) return { ok: false, error: 'tx index api is empty', decisions: [] };
  const deadline = Date.now() + replayDeadlineMs();
  const budget = {
    left() {
      return deadline - Date.now();
    },
    ensure(label) {
      if (this.left() <= 0) {
        throw coded('rpc_preflight', `${label} exceeded the replay deadline. Nothing was sent.`);
      }
    },
  };
  let rows;
  try {
    rows = await listIndexTxs(api, gate, budget);
  } catch (error) {
    if (preflightTimeout(error)) {
      throw error?.code === 'rpc_preflight'
        ? error
        : coded('rpc_preflight', 'tx index timed out. Nothing was sent.');
    }
    return { ok: false, error: `tx index unreadable: ${error.message || error}`, decisions: [] };
  }
  const seen = new Set();
  const unique = [];
  for (const row of rows) {
    const hash = row.transaction_hash || row.hash || row.tx_hash;
    if (!hash || seen.has(hash)) continue;
    seen.add(hash);
    unique.push({
      hash,
      block_height: Number(row.tx_block_height ?? row.block_height ?? 0),
      tx_index: Number(row.tx_index ?? 0),
    });
  }
  unique.sort((a, b) => a.block_height - b.block_height || a.tx_index - b.tx_index);
  const decisions = [];
  for (const row of unique) {
    let outcome;
    try {
      budget.ensure('archival tx status');
      outcome = await withTimeout(
        txStatus(networkName, gate, row.hash),
        Math.min(callTimeoutMs(), budget.left()),
        'archival tx status',
      );
    } catch (error) {
      if (preflightTimeout(error)) {
        throw error?.code === 'rpc_preflight'
          ? error
          : coded('rpc_preflight', 'archival tx status timed out. Nothing was sent.');
      }
      return {
        ok: false,
        error: `archival tx status failed for ${row.hash}: ${error.message || error}`,
        decisions: [],
      };
    }
    const signer = outcome?.transaction?.signer_id || outcome?.transaction?.signerId || null;
    const parsed = interpretOutcome(outcome);
    for (const event of parsed.events) {
      if (event.event !== 'decision' || !event.data?.[0]) continue;
      decisions.push({
        block_height: row.block_height,
        tx_index: row.tx_index,
        tx_hash: row.hash,
        signer,
        decision: event.data[0],
      });
    }
  }
  return { ok: true, error: null, decisions };
}

function asYocto(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  return BigInt(String(value));
}

export function firstFit(entries, used, action, target, instructionHash, amount) {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (used[i]) continue;
    if (entry.action !== action || entry.target !== target) continue;
    if (entry.instruction_hash !== instructionHash) continue;
    if (amount > entry.max_amount_yocto) continue;
    return i;
  }
  return -1;
}

export function replay(mandate, steps) {
  const used = mandate.entries.map(() => false);
  let blocks = 0;
  let last = null;
  let frozen = false;
  let consumed = 0n;
  const evidence = mandate.entries.map(() => null);
  let explained = true;
  for (const step of steps) {
    const decision = step.decision;
    if (String(decision.serial) !== String(mandate.serial)) continue;
    if (decision.action === 'register') continue;
    const reason = decision.reason_code;
    const amount = asYocto(decision.amount || '0');
    if (CONSUME.has(reason)) {
      const index = firstFit(
        mandate.entries,
        used,
        decision.action,
        decision.target,
        decision.instruction_hash,
        amount,
      );
      if (index < 0) {
        explained = false;
        continue;
      }
      used[index] = true;
      consumed += amount;
      blocks = 0;
      last = null;
      evidence[index] = {
        tx_hash: step.tx_hash || null,
        reason_code: reason,
        caller: step.signer || null,
      };
      continue;
    }
    if (NO_STATE.has(reason)) continue;
    if (!frozen) {
      blocks += 1;
      const fp = fingerprintOf(
        decision.action,
        decision.target,
        amount.toString(),
        decision.instruction_hash,
        step.signer || '',
      );
      if (blocks >= 3 || (last !== null && last === fp)) frozen = true;
      last = fp;
    }
  }
  return { used, blocks, frozen, consumed, evidence, explained, last };
}

function ledgerSteps(mandate, rows) {
  return rows
    .filter((row) => row && !row.parse_error && row.phase !== 'intent')
    .filter((row) => row.broadcast && row.gate === mandate.gate && String(row.serial) === String(mandate.serial))
    .filter((row) => row.reason_code && !LOCAL_REASONS.has(row.reason_code))
    .map((row) => ({
      tx_hash: row.tx_hash || null,
      signer: row.caller,
      decision: {
        serial: mandate.serial,
        action: row.action,
        target: row.target,
        amount: row.amount,
        instruction_hash: row.instruction_hash,
        reason_code: row.reason_code,
      },
    }));
}

function remainingToBigint(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return asYocto(value);
  return null;
}

function reasonFields(code) {
  if (code === undefined || code === null || code === '') {
    return {
      reason_code: null,
      reason_en: 'No decision recorded.',
      reason_ko: '기록된 결정이 없습니다.',
      verdict_kind: null,
    };
  }
  const described = describeReason(code);
  return {
    reason_code: described.reason_code,
    reason_en: described.reason_en,
    reason_ko: described.reason_ko,
    verdict_kind: described.verdict_kind,
  };
}

function freezeFields(replayed, known, from) {
  if (!known || replayed.frozen === null || replayed.blocks === null || from !== 'chain') {
    if (known && from === 'local-ledger' && replayed.frozen !== null && replayed.blocks !== null) {
      const last = replayed.last || null;
      const next = replayed.frozen ? false : (replayed.blocks >= 2 || last !== null);
      return {
        frozen: replayed.frozen,
        blocks_in_a_row: replayed.blocks,
        next_block_would_freeze: next,
        last_block_fingerprint: last,
        freeze_known_from: 'local-ledger',
        freeze_warning_en: FREEZE_LOCAL_BOUND_EN,
        freeze_warning_ko: FREEZE_LOCAL_BOUND_KO,
      };
    }
    return {
      frozen: null,
      blocks_in_a_row: null,
      next_block_would_freeze: null,
      last_block_fingerprint: null,
      freeze_known_from: 'local-ledger',
      freeze_warning_en: FREEZE_UNKNOWN_EN,
      freeze_warning_ko: FREEZE_UNKNOWN_KO,
    };
  }
  const last = replayed.last || null;
  // blocks >= 2: any next refusal freezes. A stored fingerprint: repeating that call freezes.
  const next = replayed.frozen ? false : (replayed.blocks >= 2 || last !== null);
  return {
    frozen: replayed.frozen,
    blocks_in_a_row: replayed.blocks,
    next_block_would_freeze: next,
    last_block_fingerprint: last,
    freeze_known_from: 'chain',
    freeze_warning_en: FREEZE_WARNING_EN,
    freeze_warning_ko: FREEZE_WARNING_KO,
  };
}

function unresolvedSends(rows, explainedHashes) {
  const resultsByAttempt = new Map();
  for (const row of rows) {
    if (!row || row.parse_error || row.phase === 'intent' || !row.attempt_id) continue;
    const list = resultsByAttempt.get(row.attempt_id) || [];
    list.push(row);
    resultsByAttempt.set(row.attempt_id, list);
  }
  const out = [];
  const push = (row, phase) => {
    const fields = reasonFields(row.reason_code || 'rpc_uncertain');
    out.push({
      attempt_id: row.attempt_id || null,
      phase,
      entry_id: row.entry_id || null,
      gate: row.gate || null,
      serial: row.serial == null ? null : String(row.serial),
      fingerprint: row.fingerprint || null,
      tx_hash: row.tx_hash || null,
      at: row.at || null,
      sent: row.sent ?? null,
      ...fields,
    });
  };
  for (const row of rows) {
    if (!row || row.parse_error) continue;
    if (row.phase === 'intent') {
      const results = resultsByAttempt.get(row.attempt_id) || [];
      if (results.length === 0) push(row, 'intent');
      continue;
    }
    const unknown = row.sent === 'unknown' || row.reason_code === 'rpc_uncertain';
    if (!unknown || row.broadcast !== true) continue;
    if (row.tx_hash && explainedHashes.has(row.tx_hash)) continue;
    push(row, 'unknown');
  }
  return out;
}

export async function status(options = {}) {
  const mandates = await loadMandates();
  const wanted = options.gate ? String(options.gate) : null;
  const selected = wanted ? mandates.filter((mandate) => mandate.gate === wanted) : mandates;
  let ledger;
  try {
    ledger = readLedgerLocked();
  } catch (error) {
    if (error.code !== 'ledger_locked') throw error;
    const fields = reasonFields('ledger_locked');
    return {
      source: 'local-only',
      index_error: redact(error.message),
      ledger_corrupt: false,
      ledger_corrupt_lines: 0,
      ledger_locked: true,
      unresolved_sends: [],
      mandates: [],
      entries: [],
      ...fields,
      message: redact(error.message),
    };
  }
  const byGate = new Map();
  const summaries = [];
  const entries = [];
  let anyIndexError = null;
  let anyChain = false;
  let anyLocal = false;
  const explainedHashes = new Set();
  const seenSerial = new Set();
  const chainByNetwork = new Map();

  for (const mandate of selected) {
    const dupKey = `${mandate.gate}#${mandate.serial}`;
    const duplicateFile = seenSerial.has(dupKey);
    seenSerial.add(dupKey);
    let accountRefused = null;
    try {
      assertNetworkEnabled(mandate.network);
      assertAccountNotMainnet(mandate.gate);
      assertAccountNotMainnet(mandate.agent);
    } catch (error) {
      accountRefused = error.code === 'network_not_enabled' ? error : coded('network_not_enabled', error.message);
    }
    if (accountRefused) {
      const fields = reasonFields('network_not_enabled');
      const freeze = freezeFields({ frozen: null, blocks: null, last: null }, false, 'local-ledger');
      summaries.push({
        network: mandate.network,
        gate: mandate.gate,
        agent: mandate.agent,
        serial: mandate.serial,
        registered: false,
        remaining_budget: null,
        budget: mandate.budget,
        source: 'local-only',
        note: redact(accountRefused.message),
        duplicate_mandate_file: duplicateFile,
        expired: expiresAtNs(mandate.expires_at) <= nowNs(),
        chain_id_refused: false,
        ...freeze,
        ...fields,
      });
      anyLocal = true;
      mandate.entries.forEach((entry, index) => {
        const expired = expiresAtNs(mandate.expires_at) <= nowNs();
        const entryFields = expired ? reasonFields('mandate_expired_not_sent') : fields;
        entries.push({
          entry_id: entryId(mandate, index),
          action: entry.action,
          target: entry.target,
          max_amount: entry.max_amount,
          instruction: entry.instruction,
          state: expired ? 'expired' : 'unknown',
          ...entryFields,
          evidence: {
            source: 'local-only',
            note: redact(accountRefused.message),
            mandate_frozen: null,
            blocks_in_a_row: null,
            freeze_known_from: freeze.freeze_known_from,
            remaining_budget: null,
            tx_hash: null,
            caller: null,
            ...entryFields,
          },
        });
      });
      continue;
    }

    let chainResult = chainByNetwork.get(mandate.network);
    if (!chainResult) {
      try {
        const checked = await assertRpcChain(mandate.network);
        chainResult = { ok: true, chainId: checked.chainId, rpcUrl: checked.url };
      } catch (error) {
        if (error?.code === 'rpc_preflight') throw error;
        chainResult = { ok: false, error };
      }
      chainByNetwork.set(mandate.network, chainResult);
    }
    if (!chainResult.ok) {
      const fields = reasonFields('chain_id_refused');
      const freeze = freezeFields({ frozen: null, blocks: null, last: null }, false, 'local-ledger');
      const expired = expiresAtNs(mandate.expires_at) <= nowNs();
      summaries.push({
        network: mandate.network,
        gate: mandate.gate,
        agent: mandate.agent,
        serial: mandate.serial,
        registered: false,
        remaining_budget: null,
        budget: mandate.budget,
        source: 'local-only',
        note: redact(chainResult.error?.message || 'rpc chain_id refused'),
        duplicate_mandate_file: duplicateFile,
        expired,
        chain_id_refused: true,
        ...freeze,
        ...fields,
      });
      anyLocal = true;
      mandate.entries.forEach((entry, index) => {
        const entryFields = expired ? reasonFields('mandate_expired_not_sent') : fields;
        entries.push({
          entry_id: entryId(mandate, index),
          action: entry.action,
          target: entry.target,
          max_amount: entry.max_amount,
          instruction: entry.instruction,
          state: expired ? 'expired' : 'unknown',
          ...entryFields,
          evidence: {
            source: 'local-only',
            note: redact(chainResult.error?.message || ''),
            mandate_frozen: null,
            blocks_in_a_row: null,
            freeze_known_from: 'local-ledger',
            remaining_budget: null,
            tx_hash: null,
            caller: null,
            ...entryFields,
          },
        });
      });
      continue;
    }

    // Every status call reads view_access_key. There is no cache.
    await assertAgentFunctionCallKey(mandate.network, mandate.gate, null, chainResult.rpcUrl);

    const key = `${mandate.network}|${mandate.gate}`;
    if (!byGate.has(key)) {
      let history;
      try {
        history = await chainDecisions(mandate.network, mandate.gate);
      } catch (error) {
        if (error?.code === 'rpc_preflight') throw error;
        history = { ok: false, error: error.message || String(error), decisions: [] };
      }
      byGate.set(key, history);
    }
    const history = byGate.get(key);
    if (history.ok) {
      for (const row of history.decisions) if (row.tx_hash) explainedHashes.add(row.tx_hash);
    }
    let remaining = null;
    let viewError = null;
    try {
      remaining = remainingToBigint(await viewMethod(
        mandate.network,
        mandate.gate,
        'remaining_budget',
        { serial: chainSerial(mandate.serial) },
      ));
    } catch (error) {
      viewError = error.message || String(error);
    }

    const registered = remaining !== null && !viewError;
    let source = history.ok ? 'chain' : 'local-only';
    if (history.ok) anyChain = true;
    else {
      anyLocal = true;
      anyIndexError = history.error;
    }

    let replayed;
    let note;
    let freezeFrom = 'local-ledger';
    if (!registered) {
      replayed = {
        used: mandate.entries.map(() => false),
        blocks: null,
        frozen: null,
        last: null,
        evidence: mandate.entries.map(() => null),
        explained: false,
      };
      note = viewError
        ? `remaining_budget view failed: ${viewError}`
        : 'remaining_budget returned null, so this serial is not registered';
    } else if (!history.ok) {
      const local = replay(mandate, ledgerSteps(mandate, ledger.rows));
      const budgetLeft = mandate.budget_yocto - local.consumed;
      const matches = local.explained && budgetLeft === remaining && !ledger.corrupt;
      if (matches) {
        replayed = local;
        note = `${history.error}. Freeze counters are a lower bound from the local ledger plus remaining_budget, not chain history.`;
      } else {
        replayed = {
          used: local.used,
          blocks: null,
          frozen: null,
          last: null,
          evidence: local.evidence,
          explained: false,
        };
        note = ledger.corrupt
          ? `${history.error}. The ledger has a broken line, so freeze state is unknown.`
          : `${history.error}. The local ledger does not explain remaining_budget, so unrecorded entries stay unknown.`;
      }
    } else {
      const chainSteps = history.decisions.map((row) => ({
        tx_hash: row.tx_hash,
        signer: row.signer,
        decision: row.decision,
      }));
      const seen = new Set(chainSteps.map((step) => step.tx_hash).filter(Boolean));
      const extra = ledgerSteps(mandate, ledger.rows).filter((step) => !step.tx_hash || !seen.has(step.tx_hash));
      replayed = replay(mandate, chainSteps.concat(extra));
      const budgetLeft = mandate.budget_yocto - replayed.consumed;
      if (!replayed.explained || budgetLeft !== remaining || ledger.corrupt) {
        note = ledger.corrupt
          ? 'The ledger has a broken line. Freeze state is unknown even if some decisions were read.'
          : 'Chain decisions do not explain remaining_budget. Unmatched entries stay unknown.';
        replayed = { ...replayed, frozen: null, blocks: null, last: null, explained: false };
        freezeFrom = 'local-ledger';
      } else if (extra.length > 0) {
        note = 'Chain history plus local attempts that are not in the tx index yet. Freeze counters are a lower bound.';
        freezeFrom = 'local-ledger';
      } else {
        note = 'Replayed from gate decision events.';
        freezeFrom = 'chain';
      }
    }
    if (duplicateFile) note = `${note} Duplicate mandate file for this gate and serial.`;
    const mandateExpired = expiresAtNs(mandate.expires_at) <= nowNs();
    const known = registered && replayed.explained && replayed.frozen !== null && replayed.blocks !== null;
    const freeze = freezeFields(replayed, known, freezeFrom);
    summaries.push({
      network: mandate.network,
      gate: mandate.gate,
      agent: mandate.agent,
      serial: mandate.serial,
      registered,
      remaining_budget: remaining === null ? null : remaining.toString(),
      budget: mandate.budget,
      source,
      note: redact(note),
      duplicate_mandate_file: duplicateFile,
      expired: mandateExpired,
      chain_id_refused: false,
      ...freeze,
    });

    mandate.entries.forEach((entry, index) => {
      let state = 'unknown';
      if (registered && replayed.explained && known) {
        if (replayed.used[index]) state = 'used';
        else if (replayed.frozen) state = 'frozen';
        else state = 'unused';
      } else if (registered && replayed.used[index]) {
        state = 'used';
      }
      if (mandateExpired && state !== 'used') state = 'expired';
      const ev = replayed.evidence[index];
      const fields = state === 'expired'
        ? reasonFields('mandate_expired_not_sent')
        : reasonFields(ev?.reason_code || null);
      entries.push({
        entry_id: entryId(mandate, index),
        action: entry.action,
        target: entry.target,
        max_amount: entry.max_amount,
        instruction: entry.instruction,
        state,
        ...fields,
        evidence: {
          source,
          note: redact(note),
          mandate_frozen: freeze.frozen,
          blocks_in_a_row: freeze.blocks_in_a_row,
          next_block_would_freeze: freeze.next_block_would_freeze,
          last_block_fingerprint: freeze.last_block_fingerprint,
          freeze_known_from: freeze.freeze_known_from,
          freeze_warning_en: freeze.freeze_warning_en,
          freeze_warning_ko: freeze.freeze_warning_ko,
          remaining_budget: remaining === null ? null : remaining.toString(),
          tx_hash: ev?.tx_hash || null,
          caller: ev?.caller || null,
          ...fields,
        },
      });
    });
  }

  let source = 'local-only';
  if (anyChain && !anyLocal) source = 'chain';
  else if (anyChain && anyLocal) source = 'local-only';
  const unresolved = unresolvedSends(ledger.rows, explainedHashes).filter((row) => {
    if (!wanted) return true;
    return row.gate === wanted;
  });
  return {
    source: selected.length === 0 ? 'local-only' : source,
    index_error: anyIndexError ? redact(anyIndexError) : null,
    ledger_corrupt: ledger.corrupt,
    ledger_corrupt_lines: ledger.corrupt_lines,
    ledger_locked: false,
    unresolved_sends: unresolved,
    mandates: summaries,
    entries,
  };
}

function findEntry(mandates, id) {
  const parsed = parseEntryId(id);
  const hits = [];
  for (const mandate of mandates) {
    if (mandate.gate !== parsed.gate || mandate.serial !== parsed.serial) continue;
    const entry = mandate.entries[parsed.index];
    if (!entry) throw new Error(`entry index ${parsed.index} is outside mandate ${id}`);
    hits.push({ mandate, entry });
  }
  if (hits.length === 0) throw new Error(`unknown entry_id ${id}`);
  if (hits.length > 1) throw new Error(`entry_id ${id} matches more than one mandate file`);
  return hits[0];
}

function payResult(code, fields = {}) {
  const described = describeReason(code);
  const pending = fields.pending_id;
  const reason_en = fields.reason_en ?? described.reason_en;
  const reason_ko = fields.reason_ko ?? described.reason_ko;
  const result = {
    sent: fields.sent,
    code: described.reason_code,
    tx_hash: fields.tx_hash ?? null,
    explorer_url: fields.explorer_url ?? null,
    verdict: fields.verdict ?? null,
    reason_code: described.reason_code,
    reason_en,
    reason_ko,
    verdict_kind: described.verdict_kind,
    held: fields.held ?? false,
    remaining_budget: fields.remaining_budget ?? null,
    events: fields.events ?? [],
    message: redact(fields.message ?? reason_en),
    blocks_in_a_row: fields.blocks_in_a_row ?? null,
    mandate_frozen: fields.mandate_frozen ?? null,
    next_block_would_freeze: fields.next_block_would_freeze ?? null,
    last_block_fingerprint: fields.last_block_fingerprint ?? null,
    freeze_warning_en: fields.freeze_warning_en ?? FREEZE_WARNING_EN,
    freeze_warning_ko: fields.freeze_warning_ko ?? FREEZE_WARNING_KO,
  };
  if (fields.state_note) result.state_note = fields.state_note;
  if (fields.ledger_write_failed) result.ledger_write_failed = true;
  if (fields.freeze_known_from) result.freeze_known_from = fields.freeze_known_from;
  if (pending !== undefined && pending !== null) result.pending_id = pending;
  return result;
}

function blankRow(ctx, extra) {
  return {
    at: new Date().toISOString(),
    attempt_id: ctx.attemptId,
    entry_id: ctx.id,
    gate: ctx.mandate.gate,
    network: ctx.mandate.network,
    serial: ctx.mandate.serial,
    index: ctx.entry.index,
    caller: ctx.caller,
    action: ctx.action,
    target: ctx.target,
    amount: ctx.amount,
    instruction_hash: ctx.instructionHash,
    source: ctx.source,
    fingerprint: ctx.fp,
    ...extra,
  };
}

function summaryProjection(summary, note) {
  if (!summary || summary.frozen === null || summary.blocks_in_a_row === null) {
    return {
      blocks_in_a_row: null,
      mandate_frozen: null,
      last_block_fingerprint: null,
      next_block_would_freeze: null,
      freeze_warning_en: summary?.freeze_warning_en || FREEZE_UNKNOWN_EN,
      freeze_warning_ko: summary?.freeze_warning_ko || FREEZE_UNKNOWN_KO,
      state_note: note || null,
    };
  }
  const last = summary.last_block_fingerprint ?? null;
  const blocks = summary.blocks_in_a_row;
  return {
    blocks_in_a_row: blocks,
    mandate_frozen: summary.frozen === true,
    last_block_fingerprint: last,
    next_block_would_freeze: summary.next_block_would_freeze ?? (summary.frozen === true ? false : (blocks >= 2 || last != null)),
    freeze_warning_en: summary.freeze_warning_en || FREEZE_WARNING_EN,
    freeze_warning_ko: summary.freeze_warning_ko || FREEZE_WARNING_KO,
    state_note: note || null,
  };
}

function projectBlock(summary, fp) {
  const warning = {
    freeze_warning_en: summary?.freeze_warning_en || FREEZE_WARNING_EN,
    freeze_warning_ko: summary?.freeze_warning_ko || FREEZE_WARNING_KO,
  };
  if (!summary || summary.frozen === null || summary.blocks_in_a_row === null) {
    return {
      blocks_in_a_row: null,
      mandate_frozen: null,
      last_block_fingerprint: fp,
      next_block_would_freeze: null,
      ...warning,
      freeze_warning_en: FREEZE_UNKNOWN_EN,
      freeze_warning_ko: FREEZE_UNKNOWN_KO,
    };
  }
  if (summary.frozen === true) {
    return summaryProjection(summary, null);
  }
  const blocks = summary.blocks_in_a_row + 1;
  const frozen = blocks >= 3 || (summary.last_block_fingerprint != null && summary.last_block_fingerprint === fp);
  return {
    blocks_in_a_row: blocks,
    mandate_frozen: frozen,
    last_block_fingerprint: fp,
    next_block_would_freeze: frozen ? false : true,
    freeze_warning_en: FREEZE_WARNING_EN,
    freeze_warning_ko: FREEZE_WARNING_KO,
  };
}

// execution_failure and internal_error do not move the on-chain counter.
// auto_frozen is the gate saying the mandate is frozen, even if our summary was stale.
export function projectAfter(summary, fp, reason) {
  if (reason === 'execution_failure' || reason === 'internal_error') {
    return summaryProjection(summary, STATE_UNVERIFIED_NOTE);
  }
  const warning = {
    freeze_warning_en: FREEZE_WARNING_EN,
    freeze_warning_ko: FREEZE_WARNING_KO,
  };
  if (reason === 'auto_frozen') {
    const projected = projectBlock(summary, fp);
    return {
      ...projected,
      mandate_frozen: true,
      next_block_would_freeze: false,
      freeze_warning_en: FREEZE_WARNING_EN,
      freeze_warning_ko: FREEZE_WARNING_KO,
    };
  }
  if (!summary || summary.frozen === null || summary.blocks_in_a_row === null) {
    return summaryProjection(summary, null);
  }
  if (CONSUME.has(reason)) {
    return {
      blocks_in_a_row: 0,
      mandate_frozen: false,
      last_block_fingerprint: null,
      next_block_would_freeze: false,
      ...warning,
    };
  }
  if (NO_STATE.has(reason) || summary.frozen === true) {
    return {
      ...summaryProjection(summary, null),
      freeze_warning_en: FREEZE_WARNING_EN,
      freeze_warning_ko: FREEZE_WARNING_KO,
    };
  }
  return projectBlock(summary, fp);
}

// A local match is not proof the gate will allow the call.
export function callWouldFreeze(summary, fp) {
  if (!summary || summary.frozen === null || summary.blocks_in_a_row === null) return 'unknown';
  if (summary.frozen === true) return 'frozen';
  const same = summary.last_block_fingerprint != null && summary.last_block_fingerprint === fp;
  if (same) return 'yes';
  if (summary.blocks_in_a_row >= 2) return 'yes';
  return 'no';
}

// null: chain history says this call is not the freezing refusal.
// 'next': chain history says the next refusal freezes the mandate.
// 'unknown': freeze state did not come from a full chain replay.
function confirmReason(summary, fp) {
  if (!summary || summary.freeze_known_from !== 'chain') return 'unknown';
  const risk = callWouldFreeze(summary, fp);
  if (risk === 'yes') return 'next';
  if (risk === 'no') return null;
  return 'unknown';
}

export async function pay({
  entry_id: id,
  amount,
  target,
  instruction,
  source,
  confirm_freeze_risk,
} = {}) {
  if (!id) throw new Error('entry_id is required');
  const sourceText = acceptedSource(source);
  if (sourceText === null) {
    return payResult('bad_source', { sent: false });
  }
  let amountYocto;
  try {
    amountYocto = parseAmount(amount);
  } catch (error) {
    return payResult('amount_refused', { sent: false, message: error.message });
  }
  if (amountYocto === 0n) {
    return payResult('amount_refused', { sent: false });
  }
  const confirmed = confirm_freeze_risk === true;
  try {
    return await payInner({
      id,
      amountYocto,
      target,
      instruction,
      sourceText,
      confirmed,
    });
  } catch (error) {
    if (error?.code && REASONS[error.code]) {
      return payResult(error.code, {
        sent: false,
        message: error.message,
        reason_en: error.reason_en,
        reason_ko: error.reason_ko,
      });
    }
    throw error;
  }
}

async function payInner({ id, amountYocto, target, instruction, sourceText, confirmed }) {
  const mandates = await loadMandates();
  const { mandate, entry } = findEntry(mandates, id);
  assertNetworkEnabled(mandate.network);
  assertAccountNotMainnet(mandate.gate);
  assertAccountNotMainnet(mandate.agent);
  const signer = loadAgentKey();
  assertAccountNotMainnet(signer.accountId);
  const override = (target !== undefined && target !== null && target !== '')
    || (instruction !== undefined && instruction !== null && instruction !== '');
  const action = entry.action;
  const resolvedTarget = override && target !== undefined && target !== null && target !== ''
    ? String(target)
    : entry.target;
  const resolvedInstruction = override && instruction !== undefined && instruction !== null && instruction !== ''
    ? String(instruction)
    : entry.instruction;
  const instructionHash = await sha256hex(resolvedInstruction);
  const fp = fingerprintOf(action, resolvedTarget, amountYocto.toString(), instructionHash, signer.accountId);
  const ctx = {
    attemptId: crypto.randomUUID(),
    id,
    mandate,
    entry,
    caller: signer.accountId,
    action,
    target: resolvedTarget,
    amount: amountYocto.toString(),
    instructionHash,
    source: sourceText,
    fp,
  };

  const refuse = (code, extra = {}) => {
    const result = payResult(code, { sent: false, ...extra });
    recordRow(blankRow(ctx, {
      phase: 'result',
      broadcast: false,
      sent: false,
      reason_code: code,
      tx_hash: null,
    }));
    return result;
  };

  if (signer.accountId !== mandate.agent) {
    return refuse('agent_mismatch_not_sent');
  }
  if (expiresAtNs(mandate.expires_at) <= nowNs()) {
    return refuse('mandate_expired_not_sent');
  }
  // Default call only. An overridden target or instruction is still sent so the gate can refuse it.
  if (!override && amountYocto > entry.max_amount_yocto) {
    return refuse('over_max_not_sent');
  }
  if (!override && amountYocto > mandate.budget_yocto) {
    return refuse('over_budget_not_sent');
  }

  let report;
  try {
    report = await status({ gate: mandate.gate });
  } catch (error) {
    if (error?.code && REASONS[error.code]) {
      return refuse(error.code, {
        message: error.message,
        reason_en: error.reason_en,
        reason_ko: error.reason_ko,
      });
    }
    return refuse('rpc_preflight', {
      message: `Could not read status before sending (${error.message || error}). Nothing was sent.`,
    });
  }
  if (report.ledger_corrupt) {
    return refuse('ledger_corrupt');
  }
  if (report.ledger_locked) {
    return payResult('ledger_locked', { sent: false, message: report.message || report.index_error });
  }

  const summary = report.mandates.find((item) => item.gate === mandate.gate && String(item.serial) === mandate.serial);
  const entryRow = report.entries.find((item) => item.entry_id === id);
  if (summary?.chain_id_refused || summary?.reason_code === 'chain_id_refused') {
    return refuse('chain_id_refused', {
      message: summary.note || summary.reason_en,
      reason_en: summary.reason_en,
      reason_ko: summary.reason_ko,
    });
  }
  if (summary?.frozen === true) {
    return refuse('frozen_not_sent', {
      blocks_in_a_row: summary.blocks_in_a_row,
      mandate_frozen: true,
      next_block_would_freeze: false,
      last_block_fingerprint: summary.last_block_fingerprint,
      freeze_warning_en: summary.freeze_warning_en,
      freeze_warning_ko: summary.freeze_warning_ko,
      freeze_known_from: summary.freeze_known_from,
    });
  }
  if (!override && summary?.remaining_budget != null) {
    if (amountYocto > BigInt(summary.remaining_budget)) {
      return refuse('over_budget_not_sent');
    }
  }

  const whyConfirm = confirmReason(summary, fp);
  let gateDecision;
  try {
    gateDecision = withLedgerLock(() => {
      const found = readLedger();
      if (found.corrupt) return { corrupt: true };
      // Duplicate wins over "already used" so a repeated fingerprint keeps its own code.
      if (broadcastPossible(found.rows, mandate.gate, mandate.serial, fp)) return { duplicate: true };
      if (!override && entryRow?.state === 'used') return { used: true };
      if (whyConfirm && !confirmed) return { freezeRisk: true, why: whyConfirm };
      appendLedgerRaw(blankRow(ctx, {
        phase: 'intent',
        broadcast: true,
        sent: 'unknown',
        reason_code: 'rpc_uncertain',
        tx_hash: null,
      }));
      return { ok: true };
    });
  } catch (error) {
    if (error.code === 'ledger_locked') return payResult('ledger_locked', { sent: false, message: error.message });
    throw error;
  }
  if (gateDecision.corrupt) return refuse('ledger_corrupt');
  if (gateDecision.duplicate) return refuse('duplicate_attempt_not_sent');
  if (gateDecision.used) {
    return refuse('entry_used_not_sent', {
      blocks_in_a_row: summary?.blocks_in_a_row ?? null,
      mandate_frozen: summary?.frozen ?? null,
      next_block_would_freeze: summary?.next_block_would_freeze ?? null,
      last_block_fingerprint: summary?.last_block_fingerprint ?? null,
      freeze_warning_en: summary?.freeze_warning_en,
      freeze_warning_ko: summary?.freeze_warning_ko,
    });
  }
  if (gateDecision.freezeRisk) {
    const unknown = gateDecision.why !== 'next';
    return refuse('freeze_risk_not_sent', {
      reason_en: unknown ? FREEZE_RISK_UNKNOWN_EN : FREEZE_RISK_NEXT_EN,
      reason_ko: unknown ? FREEZE_RISK_UNKNOWN_KO : FREEZE_RISK_NEXT_KO,
      message: unknown ? FREEZE_RISK_UNKNOWN_EN : FREEZE_RISK_NEXT_EN,
      blocks_in_a_row: summary?.blocks_in_a_row ?? null,
      mandate_frozen: summary?.frozen ?? null,
      next_block_would_freeze: unknown ? null : true,
      last_block_fingerprint: summary?.last_block_fingerprint ?? null,
      freeze_warning_en: unknown ? (summary?.freeze_warning_en || FREEZE_UNKNOWN_EN) : FREEZE_WARNING_EN,
      freeze_warning_ko: unknown ? (summary?.freeze_warning_ko || FREEZE_UNKNOWN_KO) : FREEZE_WARNING_KO,
      freeze_known_from: summary?.freeze_known_from || 'local-ledger',
    });
  }

  const args = {
    serial: chainSerial(mandate.serial),
    action,
    target: resolvedTarget,
    amount: amountYocto.toString(),
    instruction: resolvedInstruction,
    source: sourceText,
    judge_hint: null,
  };
  let checked;
  try {
    checked = await assertRpcChain(mandate.network);
  } catch (error) {
    const code = error?.code === 'chain_id_refused' ? 'chain_id_refused' : 'rpc_preflight';
    return refuse(code, { message: error.message });
  }
  // Unconditional chain read on this call. It runs after the intent and before signing.
  // The read is finality final and is not atomic with the broadcast. The nonce below is from this same view.
  let keyView;
  try {
    keyView = await assertAgentFunctionCallKey(mandate.network, mandate.gate, signer, checked.url);
  } catch (error) {
    const mapped = error?.code && REASONS[error.code] ? error : keyReadError(error);
    const code = mapped?.code && REASONS[mapped.code] ? mapped.code : 'rpc_preflight';
    return refuse(code, {
      message: mapped.message || error.message,
      reason_en: mapped.reason_en,
      reason_ko: mapped.reason_ko,
    });
  }
  const nearProvider = providerFor(checked.url, { send: true });
  let signed;
  let knownHash = null;
  try {
    signed = await signer.signCheckedTransaction({
      receiverId: mandate.gate,
      actions: [actions.functionCall('authorize_and_pay_tiered', args, MAX_GAS, 0n)],
      accessKeyView: keyView,
    });
    knownHash = await hashTransaction(signed);
  } catch (error) {
    const mapped = keyReadError(error);
    if (mapped?.code === 'key_scope_mismatch' || mapped?.code === 'full_access_key_refused') {
      return refuse(mapped.code, {
        message: mapped.message,
        reason_en: mapped.reason_en,
        reason_ko: mapped.reason_ko,
      });
    }
    const result = payResult('rpc_preflight', {
      sent: false,
      message: `RPC failed before the transaction was broadcast (${error.message || error}). Nothing was sent.`,
      blocks_in_a_row: summary?.blocks_in_a_row ?? null,
      mandate_frozen: summary?.frozen ?? null,
      next_block_would_freeze: summary?.next_block_would_freeze ?? null,
      last_block_fingerprint: summary?.last_block_fingerprint ?? null,
      freeze_warning_en: summary?.freeze_warning_en,
      freeze_warning_ko: summary?.freeze_warning_ko,
    });
    recordRow(blankRow(ctx, {
      phase: 'result',
      broadcast: false,
      sent: false,
      reason_code: 'rpc_preflight',
      tx_hash: null,
    }));
    return result;
  }

  const noteLedger = (result, row) => {
    const written = appendResultWithRetry(row);
    if (!written.ok) {
      result.ledger_write_failed = true;
      result.message = redact(`${result.message} The local ledger result could not be written (ledger_write_failed). Do not resend.`);
    }
    return result;
  };
  const unknownAfterBroadcast = (hash, error) => {
    let explorer = null;
    try {
      explorer = hash ? explorerUrl(mandate.network, hash) : null;
    } catch {
      explorer = null;
    }
    const detail = redact(error?.message || 'unknown error');
    const result = payResult('rpc_uncertain', {
      sent: 'unknown',
      tx_hash: hash,
      explorer_url: explorer,
      message: `The transaction was broadcast and the result is not known (${detail}). Do not resend.`,
      blocks_in_a_row: summary?.blocks_in_a_row ?? null,
      mandate_frozen: summary?.frozen ?? null,
      next_block_would_freeze: summary?.next_block_would_freeze ?? null,
      last_block_fingerprint: summary?.last_block_fingerprint ?? null,
      freeze_warning_en: summary?.freeze_warning_en || FREEZE_WARNING_EN,
      freeze_warning_ko: summary?.freeze_warning_ko || FREEZE_WARNING_KO,
      state_note: STATE_UNVERIFIED_NOTE,
    });
    return noteLedger(result, blankRow(ctx, {
      phase: 'result',
      broadcast: true,
      sent: 'unknown',
      tx_hash: hash,
      reason_code: 'rpc_uncertain',
    }));
  };

  let outcome;
  try {
    outcome = await withSendDeadline(nearProvider.sendTransactionUntil(signed, 'FINAL'));
  } catch (error) {
    // Deadline or a lost response: the intent is closed with sent:"unknown" and pay returns,
    // so the MCP exclusive() queue can run the next status or pay.
    return unknownAfterBroadcast(knownHash, error);
  }

  try {
    const parsed = interpretOutcome(outcome);
    const txHash = parsed.txHash || knownHash;
    if (parsed.failure) {
      const projected = projectAfter(summary, fp, 'execution_failure');
      const result = payResult('execution_failure', {
        sent: true,
        tx_hash: txHash,
        explorer_url: explorerUrl(mandate.network, txHash),
        events: parsed.events,
        message: 'The transaction was included and the receipt failed. The chain reverted it, so the freeze counter did not move. The ledger still blocks this fingerprint. Do not resend.',
        ...projected,
      });
      return noteLedger(result, blankRow(ctx, {
        phase: 'result',
        broadcast: true,
        sent: true,
        tx_hash: txHash,
        reason_code: 'execution_failure',
      }));
    }

    const decision = parsed.decision || {};
    const reason = decision.reason_code || 'internal_error';
    const held = reason === 'tier2_escalate' || parsed.pendingId !== undefined;
    const projected = projectAfter(summary, fp, reason);
    const missingDecision = reason === 'internal_error';
    const result = payResult(reason, {
      sent: true,
      tx_hash: txHash,
      explorer_url: explorerUrl(mandate.network, txHash),
      verdict: decision.verdict || null,
      held,
      remaining_budget: decision.remaining_budget ?? null,
      events: parsed.events,
      pending_id: held ? parsed.pendingId : undefined,
      reason_en: missingDecision ? POST_DECISION_UNKNOWN_EN : undefined,
      reason_ko: missingDecision ? POST_DECISION_UNKNOWN_KO : undefined,
      message: missingDecision ? POST_DECISION_UNKNOWN_EN : undefined,
      ...projected,
    });
    return noteLedger(result, blankRow(ctx, {
      phase: 'result',
      broadcast: true,
      sent: true,
      tx_hash: txHash,
      verdict: result.verdict,
      reason_code: result.reason_code,
      held,
      pending_id: result.pending_id ?? null,
      remaining_budget: result.remaining_budget,
    }));
  } catch (error) {
    return unknownAfterBroadcast(knownHash, error);
  }
}

export async function submitOwnerCall({
  accountId,
  privateKey,
  networkName,
  contractId,
  methodName,
  args,
  deposit = 0n,
  gas = MAX_GAS,
}) {
  assertNetworkEnabled(networkName);
  assertAccountNotMainnet(contractId);
  assertAccountNotMainnet(accountId);
  const checked = await assertRpcChain(networkName);
  const nearProvider = providerFor(checked.url, { send: true });
  const account = new Account(accountId, nearProvider, privateKey);
  const signed = await account.createSignedTransaction({
    receiverId: contractId,
    actions: [actions.functionCall(methodName, args, gas, deposit)],
  });
  const knownHash = await hashTransaction(signed);
  const outcome = await nearProvider.sendTransactionUntil(signed, 'FINAL');
  const parsed = interpretOutcome(outcome);
  return {
    tx_hash: parsed.txHash || knownHash,
    explorer_url: explorerUrl(networkName, parsed.txHash || knownHash),
    events: parsed.events,
    decision: parsed.decision,
    failure: parsed.failure || null,
    outcome,
  };
}
