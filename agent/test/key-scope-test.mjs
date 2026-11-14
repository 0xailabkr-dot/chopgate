// Table-driven checks for agentKeyScopeCode and loadAgentKey. No network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KeyPair, baseDecode } from 'near-api-js';
import { agentKeyScopeCode, describeAgentKeyScope, keyReadError, loadAgentKey } from '../src/chopgate-agent.mjs';
import { describeReason } from '../src/reasons.mjs';

const GATE = 'gate.test.near';
const METHOD = 'authorize_and_pay_tiered';

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function call(receiver, methods, allowance) {
  const body = { receiver_id: receiver, method_names: methods };
  if (allowance !== undefined) body.allowance = allowance;
  return { FunctionCall: body };
}

const rows = [
  ['FullAccess string', 'FullAccess', 'full_access_key_refused'],
  ['FullAccess object', { FullAccess: {} }, 'full_access_key_refused'],
  ['FullAccess null field', { FullAccess: null }, 'full_access_key_refused'],
  ['GasKeyFullAccess', { GasKeyFullAccess: { balance: '0', num_nonces: 1 } }, 'full_access_key_refused'],
  ['function-call ok', call(GATE, [METHOD], null), null],
  ['function-call omitted allowance', call(GATE, [METHOD]), null],
  ['wrong receiver', call('payee.test.near', [METHOD], null), 'key_scope_mismatch'],
  ['receiver case', call('Gate.Test.Near', [METHOD], null), 'key_scope_mismatch'],
  ['receiver suffix', call(`${GATE}.evil`, [METHOD], null), 'key_scope_mismatch'],
  ['receiver prefix', call(`not.${GATE}`, [METHOD], null), 'key_scope_mismatch'],
  ['receiver trailing space', call(`${GATE} `, [METHOD], null), 'key_scope_mismatch'],
  ['extra method', call(GATE, [METHOD, 'withdraw_escrow'], null), 'key_scope_mismatch'],
  ['empty method list', call(GATE, [], null), 'key_scope_mismatch'],
  ['reordered extra methods', call(GATE, ['withdraw_escrow', METHOD], null), 'key_scope_mismatch'],
  ['duplicate method', call(GATE, [METHOD, METHOD], null), 'key_scope_mismatch'],
  ['method case', call(GATE, ['Authorize_and_pay_tiered'], null), 'key_scope_mismatch'],
  ['finite allowance string', call(GATE, [METHOD], '1'), 'key_scope_mismatch'],
  ['finite allowance zero', call(GATE, [METHOD], '0'), 'key_scope_mismatch'],
  ['finite allowance number', call(GATE, [METHOD], 0), 'key_scope_mismatch'],
  ['GasKeyFunctionCall', { GasKeyFunctionCall: { receiver_id: GATE, method_names: [METHOD] } }, 'key_scope_mismatch'],
  ['unknown string', 'AccessKey', 'key_scope_mismatch'],
  ['null permission', null, 'key_scope_mismatch'],
  ['empty object', {}, 'key_scope_mismatch'],
  ['function call null', { FunctionCall: null }, 'key_scope_mismatch'],
];

for (const [name, permission, expected] of rows) {
  const got = agentKeyScopeCode(permission, GATE);
  assert(got === expected, `${name}: ${got} !== ${expected}`);
}

const finite = describeAgentKeyScope(call(GATE, [METHOD], '250000000000000000000000'), GATE);
assert(finite.code === 'key_scope_mismatch', 'finite code');
assert(/finite allowance is not accepted/i.test(finite.reason_en), `finite en ${finite.reason_en}`);
assert(finite.reason_ko.includes('유한한 허용량'), `finite ko ${finite.reason_ko}`);
assert(finite.reason_en !== describeReason('key_scope_mismatch').reason_en, 'finite text is the generic mismatch');

const wrong = describeAgentKeyScope(call('other.test.near', [METHOD], null), GATE);
assert(wrong.reason_en === describeReason('key_scope_mismatch').reason_en, 'wrong receiver keeps the generic text');
assert(wrong.reason_ko === describeReason('key_scope_mismatch').reason_ko, 'wrong receiver keeps the generic Korean text');

const full = describeAgentKeyScope('FullAccess', GATE);
assert(full.code === 'full_access_key_refused', 'describe full access');
assert(full.reason_en === describeReason('full_access_key_refused').reason_en, 'full access en');

