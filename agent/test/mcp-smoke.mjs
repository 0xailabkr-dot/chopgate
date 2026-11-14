// Spawns the MCP server over stdio. Status uses a mock chain. Pay is a local refusal.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { KeyPair } from 'near-api-js';
import { FREEZE_LOCAL_BOUND_EN, FREEZE_LOCAL_BOUND_KO, describeReason } from '../src/reasons.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chopgate-mcp-smoke-'));
const BUDGET = '1000000000000000000000000';
const GATE = 'gate.test.near';
const AGENT = 'agent.test.near';

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const goodKey = KeyPair.fromRandom('ed25519');
const fullKey = KeyPair.fromRandom('ed25519');
const wrongKey = KeyPair.fromRandom('ed25519');
const keyPermission = new Map([
  [goodKey.getPublicKey().toString(), {
    FunctionCall: {
      allowance: null,
      receiver_id: GATE,
      method_names: ['authorize_and_pay_tiered'],
    },
  }],
  [fullKey.getPublicKey().toString(), 'FullAccess'],
  [wrongKey.getPublicKey().toString(), {
    FunctionCall: {
      allowance: null,
      receiver_id: 'other.test.near',
      method_names: ['authorize_and_pay_tiered'],
    },
  }],
]);
const TX_METHODS = new Set([
  'send_tx',
  'broadcast_tx_async',
  'broadcast_tx',
  'EXPERIMENTAL_broadcast_tx',
  'send_tx_async',
  'tx',
]);
let txCalls = 0;
const viewedKeys = [];

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    if (req.url.startsWith('/v0/account')) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('tx index unavailable');
      return;
    }
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (TX_METHODS.has(message.method)) {
      txCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32000, message: 'smoke mock refuses transactions' },
      }));
      return;
    }
    if (message.method === 'query' && message.params?.request_type === 'view_access_key') {
      const publicKey = message.params.public_key;
      viewedKeys.push(publicKey);
      const permission = keyPermission.get(publicKey);
      if (!permission) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32000, message: 'unknown access key', name: 'UNKNOWN_ACCESS_KEY' },
        }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          nonce: 0,
          permission,
          block_hash: '11111111111111111111111111111111',
          block_height: 1,
        },
      }));
      return;
    }
    if (message.method === 'query' && message.params?.request_type === 'call_function') {
      const bytes = [...Buffer.from(JSON.stringify(BUDGET))];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          result: bytes,
          logs: [],
          block_height: 1,
          block_hash: '11111111111111111111111111111111',
        },
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: { chain_id: 'sandbox' },
    }));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const rpc = `http://127.0.0.1:${port}`;
fs.mkdirSync(path.join(TMP, 'mandates'), { recursive: true });
const networks = {
  sandbox: {
    enabled: true,
    networkId: 'sandbox',
    rpc: [rpc],
    archivalRpc: [rpc],
    txIndexApi: `${rpc}/v0/account`,
    explorer: 'http://127.0.0.1/txns/',
  },
  mainnet: { enabled: false, networkId: '', rpc: '', archivalRpc: '', txIndexApi: '', explorer: '' },
};
const networksFile = path.join(TMP, 'networks.json');
fs.writeFileSync(networksFile, JSON.stringify(networks));
fs.writeFileSync(path.join(TMP, 'mandates', 'one.json'), JSON.stringify({
  network: 'sandbox',
  gate: GATE,
  agent: AGENT,
  serial: 7,
  budget: BUDGET,
  expires_at: 1,
  entries: [{
    action: 'transfer',
    target: 'payee.test.near',
    max_amount: BUDGET,
    instruction: 'smoke invoice',
  }],
}));
const agentKey = path.join(TMP, 'agent-key.json');
function writeAgentKey(kp) {
  fs.writeFileSync(agentKey, JSON.stringify({
    account_id: AGENT,
    public_key: kp.getPublicKey().toString(),
    private_key: kp.toString(),
  }), { mode: 0o600 });
  fs.chmodSync(agentKey, 0o600);
}
writeAgentKey(goodKey);

