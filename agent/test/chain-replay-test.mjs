// No network. Chain replay: index rows plus EXPERIMENTAL_tx_status decision events.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { KeyPair } from 'near-api-js';
import { sha256hex } from '../src/vendor/chopgate-encode.mjs';
import {
  chainDecisions,
  fingerprintOf,
  firstFit,
  pay,
  replay,
  status,
} from '../src/chopgate-agent.mjs';
import { FREEZE_RISK_NEXT_EN, FREEZE_RISK_NEXT_KO, describeReason } from '../src/reasons.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chopgate-chain-replay-'));
const GATE = 'gate.test.near';
const AGENT = 'agent.test.near';
const BUDGET = 10n ** 24n;
const PAYEE = 'payee.test.near';
const instruction = 'replay invoice';

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const hash = await sha256hex(instruction);
const entries = [
  { action: 'transfer', target: PAYEE, instruction_hash: hash, max_amount_yocto: BUDGET },
  { action: 'transfer', target: PAYEE, instruction_hash: hash, max_amount_yocto: BUDGET },
];
const mandate = { serial: '7', entries };

function step(txHash, reason, target, amount, signer = AGENT) {
  return {
    tx_hash: txHash,
    signer,
    decision: {
      serial: '7',
      action: 'transfer',
      target,
      amount,
      instruction_hash: hash,
      reason_code: reason,
    },
  };
}

const allowIndex = firstFit(entries, [false, false], 'transfer', PAYEE, hash, 1000n);
assert(allowIndex === 0, `first fit ${allowIndex}`);
const used = [false, false];
used[allowIndex] = true;
assert(firstFit(entries, used, 'transfer', PAYEE, hash, 1000n) === 1, 'second fit');

const allowed = replay(mandate, [step('allow-tx', 'allowed', PAYEE, '1000')]);
assert(allowed.used[0] === true && allowed.used[1] === false, `allow used ${allowed.used.join(',')}`);
assert(allowed.blocks === 0 && allowed.frozen === false && allowed.explained === true, 'allow did not reset');
assert(allowed.consumed === 1000n, `consumed ${allowed.consumed}`);

const twoBlocks = replay(mandate, [
  step('block-a', 'out_of_scope', 'other-a.test.near', '1'),
  step('block-b', 'policy_rule_denied', 'other-b.test.near', '2'),
]);
assert(twoBlocks.blocks === 2 && twoBlocks.frozen === false, `two blocks ${twoBlocks.blocks} frozen ${twoBlocks.frozen}`);

const duplicated = replay(mandate, [
  step('dup-a', 'out_of_scope', 'same.test.near', '5'),
  step('dup-b', 'out_of_scope', 'same.test.near', '5'),
]);
assert(duplicated.frozen === true && duplicated.blocks === 2, `duplicate fingerprint frozen ${duplicated.frozen} blocks ${duplicated.blocks}`);

const key = KeyPair.fromRandom('ed25519');
const agentKey = path.join(TMP, 'agent-key.json');
fs.writeFileSync(agentKey, JSON.stringify({
  account_id: AGENT,
  public_key: key.getPublicKey().toString(),
  private_key: key.toString(),
}), { mode: 0o600 });
fs.chmodSync(agentKey, 0o600);
fs.mkdirSync(path.join(TMP, 'mandates'), { recursive: true });

const plan = {
  remaining: BUDGET.toString(),
  txs: [],
};
let txCalls = 0;

function decisionLog(data) {
  return `EVENT_JSON:${JSON.stringify({
    standard: 'chopgate',
    version: '1.0.0',
    event: 'decision',
    data: [data],
  })}`;
}

