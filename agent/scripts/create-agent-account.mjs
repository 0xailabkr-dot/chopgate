#!/usr/bin/env node
// Owner-side: create an agent sub-account with exactly one function-call key.
// The new secret is written to --out (mode 600) and is never printed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Account, JsonRpcProvider, KeyPair, actions, baseEncode, encodeTransaction } from 'near-api-js';
import { sha256 } from '../src/vendor/chopgate-encode.mjs';
import {
  assertAccountNotMainnet,
  assertNetworkEnabled,
  assertRpcChain,
  explorerUrl,
  interpretOutcome,
  parseAmount,
  redact,
  summarizeAccessKeys,
} from '../src/chopgate-agent.mjs';

const METHOD = 'authorize_and_pay_tiered';
const FUND_CAP = parseAmount('5');

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function fail(message) {
  console.error(redact(message));
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

function failLeft(message, tmpPath) {
  if (tmpPath) console.error(`agent key left at ${tmpPath}`);
  fail(message);
}

function assertOutReady(file) {
  const dir = path.dirname(path.resolve(file));
  let dirStat;
  try {
    dirStat = fs.statSync(dir);
  } catch {
    fail('--out directory does not exist');
  }
  if (!dirStat.isDirectory()) fail('--out directory does not exist');
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    fail('--out directory is not writable');
  }
  try {
    fs.lstatSync(file);
    fail('--out already exists');
  } catch (error) {
    if (error.code !== 'ENOENT') fail(`--out cannot be used (${error.code || 'error'})`);
  }
  return dir;
}

