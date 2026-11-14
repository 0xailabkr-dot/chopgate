#!/usr/bin/env node
// Stdio MCP server. Logs go to stderr only. Never print keys or signatures.
// Tool handlers run one at a time so two pay calls cannot pass the local checks together.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { pay, redact, status } from './chopgate-agent.mjs';
import { describeReason } from './reasons.mjs';

function textResult(value, isError = false) {
  return {
    isError,
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  };
}

function errorBody(error) {
  const code = typeof error?.code === 'string' && error.code ? error.code : 'internal_error';
  const described = describeReason(code);
  return {
    error: redact(error?.message || error),
    reason_code: described.reason_code,
    reason_en: error?.reason_en || described.reason_en,
    reason_ko: error?.reason_ko || described.reason_ko,
  };
}

let turn = Promise.resolve();
function exclusive(fn) {
  const run = turn.then(() => fn(), () => fn());
  turn = run.then(() => {}, () => {});
  return run;
}

const server = new McpServer({ name: 'chopgate', version: '0.1.0' });

const STATUS_DESCRIPTION = [
  'List this agent\'s ChopGate mandate entries and the reconstructed state of each one.',
  'States are unused, used, frozen, expired, or unknown. Entries are one-use.',
  'The gate refuses any payment outside the owner\'s signed mandate; this tool does not widen it.',
  'Do not retry a payment that was blocked, held, or already sent. Check this status instead.',
  'A held payment (reason tier2_escalate) stays pending until the owner approves it.',
  'Each row includes reason_code, reason_en, and reason_ko.',
  'next_block_would_freeze is true when two refusals are already counted, or a blocked fingerprint is stored (repeating it would freeze the mandate).',
  'If the tx index cannot be read, source is local-only and freeze_known_from is local-ledger: blocks, frozen, and the last fingerprint are a lower bound from this ledger, not chain history.',
  'An expired mandate (expires_at <= now) has expired true and unused entries in state expired.',
  'Before it reports or sends, the server checks RPC status and refuses a chain_id that is not the configured sandbox or testnet id.',
  'The agent key must be a function-call key for authorize_and_pay_tiered on the mandate gate, with allowance null. A full-access key is full_access_key_refused. Any other scope, including a finite allowance, is key_scope_mismatch. Nothing is sent. status and pay each read that key from the chain on every call. There is no cache.',
  'unresolved_sends lists intents and unknown broadcasts that are not explained yet.',
].join(' ');

const PAY_DESCRIPTION = [
  'Send exactly one authorize_and_pay_tiered transaction with the agent account\'s function-call key. A full-access key is refused locally and nothing is sent.',
  'Each mandate entry is one-use.',
  'The gate, not this tool, refuses a redirected target, an unsigned or swapped instruction, an amount over the entry max, an amount over the remaining budget, a wrong caller, or a frozen mandate.',
  'Passing a different target or instruction is allowed here only so the gate can refuse it. Do not use that to route a payment somewhere else.',
  'Never retry the same request. A second call with the same action, target, amount, instruction, and caller is refused locally as duplicate_attempt_not_sent and no transaction is sent.',
  'This server does not retry and it does not resend. sent is false when nothing was broadcast. sent is "unknown" only after broadcast has started.',
  'pay requires confirm_freeze_risk unless freeze_known_from is chain. Without it the call is freeze_risk_not_sent and nothing is sent. The English and Korean text says whether the freeze state is unknown or the next refusal would freeze the mandate.',
  'When chain history shows two blocks already, any call whose allow is not provable also requires confirm_freeze_risk.',
  'A held payment waits for the owner to sign approve_pending. Do not send it again.',
  'source should be owner_chat for an instruction the owner wrote. Any other non-empty source is untrusted and the gate can hold even a small payment.',
  'amount is a NEAR decimal string. "5" means 5 NEAR, not 5 yocto. Use a yocto suffix for yoctoNEAR.',
].join(' ');

server.registerTool('chopgate_status', {
  description: STATUS_DESCRIPTION,
  inputSchema: {
    gate: z.string().optional().describe('Gate account id. Omit to report every mandate file.'),
  },
}, async (args) => exclusive(async () => {
  try {
    const report = await status({ gate: args?.gate });
    console.error('[chopgate-mcp] chopgate_status ok');
    return textResult(report);
  } catch (error) {
    console.error(`[chopgate-mcp] chopgate_status error ${redact(error.message || error)}`);
    return textResult(errorBody(error), true);
  }
}));

server.registerTool('chopgate_pay', {
  description: PAY_DESCRIPTION,
  inputSchema: {
    entry_id: z.string().describe('entry_id from chopgate_status, <gate>#<serial>:<index>'),
    amount: z.string().describe('NEAR decimal. "5" means 5 NEAR. "5 yocto" means 5 yoctoNEAR. Zero is refused.'),
    target: z.string().optional().describe('Defaults to the entry target. The gate rejects a different account.'),
    instruction: z.string().optional().describe('Defaults to the entry instruction. The gate rejects a different one.'),
    source: z.string().describe('Use "owner_chat" for an owner instruction. Other non-empty values are untrusted. Max 200 printable characters.'),
    confirm_freeze_risk: z.boolean().optional().describe('Set true only when you accept that this call may be the refusal that freezes the mandate for good, or that the freeze state is unknown. Omit it to refuse those sends locally. This is not a retry.'),
  },
}, async (args) => exclusive(async () => {
  try {
    const result = await pay({
      entry_id: args.entry_id,
      amount: args.amount,
      target: args.target,
      instruction: args.instruction,
      source: args.source,
      confirm_freeze_risk: args.confirm_freeze_risk,
    });
    console.error(`[chopgate-mcp] chopgate_pay ${result.reason_code || result.sent}`);
    // isError only when the broadcast started and the outcome is unknown.
    // A local refusal has sent:false and is a normal result.
    return textResult(result, result.sent === 'unknown');
  } catch (error) {
    console.error(`[chopgate-mcp] chopgate_pay error ${redact(error.message || error)}`);
    return textResult(errorBody(error), true);
  }
}));

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[chopgate-mcp] stdio ready');