function rpcResult(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    if (req.url.startsWith('/v0/account')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        account_txs: plan.txs.map((row) => ({
          transaction_hash: row.hash,
          tx_block_height: row.height,
          tx_index: row.index,
        })),
      }));
      return;
    }
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (message.method === 'send_tx' || message.method === 'broadcast_tx_async') {
      txCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32000, message: 'replay test refuses transactions' },
      }));
      return;
    }
    if (message.method === 'EXPERIMENTAL_tx_status') {
      const found = plan.txs.find((row) => row.hash === message.params?.tx_hash);
      if (!found) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32000, message: 'unknown tx' },
        }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(rpcResult(message.id, {
        transaction: { signer_id: found.signer, hash: found.hash },
        transaction_outcome: {
          id: found.hash,
          outcome: { logs: [decisionLog(found.decision)] },
        },
        receipts_outcome: [],
        status: { SuccessValue: Buffer.from('null').toString('base64') },
      }));
      return;
    }
    if (message.method === 'query' && message.params?.request_type === 'view_access_key') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(rpcResult(message.id, {
        nonce: 1,
        permission: {
          FunctionCall: {
            allowance: null,
            receiver_id: GATE,
            method_names: ['authorize_and_pay_tiered'],
          },
        },
        block_hash: '11111111111111111111111111111111',
        block_height: 1,
      }));
      return;
    }
    if (message.method === 'query' && message.params?.request_type === 'call_function') {
      const bytes = [...Buffer.from(JSON.stringify(plan.remaining))];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(rpcResult(message.id, {
        result: bytes,
        logs: [],
        block_height: 1,
        block_hash: '11111111111111111111111111111111',
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(rpcResult(message.id, { chain_id: 'sandbox' }));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const rpc = `http://127.0.0.1:${port}`;
fs.writeFileSync(path.join(TMP, 'networks.json'), JSON.stringify({
  sandbox: {
    enabled: true,
    networkId: 'sandbox',
    rpc: [rpc],
    archivalRpc: [rpc],
    txIndexApi: `${rpc}/v0/account`,
    explorer: 'http://127.0.0.1/txns/',
  },
}));
process.env.CHOPGATE_NETWORKS_FILE = path.join(TMP, 'networks.json');
process.env.CHOPGATE_MANDATES = path.join(TMP, 'mandates');
process.env.CHOPGATE_LEDGER = path.join(TMP, 'ledger.jsonl');
process.env.CHOPGATE_AGENT_KEY = agentKey;
process.env.CHOPGATE_VIEW_TIMEOUT_MS = '5000';

function writeMandate(entryList) {
  fs.writeFileSync(path.join(TMP, 'mandates', 'one.json'), JSON.stringify({
    network: 'sandbox',
    gate: GATE,
    agent: AGENT,
    serial: 7,
    budget: BUDGET.toString(),
    expires_at: '9999999999999999999',
    entries: entryList,
  }));
}

function resetLedger() {
  fs.rmSync(process.env.CHOPGATE_LEDGER, { force: true });
}

const entry = {
  action: 'transfer',
  target: PAYEE,
  max_amount: BUDGET.toString(),
  instruction,
};

try {
  writeMandate([entry]);
  plan.remaining = BUDGET.toString();
  plan.txs = [
    {
      hash: 'block-late',
      height: 20,
      index: 0,
      signer: AGENT,
      decision: step('block-late', 'policy_rule_denied', 'other-b.test.near', '2').decision,
    },
    {
      hash: 'block-early',
      height: 10,
      index: 1,
      signer: AGENT,
      decision: step('block-early', 'out_of_scope', 'other-a.test.near', '1').decision,
    },
    {
      hash: 'block-early',
      height: 10,
      index: 1,
      signer: AGENT,
      decision: step('block-early', 'out_of_scope', 'other-a.test.near', '1').decision,
    },
  ];
  const history = await chainDecisions('sandbox', GATE);
  assert(history.ok === true, `history ${history.error}`);
  assert(history.decisions.length === 2, `deduped decisions ${history.decisions.length}`);
  assert(history.decisions[0].tx_hash === 'block-early' && history.decisions[1].tx_hash === 'block-late', 'tx order');

  const report = await status({ gate: GATE });
  const summary = report.mandates[0];
  assert(summary.freeze_known_from === 'chain', `freeze source ${summary.freeze_known_from} ${summary.note}`);
  assert(summary.blocks_in_a_row === 2, `blocks ${summary.blocks_in_a_row}`);
  assert(summary.frozen === false, 'two blocks froze');
  assert(summary.next_block_would_freeze === true, 'next flag');
  assert(summary.source === 'chain', `mandate source ${summary.source}`);
  const secondFp = fingerprintOf('transfer', 'other-b.test.near', '2', hash, AGENT);
  assert(summary.last_block_fingerprint === secondFp, 'last fingerprint');
  assert(report.entries[0].state === 'unused', `entry state ${report.entries[0].state}`);

  async function refused(args, label) {
    const before = txCalls;
    const result = await pay({
      entry_id: `${GATE}#7:0`,
      amount: '0.1',
      source: 'owner_chat',
      ...args,
    });
    assert(result.reason_code === 'freeze_risk_not_sent', `${label} ${result.reason_code} ${result.message || ''}`);
    assert(result.sent === false, `${label} sent`);
    assert(result.tx_hash === null, `${label} tx`);
    assert(result.reason_en === FREEZE_RISK_NEXT_EN, `${label} en ${result.reason_en}`);
    assert(result.reason_ko === FREEZE_RISK_NEXT_KO, `${label} ko`);
    assert(result.freeze_known_from === 'chain', `${label} source ${result.freeze_known_from}`);
    assert(result.next_block_would_freeze === true, `${label} next`);
    assert(txCalls === before, `${label} broadcast`);
    return result;
  }
  await refused({}, 'default call');
  await refused({ target: 'elsewhere.test.near' }, 'override call');
  await refused({ amount: '0.2' }, 'other amount');

  resetLedger();
  plan.txs = [
    {
      hash: 'dup-1',
      height: 3,
      index: 0,
      signer: AGENT,
      decision: step('dup-1', 'out_of_scope', 'same.test.near', '5').decision,
    },
    {
      hash: 'dup-2',
      height: 4,
      index: 0,
      signer: AGENT,
      decision: step('dup-2', 'out_of_scope', 'same.test.near', '5').decision,
    },
  ];
  const frozenReport = await status({ gate: GATE });
  assert(frozenReport.mandates[0].frozen === true, 'same fingerprint did not freeze');
  assert(frozenReport.mandates[0].freeze_known_from === 'chain', 'duplicate source');
  assert(frozenReport.mandates[0].next_block_would_freeze === false, 'frozen still warns next');
  const frozenPay = await pay({
    entry_id: `${GATE}#7:0`,
    amount: '0.1',
    source: 'owner_chat',
  });
  assert(frozenPay.reason_code === 'frozen_not_sent', `duplicate pay ${frozenPay.reason_code} ${frozenPay.message || ''}`);
  assert(frozenPay.sent === false && frozenPay.tx_hash === null, 'duplicate pay sent');
  assert(frozenPay.reason_en === describeReason('frozen_not_sent').reason_en, 'frozen en');
  assert(txCalls === 0, `tx calls ${txCalls}`);

  resetLedger();
  writeMandate([entry, { ...entry, instruction: 'replay invoice' }]);
  plan.remaining = (BUDGET - 1000n).toString();
  plan.txs = [
    {
      hash: 'allow-tx',
      height: 8,
      index: 0,
      signer: AGENT,
      decision: step('allow-tx', 'allowed', PAYEE, '1000').decision,
    },
  ];
  fs.writeFileSync(process.env.CHOPGATE_LEDGER, `${[
    JSON.stringify({
      phase: 'result',
      sent: 'unknown',
      broadcast: true,
      tx_hash: 'allow-tx',
      attempt_id: 'explained',
      gate: GATE,
      serial: '7',
      reason_code: 'rpc_uncertain',
      fingerprint: 'explained-fp',
    }),
    JSON.stringify({
      phase: 'result',
      sent: 'unknown',
      broadcast: true,
      tx_hash: 'still-open',
      attempt_id: 'open',
      gate: GATE,
      serial: '7',
      reason_code: 'rpc_uncertain',
      fingerprint: 'open-fp',
    }),
  ].join('\n')}\n`);
  const usedReport = await status({ gate: GATE });
  assert(usedReport.mandates[0].freeze_known_from === 'chain', `allow source ${usedReport.mandates[0].freeze_known_from} ${usedReport.mandates[0].note}`);
  assert(usedReport.entries.length === 2, `entries ${usedReport.entries.length}`);
  assert(usedReport.entries[0].state === 'used', `entry 0 ${usedReport.entries[0].state}`);
  assert(usedReport.entries[1].state === 'unused', `entry 1 ${usedReport.entries[1].state}`);
  assert(usedReport.entries[0].evidence?.tx_hash === 'allow-tx', 'used evidence hash');
  const unresolved = usedReport.unresolved_sends.map((row) => row.tx_hash);
  assert(!unresolved.includes('allow-tx'), `explained hash still unresolved ${unresolved.join(',')}`);
  assert(unresolved.includes('still-open'), `open hash missing ${unresolved.join(',')}`);
  console.log(JSON.stringify({
    two_blocks: report.mandates[0].blocks_in_a_row,
    next: report.mandates[0].next_block_would_freeze,
    duplicate_frozen: frozenReport.mandates[0].frozen,
    used: usedReport.entries.map((row) => row.state),
    unresolved,
    tx_calls: txCalls,
  }));
  console.log('ok chain replay');
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
}