function writeTempKey(dir, finalName, body) {
  const tmp = path.join(dir, `.${finalName}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    fail(`could not write the agent key file (${error.code || 'error'})`);
  }
  try {
    fs.writeFileSync(fd, body);
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* closed */ }
    failLeft(`could not write the agent key file (${error.code || 'error'})`, tmp);
  }
  fs.closeSync(fd);
  return tmp;
}

function keyListOk(list, gate, publicKey) {
  const keys = Array.isArray(list?.keys) ? list.keys : [];
  if (keys.length !== 1) return `expected 1 access key, saw ${keys.length}`;
  const row = keys[0];
  if (row.public_key !== publicKey) return 'the on-chain key is not the key that was just created';
  const call = row.access_key?.permission?.FunctionCall;
  if (!call) return 'the only key is not FunctionCall';
  if (call.receiver_id !== gate) return 'function-call receiver is not the gate';
  const methods = Array.isArray(call.method_names) ? call.method_names : [];
  if (methods.length !== 1 || methods[0] !== METHOD) return `method_names is not exactly ["${METHOD}"]`;
  if (call.allowance !== null && call.allowance !== undefined) return 'allowance is not null';
  return null;
}

const gate = arg('--gate');
const name = arg('--name');
const fundText = arg('--fund') || '0.3';
const out = arg('--out');
const network = arg('--network') || process.env.CHOPGATE_NETWORK || 'testnet';

if (!gate || !name || !out) {
  fail('usage: create-agent-account.mjs --gate ACCOUNT --name LABEL --out PATH [--fund 0.3]');
}
if (!/^[a-z0-9](?:[a-z0-9_-]{0,30})$/.test(name)) {
  fail('--name must be a lowercase sub-account label');
}

const ownerPath = process.env.OWNER_ACCOUNT_KEY_FILE;
if (!ownerPath) fail('OWNER_ACCOUNT_KEY_FILE is required');
assertMode600(ownerPath, 'OWNER_ACCOUNT_KEY_FILE');

let owner;
try {
  owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
} catch (error) {
  fail(`cannot read owner account key file: ${error.message || error}`);
}
if (!owner.account_id || !owner.private_key || !owner.public_key) {
  fail('owner account key file must contain account_id, public_key, and private_key');
}

const agentAccount = `${name}.${owner.account_id}`;
if (agentAccount.length > 64) fail('agent account id is longer than 64 characters');

let fund;
try {
  fund = parseAmount(fundText);
} catch (error) {
  fail(`--fund ${error.message || error}`);
}
if (fund <= 0n) fail('--fund must be positive');
if (fund > FUND_CAP) fail('--fund is above 5 NEAR');

try {
  assertNetworkEnabled(network);
  assertAccountNotMainnet(owner.account_id);
  assertAccountNotMainnet(agentAccount);
  assertAccountNotMainnet(gate);
} catch (error) {
  fail(error.message || String(error));
}

let created;
try {
  created = KeyPair.fromRandom('ed25519');
} catch (error) {
  fail(`could not generate a key: ${error.message || error}`);
}
const publicKey = created.getPublicKey().toString();

const outDir = assertOutReady(out);

let checked;
try {
  checked = await assertRpcChain(network);
} catch (error) {
  fail(error.message || String(error));
}

const body = `${JSON.stringify({
  account_id: agentAccount,
  public_key: publicKey,
  private_key: created.toString(),
})}\n`;
const tmpKey = writeTempKey(outDir, path.basename(out), body);

const provider = new JsonRpcProvider({ url: checked.url }, { retries: 1, wait: 200, backoff: 1 });
const signer = new Account(owner.account_id, provider, owner.private_key);

let outcome;
let knownHash = null;
let broadcastStarted = false;
try {
  const signed = await signer.createSignedTransaction({
    receiverId: agentAccount,
    actions: [
      actions.createAccount(),
      actions.transfer(fund),
      actions.addFunctionCallAccessKey(created.getPublicKey(), gate, [METHOD], null),
    ],
  });
  knownHash = baseEncode(await sha256(encodeTransaction(signed.transaction)));
  broadcastStarted = true;
  outcome = await provider.sendTransactionUntil(signed, 'FINAL');
} catch (error) {
  const hashNote = knownHash ? ` tx ${knownHash}.` : '';
  const landed = broadcastStarted
    ? ` The agent account ${agentAccount} may have been created.`
    : ` The agent account ${agentAccount} was not broadcast.`;
  failLeft(`create transaction failed.${landed}${hashNote} ${error.message || error}`, tmpKey);
}

const parsed = interpretOutcome(outcome);
const txHash = parsed.txHash;
if (!txHash) failLeft('create transaction returned no hash', tmpKey);
if (parsed.failure) {
  const text = redact(JSON.stringify(parsed.failure)).slice(0, 500);
  failLeft(`create transaction ${txHash} failed on chain: ${text}`, tmpKey);
}

let list = null;
let problem = 'access key list was not read';
for (let i = 0; i < 15; i++) {
  try {
    list = await provider.viewAccessKeyList({
      accountId: agentAccount,
      finalityQuery: { finality: 'final' },
    });
    problem = keyListOk(list, gate, publicKey);
    if (!problem) break;
  } catch (error) {
    problem = error.message || String(error);
  }
  await new Promise((resolve) => setTimeout(resolve, 400));
}
if (problem) {
  const summary = list ? summarizeAccessKeys(list) : [];
  failLeft(`${problem}. tx ${txHash}. keys ${JSON.stringify(summary)}`, tmpKey);
}

try {
  fs.linkSync(tmpKey, out);
} catch (error) {
  failLeft(`could not place the agent key at --out (${error.code || 'error'})`, tmpKey);
}
try {
  fs.unlinkSync(tmpKey);
} catch (error) {
  failLeft(`could not remove the temporary agent key (${error.code || 'error'})`, tmpKey);
}
try {
  fs.chmodSync(out, 0o600);
} catch (error) {
  fail(`could not set --out to mode 600 (${error.code || 'error'})`);
}

const permission = summarizeAccessKeys(list);
console.log(JSON.stringify({
  tx_hash: txHash,
  explorer_url: explorerUrl(network, txHash),
  account_id: agentAccount,
  public_key: publicKey,
  keys: permission,
}, null, 2));
