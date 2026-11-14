// Local near-sandbox proof of the agent library and the owner approval script.
// Keys live only under .sandbox-tmp and are deleted at the end.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Account, JsonRpcProvider, KeyPair, PublicKey, actions, baseEncode, encodeTransaction } from 'near-api-js';
import { sha256, sha256hex, signingBytes, tier2ConfigBytes } from '../src/vendor/chopgate-encode.mjs';
import {
  SEND_RESENDS,
  assertAccountNotMainnet,
  assertNetworkEnabled,
  broadcastPossible,
  callWouldFreeze,
  interpretOutcome,
  isProductionNearAccount,
  loadAgentKey,
  parseAmount,
  pay,
  projectAfter,
  publicKeyFromSeed,
  setProviderHookForTests,
  signOwnerPayload,
  status,
  blockTimestampNs,
  viewAccountAmount,
} from '../src/chopgate-agent.mjs';
import {
  FREEZE_LOCAL_BOUND_EN,
  FREEZE_LOCAL_BOUND_KO,
  FREEZE_RISK_UNKNOWN_EN,
  FREEZE_RISK_UNKNOWN_KO,
  FREEZE_WARNING_EN,
  FREEZE_WARNING_KO,
  STATE_UNVERIFIED_NOTE,
  describeReason,
} from '../src/reasons.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, '.sandbox-tmp');
const SANDBOX = process.env.CHOPGATE_SANDBOX;
if (!SANDBOX) {
  throw new Error('CHOPGATE_SANDBOX is required');
}
const WASM = process.env.CHOPGATE_WASM || path.join(path.dirname(fileURLToPath(import.meta.url)), '../../target/near/chopgate.wasm');
const NEAR = 10n ** 24n;
const GAS = 300_000_000_000_000n;

function log(message) {
  console.log(message);
}

function fail(message) {
  throw new Error(message);
}

function assert(cond, message) {
  if (!cond) fail(message);
}

function assertThrows(fn, code) {
  try {
    fn();
  } catch (error) {
    assert(error.code === code, `expected ${code}, got ${error.code || ''} ${error.message}`);
    return;
  }
  fail(`expected throw ${code}`);
}

// serde_json reads a JSON integer's decimal digits into u64. JSON.stringify of an
// f64-exact integer above 2^53 can print a different decimal that is the same f64.
// Sign only a value whose printed digits are exactly that integer.
function futureExactNs(days) {
  let value = BigInt(Date.now()) * 1_000_000n + BigInt(days) * 86_400n * 1_000_000_000n;
  const step = 1n << 20n;
  if (value % step !== 0n) value = (value / step + 1n) * step;
  for (let i = 0; i < 4096; i++) {
    const num = Number(value);
    if (BigInt(num) === value && JSON.stringify(num) === value.toString()) return value;
    value += step;
  }
  fail('expires_at is not a JSON-stable integer');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitRpc(url) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'status', params: [] }),
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        const body = await response.json();
        if (body.result) return;
      }
    } catch { /* node still starting */ }
    await sleep(400);
  }
  fail('sandbox rpc did not start');
}

function stopSandbox(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
}

async function send(account, contract, method, args, deposit = 0n) {
  const outcome = await account.signAndSendTransaction({
    receiverId: contract,
    actions: [actions.functionCall(method, args, GAS, deposit)],
    waitUntil: 'FINAL',
    throwOnFailure: false,
    retries: 0,
  });
  const parsed = interpretOutcome(outcome);
  if (parsed.failure) {
    const text = JSON.stringify(parsed.failure).slice(0, 500);
    fail(`${method} execution failed: ${text}`);
  }
  return parsed;
}