function codeOf(error) {
  const mapped = keyReadError(error);
  return mapped.code;
}

const reads = [
  ['parsed missing key', { name: 'AccessKeyDoesNotExistError', message: 'Access key ed25519:abc does not exist' }, 'key_scope_mismatch'],
  ['cause UNKNOWN_ACCESS_KEY', { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCESS_KEY', info: {} } }, 'key_scope_mismatch'],
  ['type UNKNOWN_ACCESS_KEY', { type: 'UNKNOWN_ACCESS_KEY', message: 'missing' }, 'key_scope_mismatch'],
  ['account does not exist', { name: 'AccountDoesNotExistError', message: 'Account agent.test.near does not exist at block height 3' }, 'rpc_preflight'],
  ['text only does not exist', { name: 'Error', message: 'account does not exist' }, 'rpc_preflight'],
  ['timeout', { name: 'TimeoutError', message: 'The operation was aborted' }, 'rpc_preflight'],
  ['already rpc_preflight', Object.assign(new Error('down'), { code: 'rpc_preflight' }), 'rpc_preflight'],
];

for (const [name, error, expected] of reads) {
  const got = codeOf(error);
  assert(got === expected, `${name}: ${got} !== ${expected}`);
}

const kept = keyReadError(Object.assign(new Error('down'), { code: 'chain_id_refused' }));
assert(kept.code === 'chain_id_refused', 'chain_id_refused is not rewritten');

function assertThrows(fn, code) {
  let caught = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert(caught, `expected ${code}`);
  assert(caught.code === code, `${caught.code || caught.message} !== ${code}`);
}

// First 32 bytes of the NEAR secret (seed || public). The hex is not logged.
function seedHexFromKeyPair(kp) {
  const extended = Buffer.from(baseDecode(kp.toString().slice('ed25519:'.length)));
  assert(extended.length === 64, 'NEAR secret must be 64 bytes');
  return extended.subarray(0, 32).toString('hex');
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chopgate-key-scope-'));
try {
  const kp = KeyPair.fromRandom('ed25519');
  const other = KeyPair.fromRandom('ed25519');
  const openFile = path.join(dir, 'open.json');
  fs.writeFileSync(openFile, `${JSON.stringify({
    account_id: 'agent.test.near',
    public_key: kp.getPublicKey().toString(),
    private_key: kp.toString(),
  })}\n`, { mode: 0o644 });
  fs.chmodSync(openFile, 0o644);
  assertThrows(() => loadAgentKey(openFile), 'key_refused');

  const mismatch = path.join(dir, 'mismatch.json');
  fs.writeFileSync(mismatch, `${JSON.stringify({
    account_id: 'agent.test.near',
    public_key: other.getPublicKey().toString(),
    private_key: kp.toString(),
  })}\n`, { mode: 0o600 });
  fs.chmodSync(mismatch, 0o600);
  assertThrows(() => loadAgentKey(mismatch), 'key_refused');

  const okFile = path.join(dir, 'ok.json');
  fs.writeFileSync(okFile, `${JSON.stringify({
    account_id: 'agent.test.near',
    public_key: kp.getPublicKey().toString(),
    private_key: kp.toString(),
  })}\n`, { mode: 0o600 });
  fs.chmodSync(okFile, 0o600);
  const loaded = loadAgentKey(okFile);
  assert(loaded.publicKey === kp.getPublicKey().toString(), 'view key is the derived public key');
  assert(loaded.toJSON().private_key === undefined, 'toJSON omits the secret');

  const seedHex = seedHexFromKeyPair(kp);
  const consoleOk = path.join(dir, 'console-ok.json');
  fs.writeFileSync(consoleOk, `${JSON.stringify({
    type: 'chopgate-agent-key',
    version: 1,
    account_id: 'agent.test.near',
    public_key: kp.getPublicKey().toString(),
    secret_key: seedHex,
  })}\n`, { mode: 0o600 });
  fs.chmodSync(consoleOk, 0o600);
  const consoleLoaded = loadAgentKey(consoleOk);
  assert(consoleLoaded.publicKey === kp.getPublicKey().toString(), 'console view key is the derived public key');
  const consoleJson = consoleLoaded.toJSON();
  assert(consoleJson.private_key === undefined, 'console toJSON omits private_key');
  assert(consoleJson.secret_key === undefined, 'console toJSON omits secret_key');

  const consoleMismatch = path.join(dir, 'console-mismatch.json');
  fs.writeFileSync(consoleMismatch, `${JSON.stringify({
    type: 'chopgate-agent-key',
    version: 1,
    account_id: 'agent.test.near',
    public_key: other.getPublicKey().toString(),
    secret_key: seedHex,
  })}\n`, { mode: 0o600 });
  fs.chmodSync(consoleMismatch, 0o600);
  assertThrows(() => loadAgentKey(consoleMismatch), 'key_refused');
  let consoleMismatchError = null;
  try {
    loadAgentKey(consoleMismatch);
  } catch (error) {
    consoleMismatchError = error;
  }
  assert(
    consoleMismatchError
      && consoleMismatchError.message.includes('derived from secret_key')
      && !consoleMismatchError.message.includes('private_key'),
    'console mismatch names secret_key',
  );

  let formatAMismatchError = null;
  try {
    loadAgentKey(mismatch);
  } catch (error) {
    formatAMismatchError = error;
  }
  assert(
    formatAMismatchError && formatAMismatchError.message.includes('derived from private_key'),
    'format A mismatch names private_key',
  );

  // Same ephemeral key in both fields. Either format would load if the file were not refused.
  const bothFile = path.join(dir, 'both.json');
  fs.writeFileSync(bothFile, `${JSON.stringify({
    type: 'chopgate-agent-key',
    version: 1,
    account_id: 'agent.test.near',
    public_key: kp.getPublicKey().toString(),
    secret_key: seedHex,
    private_key: kp.toString(),
  })}\n`, { mode: 0o600 });
  fs.chmodSync(bothFile, 0o600);
  let bothError = null;
  try {
    loadAgentKey(bothFile);
  } catch (error) {
    bothError = error;
  }
  assert(bothError && bothError.code === 'key_refused', 'both fields refused');
  assert(bothError.message === 'ambiguous which secret to use', 'both fields are ambiguous');

  const bothPlain = path.join(dir, 'both-plain.json');
  fs.writeFileSync(bothPlain, `${JSON.stringify({
    account_id: 'agent.test.near',
    public_key: kp.getPublicKey().toString(),
    secret_key: seedHex,
    private_key: kp.toString(),
  })}\n`, { mode: 0o600 });
  fs.chmodSync(bothPlain, 0o600);
  assertThrows(() => loadAgentKey(bothPlain), 'key_refused');

  const versionCases = [
    ['console-version-missing.json', {
      type: 'chopgate-agent-key',
      account_id: 'agent.test.near',
      public_key: kp.getPublicKey().toString(),
      secret_key: seedHex,
    }],
    ['console-version-string.json', {
      type: 'chopgate-agent-key',
      version: '1',
      account_id: 'agent.test.near',
      public_key: kp.getPublicKey().toString(),
      secret_key: seedHex,
    }],
    ['console-version-string-private.json', {
      type: 'chopgate-agent-key',
      version: '1',
      account_id: 'agent.test.near',
      public_key: kp.getPublicKey().toString(),
      private_key: kp.toString(),
    }],
    ['console-version-2.json', {
      type: 'chopgate-agent-key',
      version: 2,
      account_id: 'agent.test.near',
      public_key: kp.getPublicKey().toString(),
      secret_key: seedHex,
    }],
    ['console-version-2-private.json', {
      type: 'chopgate-agent-key',
      version: 2,
      account_id: 'agent.test.near',
      public_key: kp.getPublicKey().toString(),
      private_key: kp.toString(),
    }],
  ];
  for (const [name, body] of versionCases) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `${JSON.stringify(body)}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    let caught = null;
    try {
      loadAgentKey(file);
    } catch (error) {
      caught = error;
    }
    assert(caught && caught.code === 'key_refused' && caught.message === 'unsupported key file version', `${name} unsupported version`);
  }

  const nullJson = path.join(dir, 'null.json');
  fs.writeFileSync(nullJson, JSON.stringify(null), { mode: 0o600 });
  fs.chmodSync(nullJson, 0o600);
  assertThrows(() => loadAgentKey(nullJson), 'key_refused');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`ok key-scope ${rows.length} shapes, finite allowance text, ${reads.length} key reads, mode 644 refused, mismatched public key refused, console format accepted, console public key mismatch refused, both secret fields refused, unsupported console version refused, JSON null refused`);