const env = {};
for (const [key, value] of Object.entries(process.env)) {
  if (typeof value === 'string') env[key] = value;
}
env.CHOPGATE_NETWORKS_FILE = networksFile;
env.CHOPGATE_MANDATES = path.join(TMP, 'mandates');
env.CHOPGATE_LEDGER = path.join(TMP, 'ledger.jsonl');
env.CHOPGATE_AGENT_KEY = agentKey;
env.CHOPGATE_NETWORK = 'sandbox';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, 'src/mcp-server.mjs')],
  cwd: ROOT,
  env,
  stderr: 'pipe',
});
let stderr = '';
transport.stderr.on('data', (chunk) => { stderr += chunk; });
const client = new Client({ name: 'chopgate-mcp-smoke', version: '0.0.0' });
try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  assert(names.includes('chopgate_pay') && names.includes('chopgate_status'), `tools ${names.join(',')}`);
  for (const tool of listed.tools) {
    const text = `${tool.description || ''}`;
    assert(/one-use/i.test(text), `${tool.name} description missing one-use`);
    assert(/retry/i.test(text), `${tool.name} description missing retry rule`);
    assert(/owner/i.test(text), `${tool.name} description missing owner`);
    assert(/mandate/i.test(text), `${tool.name} description missing mandate`);
  }
  const payTool = listed.tools.find((tool) => tool.name === 'chopgate_pay');
  const schemaText = JSON.stringify(payTool.inputSchema || payTool);
  assert(schemaText.includes('confirm_freeze_risk'), 'pay schema missing confirm_freeze_risk');
  assert(/freeze/i.test(schemaText), 'pay schema missing freeze description');

  const result = await client.callTool({ name: 'chopgate_status', arguments: {} });
  const raw = result.content?.map((part) => part.text || '').join('\n') || '';
  const report = JSON.parse(raw);
  assert(report.source === 'local-only', `source ${report.source}`);
  assert(report.index_error, 'missing index_error');
  assert(report.entries?.length === 1, 'expected one entry');
  assert(report.entries[0].state === 'expired', `state ${report.entries[0].state}`);
  assert(report.entries[0].entry_id === `${GATE}#7:0`, report.entries[0].entry_id);
  const expiredText = describeReason('mandate_expired_not_sent');
  assert(report.entries[0].reason_code === 'mandate_expired_not_sent', `status reason ${report.entries[0].reason_code}`);
  assert(report.entries[0].reason_en === expiredText.reason_en, 'expired reason_en');
  assert(report.entries[0].reason_ko === expiredText.reason_ko, 'expired reason_ko');
  assert(report.mandates?.[0]?.expired === true, 'mandate expired flag');
  assert(report.mandates[0].freeze_known_from === 'local-ledger', `freeze source ${report.mandates[0].freeze_known_from}`);
  assert(report.mandates[0].freeze_warning_en === FREEZE_LOCAL_BOUND_EN, 'local bound en');
  assert(report.mandates[0].freeze_warning_ko === FREEZE_LOCAL_BOUND_KO, 'local bound ko');

  const paid = await client.callTool({
    name: 'chopgate_pay',
    arguments: {
      entry_id: `${GATE}#7:0`,
      amount: '0.1',
      source: 'owner_chat',
    },
  });
  assert(paid.isError !== true, 'local refusal is not an MCP error');
  const payRaw = paid.content?.map((part) => part.text || '').join('\n') || '';
  const payResult = JSON.parse(payRaw);
  assert(payResult.reason_code === 'mandate_expired_not_sent', `pay ${payResult.reason_code}`);
  assert(payResult.sent === false, `pay sent ${payResult.sent}`);
  assert(payResult.reason_en && payResult.reason_ko, 'pay reason texts');
  assert(!payRaw.includes(goodKey.toString()), 'pay result leaked the agent key');
  assert(!stderr.includes(goodKey.toString()), 'stderr leaked the agent key');
  assert(!/ed25519:[1-9A-HJ-NP-Za-km-z]{60,}/.test(stderr), 'stderr leaked a long key');
  assert(viewedKeys.includes(goodKey.getPublicKey().toString()), 'status did not query the derived public key');
  assert(txCalls === 0, `tx calls after the valid key ${txCalls}`);

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
      instruction: 'smoke invoice',
    }],
  }));

  async function refusedKey(label, kp, code) {
    writeAgentKey(kp);
    const beforeTx = txCalls;
    const beforeViews = viewedKeys.length;
    const statusResult = await client.callTool({ name: 'chopgate_status', arguments: { gate: GATE } });
    assert(statusResult.isError === true, `${label} status did not throw`);
    const statusRaw = statusResult.content?.map((part) => part.text || '').join('\n') || '';
    const statusBody = JSON.parse(statusRaw);
    assert(statusBody.reason_code === code, `${label} status ${statusBody.reason_code}`);
    const payResult = await client.callTool({
      name: 'chopgate_pay',
      arguments: {
        entry_id: `${GATE}#7:0`,
        amount: '0.1',
        source: 'owner_chat',
        confirm_freeze_risk: true,
      },
    });
    const refusedRaw = payResult.content?.map((part) => part.text || '').join('\n') || '';
    const refused = JSON.parse(refusedRaw);
    assert(payResult.isError !== true, `${label} pay is an MCP error`);
    assert(refused.reason_code === code, `${label} pay ${refused.reason_code}`);
    assert(refused.sent === false, `${label} pay sent ${refused.sent}`);
    assert(refused.tx_hash === null, `${label} pay tx ${refused.tx_hash}`);
    assert(txCalls === beforeTx, `${label} broadcast a transaction`);
    assert(viewedKeys.slice(beforeViews).includes(kp.getPublicKey().toString()), `${label} view missed the derived key`);
    assert(!statusRaw.includes(kp.toString()) && !refusedRaw.includes(kp.toString()), `${label} leaked the key`);
    return { reason_code: refused.reason_code, sent: refused.sent, tx_hash: refused.tx_hash, status: statusBody.reason_code };
  }

  const fullAccess = await refusedKey('full access', fullKey, 'full_access_key_refused');
  const wrongScope = await refusedKey('wrong scope', wrongKey, 'key_scope_mismatch');

  console.log(JSON.stringify({
    tools: names,
    source: report.source,
    index_error: report.index_error,
    confirm_freeze_risk: true,
    entry: {
      entry_id: report.entries[0].entry_id,
      state: report.entries[0].state,
    },
    pay: {
      reason_code: payResult.reason_code,
      sent: payResult.sent,
      reason_en: payResult.reason_en,
      reason_ko: payResult.reason_ko,
      isError: paid.isError === true,
    },
    full_access: fullAccess,
    wrong_scope: wrongScope,
    tx_calls: txCalls,
  }, null, 2));
  console.log('ok mcp smoke');
} finally {
  await client.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
}