function write600(file, text) {
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

async function main() {
  assert(parseAmount('0.005') === 5_000_000_000_000_000_000_000n, '0.005 NEAR');
  assert(parseAmount('1') === NEAR, '1 NEAR');
  assert(parseAmount('1000yocto') === 1000n, '1000 yocto');
  const probe = crypto.randomBytes(32);
  const message = Buffer.from('chopgate-sign-check');
  const { createPrivateKey, createPublicKey, sign } = crypto;
  const pkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    probe,
  ]);
  const priv = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const sig = sign(null, message, priv);
  const spki = createPublicKey(priv).export({ format: 'der', type: 'spki' });
  assert(spki.length >= 32, 'spki');
  assert(PublicKey.from(publicKeyFromSeed(probe)).verify(message, sig), 'node ed25519 verifies with near-api-js');
  assert(parseAmount('0') === 0n, 'zero parses and is refused later by pay');
  assert(SEND_RESENDS === 0, 'send provider resend count');
  for (const bad of ['-1', '1e3', '0.0000000000000000000000001']) {
    let threw = false;
    try { parseAmount(bad); } catch { threw = true; }
    assert(threw, `parseAmount rejected ${bad}`);
  }
  let hugeThrew = false;
  try { parseAmount(`${(1n << 128n).toString()}yocto`); } catch { hugeThrew = true; }
  assert(hugeThrew, 'amount above u128 is rejected');
  assert(isProductionNearAccount('alice.near') === true, 'alice.near');
  assert(isProductionNearAccount('agent.example.testnet') === false, 'testnet suffix');
  assert(isProductionNearAccount('gate.test.near') === false, 'sandbox suffix');
  const savedNetworks = process.env.CHOPGATE_NETWORKS_FILE;
  const unitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chopgate-unit-'));
  try {
    delete process.env.CHOPGATE_NETWORKS_FILE;
    assertThrows(() => assertNetworkEnabled('mainnet'), 'network_not_enabled');
    assert(assertNetworkEnabled('testnet').networkId === 'testnet', 'default testnet');
    const badNet = path.join(unitDir, 'networks.json');
    fs.writeFileSync(badNet, JSON.stringify({
      mainnet: {
        enabled: true,
        networkId: 'mainnet',
        rpc: ['http://127.0.0.1:1'],
        archivalRpc: [],
        txIndexApi: '',
        explorer: '',
      },
      weird: {
        enabled: true,
        networkId: 'betanet',
        rpc: ['http://127.0.0.1:1'],
        archivalRpc: [],
        txIndexApi: '',
        explorer: '',
      },
      sandbox: {
        enabled: true,
        networkId: 'sandbox',
        rpc: ['http://127.0.0.1:9'],
        archivalRpc: [],
        txIndexApi: '',
        explorer: '',
      },
    }));
    process.env.CHOPGATE_NETWORKS_FILE = badNet;
    assertThrows(() => assertNetworkEnabled('mainnet'), 'network_not_enabled');
    assertThrows(() => assertNetworkEnabled('weird'), 'network_not_enabled');
    assert(assertNetworkEnabled('sandbox').networkId === 'sandbox', 'override sandbox');
    assertThrows(() => assertAccountNotMainnet('alice.near'), 'network_not_enabled');
    assertAccountNotMainnet('gate.test.near');
    const keyFile = path.join(unitDir, 'agent-key.json');
    const unitKey = KeyPair.fromRandom('ed25519');
    fs.writeFileSync(keyFile, JSON.stringify({
      account_id: 'agent.test.near',
      public_key: unitKey.getPublicKey().toString(),
      private_key: unitKey.toString(),
    }), { mode: 0o644 });
    fs.chmodSync(keyFile, 0o644);
    assertThrows(() => loadAgentKey(keyFile), 'key_refused');
    fs.chmodSync(keyFile, 0o600);
    const loaded = loadAgentKey(keyFile);
    assert(loaded.accountId === 'agent.test.near', 'key account');
    assert(loaded.publicKey === unitKey.getPublicKey().toString(), 'loaded public key');
    assert(loaded.toJSON().private_key === undefined, 'toJSON omits the secret');
    fs.rmSync(keyFile, { force: true });
    const badSeed = path.join(unitDir, 'owner.seed');
    const badSubmitter = path.join(unitDir, 'submitter.json');
    fs.writeFileSync(badSeed, `${'ab'.repeat(32)}\n`, { mode: 0o644 });
    fs.writeFileSync(badSubmitter, '{}\n', { mode: 0o600 });
    const modeRun = await new Promise((resolve) => {
      const child = spawn(process.execPath, [
        path.join(ROOT, 'scripts/approve-pending.mjs'),
        '--gate', 'gate.test.near',
        '--id', '1',
        '--approve',
      ], {
        env: {
          ...process.env,
          OWNER_SIGNING_KEY_FILE: badSeed,
          SUBMITTER_KEY_FILE: badSubmitter,
        },
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('exit', (code) => resolve({ code, stderr }));
    });
    assert(modeRun.code !== 0, 'mode 644 seed exited 0');
    assert(modeRun.stderr.includes('mode 600'), `mode stderr ${modeRun.stderr}`);
    assert(!modeRun.stderr.includes('ab'.repeat(32)), 'mode check printed the seed');
    const hugeRun = await new Promise((resolve) => {
      const child = spawn(process.execPath, [
        path.join(ROOT, 'scripts/approve-pending.mjs'),
        '--gate', 'gate.test.near',
        '--id', '9007199254740993',
        '--reject',
      ], { env: { ...process.env } });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('exit', (code) => resolve({ code, stderr }));
    });
    assert(hugeRun.code !== 0, 'unsafe id exited 0');
    assert(hugeRun.stderr.includes('safe JSON'), `unsafe id stderr ${hugeRun.stderr}`);
  } finally {
    if (savedNetworks === undefined) delete process.env.CHOPGATE_NETWORKS_FILE;
    else process.env.CHOPGATE_NETWORKS_FILE = savedNetworks;
    fs.rmSync(unitDir, { recursive: true, force: true });
  }
  log('ok amount parsing, network refusal, key mode, and ed25519');

  const openIntent = [{ phase: 'intent', attempt_id: 'a', gate: 'g', serial: '1', fingerprint: 'fp' }];
  assert(broadcastPossible(openIntent, 'g', '1', 'fp') === true, 'same serial is a duplicate');
  assert(broadcastPossible(openIntent, 'g', '2', 'fp') === false, 'other serial is not a duplicate');
  const baseSummary = {
    frozen: false,
    blocks_in_a_row: 1,
    last_block_fingerprint: 'fp-old',
    next_block_would_freeze: true,
    freeze_warning_en: FREEZE_WARNING_EN,
    freeze_warning_ko: FREEZE_WARNING_KO,
  };
  const failed = projectAfter(baseSummary, 'fp-new', 'execution_failure');
  assert(failed.blocks_in_a_row === 1, `execution_failure blocks ${failed.blocks_in_a_row}`);
  assert(failed.mandate_frozen === false, 'execution_failure froze');
  assert(failed.last_block_fingerprint === 'fp-old', 'execution_failure moved the fingerprint');
  assert(failed.state_note === STATE_UNVERIFIED_NOTE, 'execution_failure note');
  const internal = projectAfter(baseSummary, 'fp-new', 'internal_error');
  assert(internal.blocks_in_a_row === 1 && internal.state_note === STATE_UNVERIFIED_NOTE, 'internal_error projection');
  const staleFrozen = projectAfter({
    frozen: false,
    blocks_in_a_row: 0,
    last_block_fingerprint: null,
    next_block_would_freeze: false,
  }, 'fp', 'auto_frozen');
  assert(staleFrozen.mandate_frozen === true, 'auto_frozen did not force the flag');
  assert(callWouldFreeze({ frozen: false, blocks_in_a_row: 2, last_block_fingerprint: null }, 'other') === 'yes', 'blocks>=2 requires confirm');
  assert(callWouldFreeze({ frozen: false, blocks_in_a_row: 1, last_block_fingerprint: null }, 'other') === 'no', 'one block does not freeze the next different call');
  assert(callWouldFreeze({ frozen: false, blocks_in_a_row: 1, last_block_fingerprint: 'same' }, 'same') === 'yes', 'repeat fingerprint');
  assert(callWouldFreeze({ frozen: null, blocks_in_a_row: null }, 'x') === 'unknown', 'unknown freeze');
  log('ok projection, confirm rule, and serial duplicate');

  fs.rmSync(TMP, { recursive: true, force: true });
  const home = path.join(TMP, 'near-home');
  fs.mkdirSync(home, { recursive: true });
  const port = await freePort();
  const rpc = `http://127.0.0.1:${port}`;
  const init = spawn(SANDBOX, ['--home', home, 'init', '--fast', '--chain-id', 'sandbox'], { stdio: 'ignore' });
  const initCode = await new Promise((resolve) => init.on('exit', resolve));
  assert(initCode === 0, `sandbox init exited ${initCode}`);

  const logFd = fs.openSync(path.join(TMP, 'sandbox.log'), 'a');
  const child = spawn(SANDBOX, ['--home', home, 'run', '--rpc-addr', `127.0.0.1:${port}`], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  try {
    await waitRpc(rpc);
    const nodeStatus = await fetch(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'status', params: [] }),
    });
    const nodeBody = await nodeStatus.json();
    assert(nodeBody.result?.chain_id === 'sandbox', `sandbox chain_id ${nodeBody.result?.chain_id}`);
    log(`ok sandbox rpc ${rpc} chain_id ${nodeBody.result.chain_id}`);
    const validator = JSON.parse(fs.readFileSync(path.join(home, 'validator_key.json'), 'utf8'));
    assert(validator.account_id === 'test.near', `genesis account is ${validator.account_id}`);
    const provider = new JsonRpcProvider({ url: rpc }, { retries: 1, wait: 200, backoff: 1 });
    const master = new Account(validator.account_id, provider, validator.secret_key);

    async function makeAccount(prefix, near) {
      const kp = KeyPair.fromRandom('ed25519');
      const id = `${prefix}.${validator.account_id}`;
      await master.createAccount({
        newAccountId: id,
        publicKey: kp.getPublicKey().toString(),
        nearToTransfer: near * NEAR,
      });
      for (let i = 0; i < 20; i++) {
        try {
          await provider.viewAccount({ accountId: id, blockQuery: { finality: 'final' } });
          break;
        } catch {
          await sleep(300);
        }
      }
      return { id, publicKey: kp.getPublicKey().toString(), secret: kp.toString() };
    }

    const owner = await makeAccount('owner', 100n);
    const agent = await makeAccount('agent', 20n);
    const payee = await makeAccount('payee', 10n);
    const attacker = await makeAccount('attacker', 5n);
    const other = await makeAccount('other', 5n);
    const gate = await makeAccount('gate', 80n);
    log(`ok accounts ${[owner, agent, payee, attacker, other, gate].map((a) => a.id).join(' ')}`);

    const gateAccount = new Account(gate.id, provider, gate.secret);
    const wasm = fs.readFileSync(WASM);
    const wasmHash = crypto.createHash('sha256').update(wasm).digest('hex');
    assert(wasmHash.startsWith('6e20ac13'), `unexpected wasm ${wasmHash}`);
    await gateAccount.deployContract(wasm);
    const seed = crypto.randomBytes(32);
    const ownerPk = publicKeyFromSeed(seed);
    const seedPath = path.join(TMP, 'owner.seed');
    write600(seedPath, `${seed.toString('hex')}\n`);
    await send(gateAccount, gate.id, 'new', {
      owner_public_key: ownerPk,
      chain_id: 'sandbox',
      deployment_id: 'u3-sandbox',
    });
    const domain = await provider.callFunction({
      contractId: gate.id,
      method: 'signature_domain',
      args: {},
      blockQuery: { finality: 'final' },
    });
    assert(Array.isArray(domain) && domain[0] === 'sandbox', 'signature_domain chain');
    assert(domain[2] === ownerPk, 'signature_domain owner key');
    const chainId = domain[0];
    const deploymentId = domain[1];
    log(`ok gate deployed deployment ${deploymentId}`);

    const threshold = NEAR;
    const ttlNs = 3_600_000_000_000n;
    const tier2Lists = {
      new_payee_check: false,
      trusted_sources: [],
      known_payees: [],
      denied_targets: [],
    };
    const cfgSign = {
      config_nonce: 1n,
      amount_threshold: threshold.toString(),
      pending_ttl_ns: ttlNs,
      ...tier2Lists,
    };
    const cfgChain = {
      config_nonce: 1,
      amount_threshold: threshold.toString(),
      pending_ttl_ns: Number(ttlNs),
      ...tier2Lists,
    };
    const cfgSig = signOwnerPayload(seed, chainId, deploymentId, ownerPk, tier2ConfigBytes(gate.id, cfgSign));
    const ownerAccount = new Account(owner.id, provider, owner.secret);
    const cfgResult = await send(ownerAccount, gate.id, 'set_tier2_config', {
      config: cfgChain,
      signature: cfgSig.signature,
    });
    assert(!cfgResult.failure, 'tier2 config');
    log('ok tier2 config amount_threshold 1 NEAR');

    await send(ownerAccount, gate.id, 'deposit', {}, 20n * NEAR);
    log('ok escrow deposit 20 NEAR');

    const expiresAt = futureExactNs(30);
    assert(JSON.stringify(Number(expiresAt)) === expiresAt.toString(), 'register expires_at JSON digits');
    const specs = [
      { action: 'transfer', target: payee.id, max: NEAR, instruction: 'pay the sandbox invoice' },
      { action: 'transfer', target: payee.id, max: NEAR, instruction: 'pay the redirect invoice' },
      { action: 'transfer', target: payee.id, max: NEAR / 5n, instruction: 'pay the capped invoice' },
      { action: 'transfer', target: payee.id, max: 5n * NEAR, instruction: 'pay the large invoice' },
      { action: 'transfer', target: payee.id, max: 5n * NEAR, instruction: 'pay the reject invoice' },
      { action: 'transfer', target: payee.id, max: 5n * NEAR, instruction: 'pay the expire invoice' },
    ];
    const signedEntries = [];
    for (const spec of specs) {
      signedEntries.push({
        action: spec.action,
        target: spec.target,
        max_amount: spec.max.toString(),
        instruction_hash: await sha256hex(spec.instruction),
      });
    }
    const budget = 10n * NEAR;
    const mandate = {
      serial: 1n,
      agent: agent.id,
      entries: signedEntries,
      budget: budget.toString(),
      expires_at: expiresAt,
      parent_serial: null,
    };
    const regSig = signOwnerPayload(seed, chainId, deploymentId, ownerPk, signingBytes(gate.id, mandate));
    const registered = await send(ownerAccount, gate.id, 'register', {
      mandate: {
        serial: 1,
        agent: agent.id,
        entries: signedEntries,
        budget: budget.toString(),
        expires_at: Number(expiresAt),
        parent_serial: null,
      },
      signer_public_key: ownerPk,
      signature: regSig.signature,
    });
    assert(registered.decision?.reason_code === 'allowed', `register ${registered.decision?.reason_code}`);
    log('ok mandate registered');

    const networks = {
      sandbox: {
        enabled: true,
        networkId: 'sandbox',
        rpc: [rpc],
        archivalRpc: [rpc],
        txIndexApi: 'http://127.0.0.1:1/v0/account',
        explorer: 'http://127.0.0.1/txns/',
      },
      mainnet: {
        enabled: false,
        networkId: '',
        rpc: '',
        archivalRpc: '',
        txIndexApi: '',
        explorer: '',
      },
    };
    const networksFile = path.join(TMP, 'networks.json');
    fs.writeFileSync(networksFile, JSON.stringify(networks, null, 2));
    const mandatesDir = path.join(TMP, 'mandates');
    fs.mkdirSync(mandatesDir);
    const snippet = {
      network: 'sandbox',
      gate: gate.id,
      agent: agent.id,
      serial: 1,
      budget: budget.toString(),
      expires_at: expiresAt.toString(),
      entries: specs.map((spec, index) => ({
        action: spec.action,
        target: spec.target,
        max_amount: spec.max.toString(),
        instruction: spec.instruction,
        instruction_hash: signedEntries[index].instruction_hash,
      })),
    };
    fs.writeFileSync(path.join(mandatesDir, 'sandbox.json'), JSON.stringify(snippet, null, 2));
    // The library refuses a full-access agent key. Keep one function-call key for the
    // gate method, plus two extra keys that the refusal cases swap in and then delete.
    const originalAgent = { publicKey: agent.publicKey, secret: agent.secret };
    const fcKey = KeyPair.fromRandom('ed25519');
    const faKey = KeyPair.fromRandom('ed25519');
    const wrongKey = KeyPair.fromRandom('ed25519');
    await new Account(agent.id, provider, originalAgent.secret).signAndSendTransaction({
      receiverId: agent.id,
      actions: [
        actions.addFunctionCallAccessKey(fcKey.getPublicKey(), gate.id, ['authorize_and_pay_tiered'], null),
        actions.addFullAccessKey(faKey.getPublicKey()),
        actions.addFunctionCallAccessKey(wrongKey.getPublicKey(), payee.id, ['authorize_and_pay_tiered'], null),
      ],
      waitUntil: 'FINAL',
      throwOnFailure: true,
      retries: 0,
    });
    agent.publicKey = fcKey.getPublicKey().toString();
    agent.secret = fcKey.toString();
    const agentKey = path.join(TMP, 'agent-key.json');
    write600(agentKey, JSON.stringify({
      account_id: agent.id,
      public_key: agent.publicKey,
      private_key: agent.secret,
    }));
    const submitterKey = path.join(TMP, 'submitter-key.json');
    write600(submitterKey, JSON.stringify({
      account_id: owner.id,
      public_key: owner.publicKey,
      private_key: owner.secret,
    }));
    process.env.CHOPGATE_NETWORKS_FILE = networksFile;
    process.env.CHOPGATE_MANDATES = mandatesDir;
    process.env.CHOPGATE_AGENT_KEY = agentKey;
    process.env.CHOPGATE_LEDGER = path.join(TMP, 'ledger.jsonl');
    process.env.CHOPGATE_NETWORK = 'sandbox';

    const ids = specs.map((_, index) => `${gate.id}#1:${index}`);

    async function agentNonce() {
      const view = await provider.viewAccessKey({
        accountId: agent.id,
        publicKey: agent.publicKey,
      });
      return view.nonce;
    }

    function runScript(scriptArgs) {
      return new Promise((resolve) => {
        const child = spawn(process.execPath, scriptArgs, {
          env: {
            ...process.env,
            OWNER_SIGNING_KEY_FILE: seedPath,
            SUBMITTER_KEY_FILE: submitterKey,
            CHOPGATE_NETWORK: 'sandbox',
            CHOPGATE_NETWORKS_FILE: networksFile,
          },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('exit', (code) => resolve({ code, stdout, stderr }));
      });
    }

    function assertNoSecrets(stdout, stderr) {
      const blob = `${stdout}\n${stderr}`;
      assert(!blob.includes(seed.toString('hex')), 'script leaked the seed');
      assert(!blob.includes(owner.secret), 'script leaked the owner key');
      assert(!blob.includes(agent.secret), 'script leaked the agent key');
      assert(!blob.includes(originalAgent.secret), 'script leaked the original agent key');
      assert(!blob.includes(faKey.toString()), 'script leaked the full-access key');
      assert(!blob.includes(wrongKey.toString()), 'script leaked the other-receiver key');
    }

    function scrub(text) {
      return String(text)
        .split(seed.toString('hex')).join('[seed]')
        .split(agent.secret).join('[key]')
        .split(originalAgent.secret).join('[key]')
        .split(faKey.toString()).join('[key]')
        .split(wrongKey.toString()).join('[key]')
        .split(owner.secret).join('[key]')
        .split(other.secret).join('[key]')
        .slice(0, 500);
    }

    function writeExtra(name, body) {
      fs.writeFileSync(path.join(mandatesDir, name), JSON.stringify(body, null, 2));
    }

    const nonceLocal = await agentNonce();
    for (const badAmount of ['0', '-1', '1e3', '0.0000000000000000000000001']) {
      const refused = await pay({ entry_id: ids[0], amount: badAmount, source: 'owner_chat' });
      assert(refused.reason_code === 'amount_refused', `amount ${badAmount} -> ${refused.reason_code}`);
      assert(refused.sent === false, `amount ${badAmount} sent ${refused.sent}`);
      assert(refused.tx_hash === null, `amount ${badAmount} has a tx hash`);
      assert(refused.reason_en.length > 0, 'amount reason_en');
      assert(refused.reason_ko.length > 0, 'amount reason_ko');
    }
    const nasty = 'owner_chat\nbad-source';
    const badSource = await pay({ entry_id: ids[0], amount: '0.1', source: nasty });
    assert(badSource.reason_code === 'bad_source', `bad source ${badSource.reason_code}`);
    assert(badSource.sent === false, 'bad source sent');
    const ledgerAfterLocal = fs.existsSync(process.env.CHOPGATE_LEDGER)
      ? fs.readFileSync(process.env.CHOPGATE_LEDGER, 'utf8')
      : '';
    assert(!ledgerAfterLocal.includes(nasty), 'rejected source was stored');
    assert(await agentNonce() === nonceLocal, 'local amount refusal changed the nonce');
    log('ok local amount and source refusals');

    fs.writeFileSync(process.env.CHOPGATE_LEDGER, '{bad\n', { mode: 0o600 });
    const corrupt = await pay({ entry_id: ids[0], amount: '0.1', source: 'owner_chat' });
    assert(corrupt.reason_code === 'ledger_corrupt', `corrupt ${corrupt.reason_code} ${corrupt.message || ''}`);
    assert(corrupt.sent === false, 'corrupt ledger sent');
    assert(await agentNonce() === nonceLocal, 'corrupt ledger changed the nonce');
    fs.rmSync(process.env.CHOPGATE_LEDGER, { force: true });
    log('ok ledger_corrupt fail closed');

    writeExtra('mismatch.json', {
      network: 'sandbox',
      gate: gate.id,
      agent: 'someone.test.near',
      serial: 99,
      budget: budget.toString(),
      expires_at: expiresAt.toString(),
      entries: [{
        action: 'transfer',
        target: payee.id,
        max_amount: NEAR.toString(),
        instruction: 'pay the mismatch invoice',
      }],
    });
    const mismatch = await pay({ entry_id: `${gate.id}#99:0`, amount: '0.1', source: 'owner_chat' });
    assert(mismatch.reason_code === 'agent_mismatch_not_sent', `mismatch ${mismatch.reason_code}`);
    assert(mismatch.sent === false, 'mismatch sent');
    assert(mismatch.reason_en.length > 0 && mismatch.reason_ko.length > 0, 'mismatch texts');
    fs.rmSync(path.join(mandatesDir, 'mismatch.json'));

    writeExtra('mainnet.json', {
      network: 'mainnet',
      gate: gate.id,
      agent: agent.id,
      serial: 98,
      budget: budget.toString(),
      expires_at: expiresAt.toString(),
      entries: [{
        action: 'transfer',
        target: payee.id,
        max_amount: NEAR.toString(),
        instruction: 'pay the mainnet invoice',
      }],
    });
    const disabled = await pay({ entry_id: `${gate.id}#98:0`, amount: '0.1', source: 'owner_chat' });
    assert(disabled.reason_code === 'network_not_enabled', `network ${disabled.reason_code} ${disabled.message || ''}`);
    assert(disabled.sent === false, 'network refusal sent');
    assert(disabled.reason_en.length > 0 && disabled.reason_ko.length > 0, 'network texts');
    fs.rmSync(path.join(mandatesDir, 'mainnet.json'));

    writeExtra('expired.json', {
      network: 'sandbox',
      gate: gate.id,
      agent: agent.id,
      serial: 97,
      budget: budget.toString(),
      expires_at: 1,
      entries: [{
        action: 'transfer',
        target: payee.id,
        max_amount: NEAR.toString(),
        instruction: 'pay the expired invoice',
      }],
    });
    const expiredReport = await status({ gate: gate.id });
    const expiredSummary = expiredReport.mandates.find((item) => item.serial === '97');
    assert(expiredSummary?.expired === true, `expired flag ${expiredSummary?.expired}`);
    const expiredEntry = expiredReport.entries.find((item) => item.entry_id === `${gate.id}#97:0`);
    assert(expiredEntry?.state === 'expired', `expired state ${expiredEntry?.state}`);
    assert(expiredEntry?.reason_code === 'mandate_expired_not_sent', `expired reason ${expiredEntry?.reason_code}`);
    assert(expiredEntry?.reason_en === describeReason('mandate_expired_not_sent').reason_en, 'expired en');
    assert(expiredEntry?.reason_ko === describeReason('mandate_expired_not_sent').reason_ko, 'expired ko');
    const expiredLocal = await pay({ entry_id: `${gate.id}#97:0`, amount: '0.1', source: 'owner_chat' });
    assert(expiredLocal.reason_code === 'mandate_expired_not_sent', `expired ${expiredLocal.reason_code}`);
    assert(expiredLocal.sent === false, 'expired sent');
    fs.rmSync(path.join(mandatesDir, 'expired.json'));
    fs.rmSync(process.env.CHOPGATE_LEDGER, { force: true });
    assert(await agentNonce() === nonceLocal, 'local prechecks changed the nonce');
    log('ok agent mismatch, network refusal, expired mandate');

    const lockPath = `${process.env.CHOPGATE_LEDGER}.lock`;
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 2147483646 }));
    const staleAt = new Date(Date.now() - 120_000);
    fs.utimesSync(lockPath, staleAt, staleAt);
    const stale = await pay({ entry_id: ids[0], amount: '0.1', source: 'owner_chat' });
    assert(stale.reason_code === 'ledger_locked', `stale lock ${stale.reason_code} ${stale.message || ''}`);
    assert(stale.sent === false, 'stale lock sent');
    assert(stale.tx_hash === null, 'stale lock tx');
    assert(await agentNonce() === nonceLocal, 'stale lock changed the nonce');
    fs.rmSync(lockPath, { force: true });
    const heldFd = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeSync(heldFd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    const heldLock = await pay({ entry_id: ids[0], amount: '0.1', source: 'owner_chat' });
    assert(heldLock.reason_code === 'ledger_locked', `held lock ${heldLock.reason_code} ${heldLock.message || ''}`);
    assert(heldLock.sent === false, 'held lock sent');
    assert(heldLock.tx_hash === null, 'held lock tx');
    assert(await agentNonce() === nonceLocal, 'held lock changed the nonce');
    fs.closeSync(heldFd);
    fs.rmSync(lockPath, { force: true });
    log('ok stale lock and lock contention');

    const realNetworks = fs.readFileSync(networksFile, 'utf8');
    let leakedMethod = null;
    const chainMock = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        let message = {};
        try { message = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { message = {}; }
        if (message.method !== 'status') leakedMethod = message.method || req.url || 'body';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id ?? 1,
          result: { chain_id: 'mainnet' },
        }));
      });
    });
    await new Promise((resolve) => chainMock.listen(0, '127.0.0.1', resolve));
    const chainPort = chainMock.address().port;
    const poisoned = JSON.parse(realNetworks);
    poisoned.sandbox.rpc = [`http://127.0.0.1:${chainPort}`];
    poisoned.sandbox.archivalRpc = [`http://127.0.0.1:${chainPort}`];
    poisoned.sandbox.txIndexApi = `http://127.0.0.1:${chainPort}/v0/account`;
    fs.writeFileSync(networksFile, JSON.stringify(poisoned));
    const chainRefused = await pay({
      entry_id: ids[0],
      amount: '0.1',
      source: 'owner_chat',
      confirm_freeze_risk: true,
    });
    assert(chainRefused.reason_code === 'chain_id_refused', `chain ${chainRefused.reason_code} ${chainRefused.message || ''}`);
    assert(chainRefused.sent === false, 'chain refusal sent');
    assert(chainRefused.tx_hash === null, 'chain refusal tx');
    assert(chainRefused.reason_en === describeReason('chain_id_refused').reason_en, 'chain en');
    assert(chainRefused.reason_ko === describeReason('chain_id_refused').reason_ko, 'chain ko');
    assert(await agentNonce() === nonceLocal, 'chain refusal changed the nonce');
    assert(leakedMethod === null, `mainnet mock saw ${leakedMethod}`);
    fs.writeFileSync(networksFile, realNetworks);
    await new Promise((resolve) => chainMock.close(resolve));
    log('ok chain_id mainnet refused with no tx');

    let hangHit = false;
    const hang = http.createServer((req) => {
      hangHit = true;
      req.on('data', () => {});
    });
    await new Promise((resolve) => hang.listen(0, '127.0.0.1', resolve));
    process.env.CHOPGATE_RPC_TIMEOUT_MS = '2000';
    process.env.CHOPGATE_REPLAY_DEADLINE_MS = '2500';
    const slowNets = JSON.parse(realNetworks);
    slowNets.sandbox.txIndexApi = `http://127.0.0.1:${hang.address().port}/v0/account`;
    fs.writeFileSync(networksFile, JSON.stringify(slowNets));
    const timed = await pay({ entry_id: ids[0], amount: '0.1', source: 'owner_chat' });
    delete process.env.CHOPGATE_RPC_TIMEOUT_MS;
    delete process.env.CHOPGATE_REPLAY_DEADLINE_MS;
    fs.writeFileSync(networksFile, realNetworks);
    await new Promise((resolve) => hang.close(resolve));
    assert(hangHit === true, 'replay did not call the index');
    assert(timed.reason_code === 'rpc_preflight', `replay timeout ${timed.reason_code} ${timed.message || ''}`);
    assert(timed.sent === false, 'replay timeout sent');
    assert(timed.tx_hash === null, 'replay timeout tx');
    assert(await agentNonce() === nonceLocal, 'replay timeout changed the nonce');
    log('ok index replay deadline is rpc_preflight');

    async function withAgentFile(record, fn) {
      const saved = process.env.CHOPGATE_AGENT_KEY;
      const file = path.join(TMP, `agent-alt-${record.public_key.slice(-8)}.json`);
      write600(file, JSON.stringify(record));
      process.env.CHOPGATE_AGENT_KEY = file;
      try {
        return await fn();
      } finally {
        process.env.CHOPGATE_AGENT_KEY = saved;
        fs.rmSync(file, { force: true });
      }
    }

    const faRecord = {
      account_id: agent.id,
      public_key: faKey.getPublicKey().toString(),
      private_key: faKey.toString(),
    };
    const wrongRecord = {
      account_id: agent.id,
      public_key: wrongKey.getPublicKey().toString(),
      private_key: wrongKey.toString(),
    };
    const nonceBeforeKeyGuard = await agentNonce();
    const faViewBefore = await provider.viewAccessKey({
      accountId: agent.id,
      publicKey: faRecord.public_key,
    });
    const faRefused = await withAgentFile(faRecord, () => pay({
      entry_id: ids[0],
      amount: '0.1',
      source: 'owner_chat',
    }));
    assert(faRefused.reason_code === 'full_access_key_refused', `full access ${faRefused.reason_code} ${faRefused.message || ''}`);
    assert(faRefused.sent === false, 'full access sent');
    assert(faRefused.tx_hash === null, 'full access tx');
    assert(faRefused.reason_en === describeReason('full_access_key_refused').reason_en, 'full access en');
    assert(faRefused.reason_ko === describeReason('full_access_key_refused').reason_ko, 'full access ko');
    let faStatusCode = null;
    try {
      await withAgentFile(faRecord, () => status({ gate: gate.id }));
    } catch (error) {
      faStatusCode = error.code || null;
    }
    assert(faStatusCode === 'full_access_key_refused', `status full access ${faStatusCode}`);
    const faViewAfter = await provider.viewAccessKey({
      accountId: agent.id,
      publicKey: faRecord.public_key,
    });
    assert(faViewAfter.nonce === faViewBefore.nonce, 'full access refusal changed that key nonce');
    assert(await agentNonce() === nonceBeforeKeyGuard, 'full access refusal changed the function-call nonce');

    const wrongViewBefore = await provider.viewAccessKey({
      accountId: agent.id,
      publicKey: wrongRecord.public_key,
    });
    const wrongRefused = await withAgentFile(wrongRecord, () => pay({
      entry_id: ids[0],
      amount: '0.1',
      source: 'owner_chat',
    }));
    assert(wrongRefused.reason_code === 'key_scope_mismatch', `other receiver ${wrongRefused.reason_code} ${wrongRefused.message || ''}`);
    assert(wrongRefused.sent === false, 'other receiver sent');
    assert(wrongRefused.tx_hash === null, 'other receiver tx');
    assert(wrongRefused.reason_en === describeReason('key_scope_mismatch').reason_en, 'other receiver en');
    assert(wrongRefused.reason_ko === describeReason('key_scope_mismatch').reason_ko, 'other receiver ko');
    const wrongViewAfter = await provider.viewAccessKey({
      accountId: agent.id,
      publicKey: wrongRecord.public_key,
    });
    assert(wrongViewAfter.nonce === wrongViewBefore.nonce, 'other receiver refusal changed that key nonce');
    assert(await agentNonce() === nonceBeforeKeyGuard, 'other receiver refusal changed the function-call nonce');
    log('ok function-call key guard refuses full access and another receiver');

    await status({ gate: gate.id });
    await new Account(agent.id, provider, originalAgent.secret).signAndSendTransaction({
      receiverId: agent.id,
      actions: [
        actions.deleteKey(PublicKey.from(agent.publicKey)),
        actions.addFunctionCallAccessKey(PublicKey.from(agent.publicKey), payee.id, ['authorize_and_pay_tiered'], null),
      ],
      waitUntil: 'FINAL',
      throwOnFailure: true,
      retries: 0,
    });
    const swappedNonce = await agentNonce();
    const swapped = await pay({
      entry_id: ids[0],
      amount: '0.07',
      source: 'owner_chat',
      confirm_freeze_risk: true,
    });
    assert(swapped.reason_code === 'key_scope_mismatch', `mid-process scope ${swapped.reason_code} ${swapped.message || ''}`);
    assert(swapped.sent === false, 'mid-process scope sent');
    assert(swapped.tx_hash === null, 'mid-process scope tx');
    assert(await agentNonce() === swappedNonce, 'mid-process scope changed the nonce');
    let swappedStatus = null;
    try {
      await status({ gate: gate.id });
    } catch (error) {
      swappedStatus = error.code || null;
    }
    assert(swappedStatus === 'key_scope_mismatch', `status after the permission change ${swappedStatus}`);
    await new Account(agent.id, provider, originalAgent.secret).signAndSendTransaction({
      receiverId: agent.id,
      actions: [
        actions.deleteKey(PublicKey.from(agent.publicKey)),
        actions.addFunctionCallAccessKey(PublicKey.from(agent.publicKey), gate.id, ['authorize_and_pay_tiered'], null),
      ],
      waitUntil: 'FINAL',
      throwOnFailure: true,
      retries: 0,
    });
    const restored = await status({ gate: gate.id });
    assert(Array.isArray(restored.mandates) && restored.mandates.length > 0, 'status after restoring the function-call key');
    log('ok pay refuses after the key permission changes, and status reflects it immediately');

    // Re-adding the function-call key starts a new nonce. The delete below is
    // signed by the full-access key, so that new nonce must stay put.
    const nonceAfterRestore = await agentNonce();
    await new Account(agent.id, provider, originalAgent.secret).signAndSendTransaction({
      receiverId: agent.id,
      actions: [
        actions.deleteKey(PublicKey.from(originalAgent.publicKey)),
        actions.deleteKey(faKey.getPublicKey()),
        actions.deleteKey(wrongKey.getPublicKey()),
      ],
      waitUntil: 'FINAL',
      throwOnFailure: true,
      retries: 0,
    });
    const keyList = await provider.viewAccessKeyList({ accountId: agent.id });
    assert(keyList.keys.length === 1, `agent keys ${keyList.keys.length}`);
    assert(keyList.keys[0].public_key === agent.publicKey, 'remaining key is not the function-call key');
    assert(await agentNonce() === nonceAfterRestore, 'deleting other keys changed the function-call nonce');
    log('ok agent account has only the function-call key');

    const before = await viewAccountAmount('sandbox', payee.id);

    async function payOnSandbox(args) {
      const nonce = await agentNonce();
      const blocked = await pay(args);
      assert(blocked.reason_code === 'freeze_risk_not_sent', `local-only send refused as ${blocked.reason_code} ${blocked.message || ''}`);
      assert(blocked.sent === false, 'local-only refusal sent');
      assert(blocked.tx_hash === null, 'local-only refusal tx');
      assert(blocked.reason_en === FREEZE_RISK_UNKNOWN_EN, `local-only en ${blocked.reason_en}`);
      assert(blocked.reason_ko === FREEZE_RISK_UNKNOWN_KO, `local-only ko ${blocked.reason_ko}`);
      assert(blocked.freeze_known_from === 'local-ledger', `freeze source ${blocked.freeze_known_from}`);
      assert(await agentNonce() === nonce, 'local-only refusal changed the nonce');
      return pay({ ...args, confirm_freeze_risk: true });
    }

    const allowedText = describeReason('allowed');
    const small = await payOnSandbox({ entry_id: ids[0], amount: '0.1', source: 'owner_chat' });
    assert(small.reason_code === 'allowed', `small pay ${small.reason_code} ${small.message || ''}`);
    assert(small.reason_en === allowedText.reason_en, 'allow reason_en');
    assert(small.reason_ko === allowedText.reason_ko, 'allow reason_ko');
    assert(small.verdict_kind === 'paid', 'allow verdict_kind');
    assert(small.verdict === 'allow', 'small pay verdict');
    assert(small.held === false, 'small pay not held');
    assert(small.sent === true, 'small pay sent');
    assert(small.tx_hash, 'small pay tx');
    assert(small.blocks_in_a_row === 0, `allow blocks ${small.blocks_in_a_row}`);
    assert(small.freeze_warning_en === FREEZE_WARNING_EN, 'allow freeze warning');
    assert(small.freeze_warning_ko === FREEZE_WARNING_KO, 'allow freeze warning ko');
    let after = before;
    for (let i = 0; i < 20; i++) {
      after = await viewAccountAmount('sandbox', payee.id);
      if (after - before === NEAR / 10n) break;
      await sleep(300);
    }
    assert(after - before === NEAR / 10n, `payee delta ${after - before}`);
    log(`ok 1 allow ${small.tx_hash} payee +0.1 NEAR`);

    const redirected = await payOnSandbox({
      entry_id: ids[1],
      amount: '0.1',
      target: attacker.id,
      source: 'owner_chat',
    });
    const scopeText = describeReason('out_of_scope');
    assert(redirected.reason_code === 'out_of_scope', `redirect ${redirected.reason_code}`);
    assert(redirected.reason_en === scopeText.reason_en, 'redirect reason_en');
    assert(redirected.reason_ko === scopeText.reason_ko, 'redirect reason_ko');
    assert(redirected.verdict === 'block', 'redirect blocked');
    assert(redirected.sent === true, 'redirect was sent so the gate could refuse it');
    assert(redirected.blocks_in_a_row === 1, `redirect blocks ${redirected.blocks_in_a_row}`);
    assert(redirected.next_block_would_freeze === true, 'redirect next block warning flag');
    assert(redirected.freeze_warning_en === FREEZE_WARNING_EN, 'redirect freeze warning');
    assert(redirected.freeze_warning_ko === FREEZE_WARNING_KO, 'redirect freeze warning ko');
    log(`ok 2 redirect ${redirected.reason_code}`);

    const nonceOver = await agentNonce();
    const over = await pay({ entry_id: ids[2], amount: '0.5', source: 'owner_chat' });
    assert(over.reason_code === 'over_max_not_sent', `over max ${over.reason_code}`);
    assert(over.sent === false, 'over max sent');
    assert(over.tx_hash === null, 'over max tx');
    assert(over.reason_en === describeReason('over_max_not_sent').reason_en, 'over max en');
    assert(over.reason_ko === describeReason('over_max_not_sent').reason_ko, 'over max ko');
    assert(await agentNonce() === nonceOver, 'over max changed the nonce');
    log('ok 3 over_max_not_sent');

    const heldBefore = await viewAccountAmount('sandbox', payee.id);
    const held = await payOnSandbox({ entry_id: ids[3], amount: '2', source: 'owner_chat' });
    assert(held.reason_code === 'tier2_escalate', `hold ${held.reason_code}`);
    assert(held.held === true, 'held flag');
    assert(held.pending_id !== undefined && held.pending_id !== null, 'pending id');
    const heldAfter = await viewAccountAmount('sandbox', payee.id);
    assert(heldAfter === heldBefore, 'held payment did not pay the payee yet');
    log(`ok 4 held pending ${held.pending_id}`);

    assert(held.reason_en === describeReason('tier2_escalate').reason_en, 'hold reason_en');
    assert(held.reason_ko === describeReason('tier2_escalate').reason_ko, 'hold reason_ko');
    assert(held.blocks_in_a_row === 0, `hold resets blocks ${held.blocks_in_a_row}`);
    assert(held.mandate_frozen === false, 'hold did not freeze');
    const approveRun = await runScript([
      path.join(ROOT, 'scripts/approve-pending.mjs'),
      '--gate', gate.id,
      '--id', String(held.pending_id),
      '--approve',
    ]);
    assertNoSecrets(approveRun.stdout, approveRun.stderr);
    if (approveRun.code !== 0) fail(`approve-pending exit ${approveRun.code}: ${scrub(approveRun.stderr)}`);
    const approved = JSON.parse(approveRun.stdout);
    assert(approved.tx_hash, 'approve tx');
    const names = (approved.events || []).map((event) => event.event);
    assert(names.includes('pending_approved'), `approve events ${names.join(',')}`);
    let settled = heldAfter;
    for (let i = 0; i < 20; i++) {
      settled = await viewAccountAmount('sandbox', payee.id);
      if (settled - heldAfter === 2n * NEAR) break;
      await sleep(300);
    }
    assert(settled - heldAfter === 2n * NEAR, `approve payee delta ${settled - heldAfter}`);
    assert(names.includes('payout'), `missing payout event ${names.join(',')}`);
    assert(names.includes('payout_settled'), `missing payout_settled event ${names.join(',')}`);
    log(`ok 5 approve ${approved.tx_hash} events ${names.join(',')}`);

    const nonceBefore = await agentNonce();
    const dup = await pay({ entry_id: ids[0], amount: '0.1', source: 'owner_chat' });
    const nonceAfter = await agentNonce();
    assert(dup.reason_code === 'duplicate_attempt_not_sent', `duplicate ${dup.reason_code}`);
    assert(dup.sent === false, 'duplicate sent');
    assert(dup.tx_hash === null, 'duplicate tx');
    assert(dup.reason_en === describeReason('duplicate_attempt_not_sent').reason_en, 'duplicate en');
    assert(nonceBefore === nonceAfter, 'duplicate changed the agent nonce');
    log('ok 6 duplicate_attempt_not_sent');

    const report = await status();
    assert(report.source === 'local-only', `status source ${report.source}`);
    assert(report.index_error, 'status did not say the tx index was unreadable');
    const byId = new Map(report.entries.map((entry) => [entry.entry_id, entry]));
    assert(byId.get(ids[0]).state === 'used', `entry0 ${byId.get(ids[0]).state}`);
    assert(byId.get(ids[1]).state === 'unused', `entry1 ${byId.get(ids[1]).state}`);
    assert(byId.get(ids[2]).state === 'unused', `entry2 ${byId.get(ids[2]).state}`);
    assert(byId.get(ids[3]).state === 'used', `entry3 ${byId.get(ids[3]).state}`);
    assert(byId.get(ids[4]).state === 'unused', `entry4 ${byId.get(ids[4]).state}`);
    assert(byId.get(ids[5]).state === 'unused', `entry5 ${byId.get(ids[5]).state}`);
    assert(byId.get(ids[0]).reason_code === 'allowed', `entry0 reason ${byId.get(ids[0]).reason_code}`);
    assert(byId.get(ids[0]).reason_en === allowedText.reason_en, 'entry0 reason_en');
    assert(byId.get(ids[0]).reason_ko === allowedText.reason_ko, 'entry0 reason_ko');
    const summary = report.mandates.find((item) => item.serial === '1');
    assert(summary, 'serial 1 summary');
    assert(summary.freeze_known_from === 'local-ledger', `freeze source ${summary.freeze_known_from}`);
    assert(summary.expired === false, 'serial 1 expired');
    assert(summary.frozen === false, `lower bound frozen ${summary.frozen}`);
    assert(summary.blocks_in_a_row === 0, `lower bound blocks ${summary.blocks_in_a_row}`);
    assert(summary.last_block_fingerprint === null, 'lower bound last fingerprint');
    assert(summary.freeze_warning_en === FREEZE_LOCAL_BOUND_EN, `status freeze warning ${summary.freeze_warning_en}`);
    assert(summary.freeze_warning_ko === FREEZE_LOCAL_BOUND_KO, 'status freeze warning ko');
    assert(byId.get(ids[0]).evidence.freeze_known_from === 'local-ledger', 'entry freeze source');
    assert(report.ledger_corrupt === false, 'ledger_corrupt flag');
    assert(Array.isArray(report.unresolved_sends), 'unresolved_sends');
    assert(report.unresolved_sends.length === 0, `unresolved ${report.unresolved_sends.length}`);
    assert(BigInt(summary.remaining_budget) === budget - (NEAR / 10n) - (2n * NEAR), `remaining ${summary.remaining_budget}`);
    log('ok 7 status local-only used/unused');
    log(JSON.stringify({
      source: report.source,
      index_error: report.index_error,
      frozen: summary.frozen,
      blocks_in_a_row: summary.blocks_in_a_row,
      next_block_would_freeze: summary.next_block_would_freeze,
      remaining_budget: summary.remaining_budget,
      unresolved_sends: report.unresolved_sends.length,
      entries: report.entries.map((entry) => ({ entry_id: entry.entry_id, state: entry.state, reason: entry.reason_code })),
    }, null, 2));

    const rejectHold = await payOnSandbox({ entry_id: ids[4], amount: '2', source: 'owner_chat' });
    assert(rejectHold.reason_code === 'tier2_escalate', `reject hold ${rejectHold.reason_code} ${rejectHold.message || ''}`);
    assert(rejectHold.pending_id !== undefined && rejectHold.pending_id !== null, 'reject pending id');
    const payeeAtReject = await viewAccountAmount('sandbox', payee.id);
    const rejectRun = await runScript([
      path.join(ROOT, 'scripts/approve-pending.mjs'),
      '--gate', gate.id,
      '--id', String(rejectHold.pending_id),
      '--reject',
    ]);
    assertNoSecrets(rejectRun.stdout, rejectRun.stderr);
    if (rejectRun.code !== 0) fail(`reject exit ${rejectRun.code}: ${scrub(rejectRun.stderr)}`);
    const rejected = JSON.parse(rejectRun.stdout);
    const rejectNames = (rejected.events || []).map((event) => event.event);
    assert(rejectNames.includes('pending_rejected'), `reject events ${rejectNames.join(',')}`);
    assert(await viewAccountAmount('sandbox', payee.id) === payeeAtReject, 'reject paid the payee');
    log(`ok 8 reject pending ${rejectHold.pending_id}`);

    const absentRun = await runScript([
      path.join(ROOT, 'scripts/approve-pending.mjs'),
      '--gate', gate.id,
      '--id', '99999',
      '--approve',
    ]);
    assertNoSecrets(absentRun.stdout, absentRun.stderr);
    assert(absentRun.code !== 0, 'absent id exited 0');
    assert(absentRun.stderr.includes('absent'), `absent stderr ${scrub(absentRun.stderr)}`);
    log('ok 9 absent pending id');

    const shortSign = {
      config_nonce: 2n,
      amount_threshold: threshold.toString(),
      pending_ttl_ns: 1n,
      ...tier2Lists,
    };
    const shortChain = {
      config_nonce: 2,
      amount_threshold: threshold.toString(),
      pending_ttl_ns: 1,
      ...tier2Lists,
    };
    const shortSig = signOwnerPayload(seed, chainId, deploymentId, ownerPk, tier2ConfigBytes(gate.id, shortSign));
    // approve-pending already spent this key, so the earlier Account nonce cache is stale.
    await send(new Account(owner.id, provider, owner.secret), gate.id, 'set_tier2_config', {
      config: shortChain,
      signature: shortSig.signature,
    });
    const expireHold = await payOnSandbox({ entry_id: ids[5], amount: '2', source: 'owner_chat' });
    assert(expireHold.reason_code === 'tier2_escalate', `expire hold ${expireHold.reason_code} ${expireHold.message || ''}`);
    const stamp = await blockTimestampNs('sandbox');
    const timeLimit = Date.now() + 25_000;
    let advanced = stamp;
    while (advanced <= stamp && Date.now() < timeLimit) {
      await sleep(400);
      try {
        await new Account(owner.id, provider, owner.secret).signAndSendTransaction({
          receiverId: payee.id,
          actions: [actions.transfer(1n)],
          waitUntil: 'FINAL',
          throwOnFailure: false,
        });
      } catch { /* the next block is enough */ }
      try { advanced = await blockTimestampNs('sandbox'); } catch { /* read again */ }
    }
    assert(advanced > stamp, 'sandbox block time did not advance');
    const expireRun = await runScript([
      path.join(ROOT, 'scripts/approve-pending.mjs'),
      '--gate', gate.id,
      '--id', String(expireHold.pending_id),
      '--approve',
    ]);
    assertNoSecrets(expireRun.stdout, expireRun.stderr);
    assert(expireRun.code !== 0, 'expired item exited 0');
    assert(expireRun.stderr.includes('deadline'), `expire stderr ${scrub(expireRun.stderr)}`);
    log(`ok 10 expired pending ${expireHold.pending_id}`);

    const freezeInstruction = 'pay the freeze invoice';
    const freezeHash = await sha256hex(freezeInstruction);
    const freezeBudget = NEAR;
    const freezeMandate = {
      serial: 2n,
      agent: agent.id,
      entries: [{
        action: 'transfer',
        target: payee.id,
        max_amount: freezeBudget.toString(),
        instruction_hash: freezeHash,
      }],
      budget: freezeBudget.toString(),
      expires_at: expiresAt,
      parent_serial: null,
    };
    const freezeSig = signOwnerPayload(seed, chainId, deploymentId, ownerPk, signingBytes(gate.id, freezeMandate));
    const registeredFreeze = await send(new Account(owner.id, provider, owner.secret), gate.id, 'register', {
      mandate: {
        serial: 2,
        agent: agent.id,
        entries: freezeMandate.entries,
        budget: freezeBudget.toString(),
        expires_at: Number(expiresAt),
        parent_serial: null,
      },
      signer_public_key: ownerPk,
      signature: freezeSig.signature,
    });
    assert(registeredFreeze.decision?.reason_code === 'allowed', `freeze register ${registeredFreeze.decision?.reason_code}`);
    writeExtra('freeze.json', {
      network: 'sandbox',
      gate: gate.id,
      agent: agent.id,
      serial: 2,
      budget: freezeBudget.toString(),
      expires_at: expiresAt.toString(),
      entries: [{
        action: 'transfer',
        target: payee.id,
        max_amount: freezeBudget.toString(),
        instruction: freezeInstruction,
        instruction_hash: freezeHash,
      }],
    });
    const freezeId = `${gate.id}#2:0`;
    const blockTargets = [attacker.id, owner.id, other.id];
    const firstBlock = await payOnSandbox({
      entry_id: freezeId,
      amount: '0.1',
      target: blockTargets[0],
      source: 'owner_chat',
    });
    assert(firstBlock.reason_code === 'out_of_scope', `freeze block1 ${firstBlock.reason_code} ${firstBlock.message || ''}`);
    assert(firstBlock.sent === true, 'freeze block1 sent');
    assert(firstBlock.blocks_in_a_row === 1, `freeze block1 count ${firstBlock.blocks_in_a_row}`);
    assert(firstBlock.freeze_warning_en === FREEZE_WARNING_EN, 'freeze block1 warning');
    const secondBlock = await payOnSandbox({
      entry_id: freezeId,
      amount: '0.1',
      target: blockTargets[1],
      source: 'owner_chat',
    });
    assert(secondBlock.reason_code === 'out_of_scope', `freeze block2 ${secondBlock.reason_code} ${secondBlock.message || ''}`);
    assert(secondBlock.sent === true, 'freeze block2 sent');
    assert(secondBlock.blocks_in_a_row === 2, `freeze block2 count ${secondBlock.blocks_in_a_row}`);
    assert(secondBlock.next_block_would_freeze === true, 'freeze block2 next flag');
    const nonceRisk = await agentNonce();
    const risk = await pay({
      entry_id: freezeId,
      amount: '0.1',
      target: blockTargets[2],
      source: 'owner_chat',
    });
    assert(risk.reason_code === 'freeze_risk_not_sent', `freeze risk ${risk.reason_code} ${risk.message || ''}`);
    assert(risk.sent === false, 'freeze risk sent');
    assert(risk.tx_hash === null, 'freeze risk tx');
    assert(risk.freeze_warning_en === FREEZE_LOCAL_BOUND_EN, 'freeze risk warning');
    assert(risk.reason_en === FREEZE_RISK_UNKNOWN_EN, `freeze risk en ${risk.reason_en}`);
    assert(risk.reason_ko === FREEZE_RISK_UNKNOWN_KO, 'freeze risk ko');
    assert(risk.freeze_known_from === 'local-ledger', 'freeze risk source');
    assert(await agentNonce() === nonceRisk, 'freeze risk changed the nonce');
    const frozenTx = await pay({
      entry_id: freezeId,
      amount: '0.1',
      target: blockTargets[2],
      source: 'owner_chat',
      confirm_freeze_risk: true,
    });
    assert(frozenTx.reason_code === 'auto_frozen', `auto_frozen ${frozenTx.reason_code} ${frozenTx.message || ''}`);
    assert(frozenTx.sent === true, 'auto_frozen sent');
    assert(frozenTx.mandate_frozen === true, 'auto_frozen flag');
    assert(frozenTx.reason_en === describeReason('auto_frozen').reason_en, 'auto_frozen en');
    assert(frozenTx.reason_ko === describeReason('auto_frozen').reason_ko, 'auto_frozen ko');
    const nonceFrozen = await agentNonce();
    const stopped = await pay({ entry_id: freezeId, amount: '0.1', source: 'owner_chat' });
    assert(stopped.reason_code === 'frozen_not_sent', `frozen_not_sent ${stopped.reason_code} ${stopped.message || ''}`);
    assert(stopped.sent === false, 'frozen_not_sent sent');
    assert(stopped.tx_hash === null, 'frozen_not_sent tx');
    assert(stopped.reason_en === describeReason('frozen_not_sent').reason_en, 'frozen_not_sent en');
    assert(await agentNonce() === nonceFrozen, 'frozen_not_sent changed the nonce');
    log('ok 11 freeze_risk_not_sent then auto_frozen then frozen_not_sent');

    let captured = null;
    setProviderHookForTests((provider) => {
      const original = provider.sendTransactionUntil.bind(provider);
      provider.sendTransactionUntil = async (signed, waitUntil) => {
        captured = signed;
        await original(signed, waitUntil);
        throw new Error('injected failure after broadcast');
      };
      return provider;
    });
    try {
      const nonceUnknown = await agentNonce();
      const blockedUnknown = await pay({ entry_id: ids[2], amount: '0.1', source: 'owner_chat' });
      assert(blockedUnknown.reason_code === 'freeze_risk_not_sent', `unknown prelude ${blockedUnknown.reason_code}`);
      assert(blockedUnknown.sent === false && blockedUnknown.tx_hash === null, 'unknown prelude sent');
      assert(await agentNonce() === nonceUnknown, 'unknown prelude changed the nonce');
      const unknown = await pay({
        entry_id: ids[2],
        amount: '0.1',
        source: 'owner_chat',
        confirm_freeze_risk: true,
      });
      assert(unknown.sent === 'unknown', `sent ${unknown.sent}`);
      assert(unknown.reason_code === 'rpc_uncertain', `unknown reason ${unknown.reason_code}`);
      assert(unknown.tx_hash, 'unknown hash');
      assert(!String(unknown.message).includes('before a payment'), 'unknown message claims nothing was sent');
      assert(!String(unknown.reason_en).includes('before a payment'), 'unknown reason claims a pre-payment failure');
      assert(captured?.transaction, 'send wrapper did not see the signed transaction');
      const body = encodeTransaction(captured.transaction);
      const expectHash = baseEncode(await sha256(body));
      const signedBytes = encodeTransaction(captured);
      assert(Buffer.compare(Buffer.from(body), Buffer.from(signedBytes)) !== 0, 'transaction encoding included the signature');
      assert(unknown.tx_hash === expectHash, `knownHash ${unknown.tx_hash} computed ${expectHash}`);
      const seen = await provider.viewTransactionStatus({
        txHash: unknown.tx_hash,
        accountId: agent.id,
        waitUntil: 'FINAL',
      });
      assert(seen.transaction.hash === unknown.tx_hash, `landed hash ${seen.transaction?.hash}`);
      assert(Number(await agentNonce()) === Number(nonceUnknown) + 1, 'unknown send did not land');
      log(`ok 13 sent unknown knownHash ${unknown.tx_hash}`);
    } finally {
      setProviderHookForTests(null);
    }

    const ledgerText = fs.readFileSync(process.env.CHOPGATE_LEDGER, 'utf8');
    for (const secret of [agent.secret, originalAgent.secret, faKey.toString(), wrongKey.toString(), owner.secret, other.secret, seed.toString('hex')]) {
      assert(!ledgerText.includes(secret), 'ledger contains a secret');
    }
    assert(!ledgerText.includes('private_key'), 'ledger contains private_key');
    assert(!/ed25519:[1-9A-HJ-NP-Za-km-z]{60,}/.test(ledgerText), 'ledger contains a key');
    assert(!ledgerText.includes(nasty), 'ledger contains the rejected source');
    log('ok 12 ledger has no secret');
  } finally {
    stopSandbox(child);
    await sleep(300);
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ }
    fs.closeSync(logFd);
    fs.rmSync(TMP, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
