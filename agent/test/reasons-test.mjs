// Every reason code has English and Korean text. Contract strings are checked
// against jev-b/work/src/lib.rs and tier2.rs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REASONS, TIER2_LOCK_REASONS, describeReason } from '../src/reasons.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = process.env.CHOPGATE_CONTRACT_LIB || path.join(HERE, '../../src/lib.rs');
const TIER2 = process.env.CHOPGATE_CONTRACT_TIER2 || path.join(HERE, '../../src/tier2.rs');

const REQUIRED = [
  'allowed',
  'tier2_escalate',
  'tier2_deny',
  'unknown_mandate',
  'unsigned_instruction',
  'owner_impersonation',
  'invalid_signature',
  'wrong_caller',
  'entry_limit_exceeded',
  'budget_exceeded',
  'auto_frozen',
  'nonce_reuse',
  'instruction_reused',
  'expired',
  'missing_signature',
  'invalid_recipient',
  'missing_parent',
  'child_wider',
  'pending_limit',
  'policy_rule_denied',
  'lookalike_account',
  'out_of_scope',
  'instruction_binding_mismatch',
  'zero_amount',
  'pending_created',
  'pending_approved',
  'pending_rejected',
  'pending_expired',
];

const EXACT = {
  allowed: ['Paid. It matches a stamped job.', '지급했습니다. 도장 찍힌 일과 같습니다.'],
  tier2_escalate: ['Held. Over the review amount.', '보류했습니다. 금액이 검토 금액을 넘었습니다.'],
  unknown_mandate: ['No such mandate.', '그런 지시서가 없습니다.'],
  unsigned_instruction: ['Not a stamped instruction.', '도장 찍힌 지시문이 아닙니다.'],
  owner_impersonation: ['Someone posed as the owner.', '누군가 주인을 사칭했습니다.'],
  invalid_signature: ["The stamp doesn't check out.", '도장 서명이 맞지 않습니다.'],
  wrong_caller: ['This mandate is for another agent.', '다른 에이전트의 지시서입니다.'],
  entry_limit_exceeded: ["Over this job's limit.", '이 일의 건당 한도를 넘었습니다.'],
  budget_exceeded: ['Over the total budget.', '지시서의 총 예산을 넘었습니다.'],
  auto_frozen: ['The mandate is frozen for good.', '지시서가 영구 동결됐습니다.'],
  instruction_reused: ['This request was already used.', '이미 쓰인 요청입니다.'],
  nonce_reuse: ['This mandate number is already registered.', '이 지시서 번호는 이미 등록됐습니다.'],
  expired: ['Expired. Nothing was paid.', '기한이 지났습니다. 지급하지 않았습니다.'],
};

// Quoted snake_case words in lib.rs that are JSON keys, event names, or method
// names. They are not Gate decision reason_code values.
const NOT_DECISION_CODES = new Set([
  'action', 'allow', 'amount', 'approved', 'block', 'category_q_permille', 'change',
  'chopgate', 'data', 'deadline', 'decision', 'decision_time', 'deny', 'depositor',
  'effect', 'escrow_balance', 'escrow_deposit', 'escrow_withdraw', 'event', 'hidden',
  'id', 'invoice', 'key_generation', 'lock', 'mode', 'new_version', 'nonce', 'none',
  'old_version', 'on_payout', 'other', 'owner_chat', 'owner_signed', 'payout',
  'payout_refunded', 'payout_settled', 'payout_unavailable', 'pending_report_invalidated',
  'policy_update', 'policy_update_rejected', 'policy_version', 'proposal_id',
  'reason_code', 'reasons', 'recipient', 'register', 'report_authenticated', 'revoked',
  'rule', 'rule_proposal', 'serial', 'source', 'source_q_permille', 'spend_rules_updated',
  'standard', 'target', 'threshold', 'tier', 'tier2_decision', 'transfer', 'verdict',
  'version', 'wasm32', 'withdraw_refunded', 'withdraw_settled',
]);

const KINDS = new Set(['paid', 'held', 'refused', 'not_sent', 'unknown']);

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

for (const [code, row] of Object.entries(REASONS)) {
  assert(typeof row.en === 'string' && row.en.trim().length > 0, `${code} en`);
  assert(typeof row.ko === 'string' && row.ko.trim().length > 0, `${code} ko`);
  assert(KINDS.has(row.verdict_kind), `${code} verdict_kind ${row.verdict_kind}`);
}

for (const code of REQUIRED) {
  assert(REASONS[code], `missing required code ${code}`);
}

for (const [code, [en, ko]] of Object.entries(EXACT)) {
  assert(REASONS[code].en === en, `${code} en text`);
  assert(REASONS[code].ko === ko, `${code} ko text`);
}

if (!fs.existsSync(LIB) || !fs.existsSync(TIER2)) {
  console.log(`skip contract reason cross-check: missing ${LIB} or ${TIER2}. Set CHOPGATE_CONTRACT_LIB and CHOPGATE_CONTRACT_TIER2.`);
  console.log(`ok reasons ${Object.keys(REASONS).length} codes`);
  process.exit(0);
}

const unknown = describeReason('not_a_real_code_zz');
assert(unknown.reason_code === 'not_a_real_code_zz', 'fallback code');
assert(unknown.verdict_kind === 'unknown', 'fallback kind');
assert(unknown.reason_en.includes('not_a_real_code_zz'), 'fallback en');
assert(unknown.reason_ko.includes('not_a_real_code_zz'), 'fallback ko');
assert(describeReason('allowed').reason_en === EXACT.allowed[0], 'describe allowed');

const lib = fs.readFileSync(LIB, 'utf8');
const literals = new Set();
for (const match of lib.matchAll(/"([a-z][a-z0-9_]*)"/g)) literals.add(match[1]);
const found = [...literals].filter((code) => !NOT_DECISION_CODES.has(code)).sort();
const missingFromTable = found.filter((code) => !REASONS[code]);
assert(missingFromTable.length === 0, `contract codes missing from REASONS: ${missingFromTable.join(', ')}`);
const extras = found.filter((code) => !REQUIRED.includes(code)).sort();
for (const code of REQUIRED) {
  if (found.includes(code)) continue;
  // Local codes are not in the contract. Every contract code in REQUIRED must be found.
  if (code.endsWith('_not_sent') || ['bad_source', 'key_refused', 'internal_error', 'amount_refused', 'ledger_corrupt', 'ledger_locked', 'rpc_preflight', 'rpc_uncertain', 'execution_failure', 'network_not_enabled'].includes(code)) {
    continue;
  }
  throw new Error(`required contract code not found in lib.rs: ${code}`);
}

const tier2 = fs.readFileSync(TIER2, 'utf8');
const locks = new Set();
for (const match of tier2.matchAll(/"((?:2[ab]_|jev_)[a-z0-9_]+)"/g)) locks.add(match[1]);
const lockList = [...locks].sort();
const tableLocks = [...TIER2_LOCK_REASONS].sort();
assert(lockList.join(',') === tableLocks.join(','), `tier2 lock strings ${lockList.join(',')} vs ${tableLocks.join(',')}`);

console.log(`ok reasons ${Object.keys(REASONS).length} codes`);
console.log(`extra contract decision codes: ${extras.join(', ')}`);
console.log(`tier2 lock strings (not decision codes): ${lockList.join(', ')}`);
