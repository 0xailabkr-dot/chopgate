// No network. A provider method that never resolves must not pin pay or the next status call.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KeyPair, baseEncode } from 'near-api-js';
import {
  pay,
  setProviderHookForTests,
  status,
} from '../src/chopgate-agent.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chopgate-send-timeout-'));
const GATE = 'gate.test.near';
const AGENT = 'agent.test.near';
const BUDGET = '1000000000000000000000000';
const blockHash = baseEncode(Buffer.alloc(32, 7));
const permission = {
  FunctionCall: {
    allowance: null,
    receiver_id: GATE,
    method_names: ['authorize_and_pay_tiered'],
  },
};

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function exclusiveQueue() {
  let turn = Promise.resolve();
  return function exclusive(fn) {
    const run = turn.then(() => fn(), () => fn());
    turn = run.then(() => {}, () => {});
    return run;
  };
}

function failAfter(ms, label) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${label} blocked`)), ms);
  });
}

function provider({ hangSend = false, hangView = false } = {}) {
  return {
    async viewNodeStatus() {
      return { chain_id: 'sandbox' };
    },
    viewAccessKey() {
      if (hangView) return new Promise(() => {});
      return {
        nonce: 4n,
        permission,
        block_hash: blockHash,
        block_height: 3,
      };
    },
    async callFunction() {
      return BUDGET;
    },
    sendTransactionUntil() {
      if (hangSend) return new Promise(() => {});
      return Promise.reject(new Error('send was not supposed to be reached'));
    },
  };
}

const key = KeyPair.fromRandom('ed25519');
const agentKey = path.join(TMP, 'agent-key.json');
fs.writeFileSync(agentKey, JSON.stringify({
  account_id: AGENT,
  public_key: key.getPublicKey().toString(),
  private_key: key.toString(),
}), { mode: 0o600 });
fs.chmodSync(agentKey, 0o600);
fs.mkdirSync(path.join(TMP, 'mandates'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'mandates', 'one.json'), JSON.stringify({
  network: 'sandbox',
  gate: GATE,
  agent: AGENT,
  serial: 7,
  budget: BUDGET,
  expires_at: '9999999999999999999',
  entries: [{
    action: 'transfer',
    target: 'payee.test.near',
    max_amount: BUDGET,
    instruction: 'timeout invoice',
  }],
}));
fs.writeFileSync(path.join(TMP, 'networks.json'), JSON.stringify({
  sandbox: {
    enabled: true,
    networkId: 'sandbox',
    rpc: ['http://127.0.0.1:9'],
    archivalRpc: ['http://127.0.0.1:9'],
    txIndexApi: '',
    explorer: 'http://127.0.0.1/txns/',
  },
}));

process.env.CHOPGATE_NETWORKS_FILE = path.join(TMP, 'networks.json');
process.env.CHOPGATE_MANDATES = path.join(TMP, 'mandates');
process.env.CHOPGATE_LEDGER = path.join(TMP, 'ledger.jsonl');
process.env.CHOPGATE_AGENT_KEY = agentKey;
process.env.CHOPGATE_SEND_TIMEOUT_MS = '250';
process.env.CHOPGATE_VIEW_TIMEOUT_MS = '250';

try {
  const exclusive = exclusiveQueue();
  setProviderHookForTests(() => provider({ hangSend: true }));
  let payDone = 0;
  let statusStarted = 0;
  const started = Date.now();
  const payPromise = exclusive(async () => {
    const result = await pay({
      entry_id: `${GATE}#7:0`,
      amount: '0.1',
      source: 'owner_chat',
      confirm_freeze_risk: true,
    });
    payDone = Date.now();
    return result;
  });
  const statusPromise = exclusive(async () => {
    statusStarted = Date.now();
    return status({ gate: GATE });
  });
  const paid = await Promise.race([payPromise, failAfter(5000, 'pay')]);
  const report = await Promise.race([statusPromise, failAfter(5000, 'status')]);
  assert(paid.sent === 'unknown', `sent ${paid.sent} ${paid.reason_code} ${paid.message || ''}`);
  assert(paid.reason_code === 'rpc_uncertain', `reason ${paid.reason_code}`);
  assert(typeof paid.tx_hash === 'string' && paid.tx_hash.length > 0, 'missing tx hash');
  assert(report && Array.isArray(report.entries), 'status did not return');
  assert(statusStarted >= payDone && payDone > 0, 'status ran before pay released the queue');
  assert(Date.now() - started < 4000, `queue stayed busy for ${Date.now() - started}ms`);
  const lines = fs.readFileSync(process.env.CHOPGATE_LEDGER, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const intent = lines.find((row) => row.phase === 'intent' && row.attempt_id === lines.find((item) => item.sent === 'unknown' && item.phase === 'result')?.attempt_id);
  const closed = lines.find((row) => row.phase === 'result' && row.sent === 'unknown' && row.broadcast === true && row.tx_hash === paid.tx_hash);
  assert(intent && closed && intent.attempt_id === closed.attempt_id, 'intent row was not closed');
  console.log(JSON.stringify({
    sent: paid.sent,
    reason_code: paid.reason_code,
    tx_hash: paid.tx_hash,
    status_entries: report.entries.length,
    elapsed_ms: Date.now() - started,
  }));

  setProviderHookForTests(() => provider({ hangView: true }));
  const viewStarted = Date.now();
  const viewPay = await Promise.race([
    pay({
      entry_id: `${GATE}#7:0`,
      amount: '0.2',
      source: 'owner_chat',
      confirm_freeze_risk: true,
    }),
    failAfter(5000, 'stalled view pay'),
  ]);
  assert(viewPay.reason_code === 'rpc_preflight', `stalled view ${viewPay.reason_code} ${viewPay.message || ''}`);
  assert(viewPay.sent === false, `stalled view sent ${viewPay.sent}`);
  let viewStatus = null;
  try {
    await Promise.race([
      status({ gate: GATE }),
      failAfter(5000, 'stalled view status'),
    ]);
    viewStatus = 'returned';
  } catch (error) {
    viewStatus = error.code || error.message;
  }
  assert(viewStatus === 'rpc_preflight', `status after stalled view ${viewStatus}`);
  assert(Date.now() - viewStarted < 4000, `stalled view blocked for ${Date.now() - viewStarted}ms`);
  console.log(JSON.stringify({ stalled_view: viewPay.reason_code, status: viewStatus }));
  console.log('ok send timeout');
} finally {
  setProviderHookForTests(null);
  fs.rmSync(TMP, { recursive: true, force: true });
}
