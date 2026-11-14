// Reason texts for contract decisions, pending events, and local refusals.
// Contract reason_code values are the strings Gate::emit stores. The chain's
// own `reason` field is only the code with underscores turned into spaces.

export const FREEZE_WARNING_EN = 'Do not resend. 3 refusals in a row, or the same attempt twice, freeze this mandate for good.';
export const FREEZE_WARNING_KO = '다시 보내지 마세요. 3연속 거절이나 같은 시도 2회면 영구 동결됩니다.';
export const FREEZE_UNKNOWN_EN = 'Freeze state is unknown. Do not send.';
export const FREEZE_UNKNOWN_KO = '동결 상태를 모릅니다. 보내지 마세요.';
// Local ledger counters are a lower bound. The chain may already be closer to a freeze.
export const FREEZE_LOCAL_BOUND_EN = 'These freeze fields are a lower bound from the local ledger, not chain history. The chain may already be closer to a freeze. Do not send unless you accept that.';
export const FREEZE_LOCAL_BOUND_KO = '이 동결 값은 체인 기록이 아니라 로컬 장부의 하한입니다. 체인은 이미 동결에 더 가까울 수 있습니다. 그 위험을 받아들이기 전에는 보내지 마세요.';
// freeze_risk_not_sent uses one of these, so the result says which case it is.
export const FREEZE_RISK_UNKNOWN_EN = 'Freeze state is not known from chain history. Nothing was sent.';
export const FREEZE_RISK_UNKNOWN_KO = '동결 상태를 체인 기록으로 확인하지 못했습니다. 보내지 않았습니다.';
export const FREEZE_RISK_NEXT_EN = 'The next refusal would freeze this mandate for good. Nothing was sent.';
export const FREEZE_RISK_NEXT_KO = '다음 거절이 이 지시서를 영구 동결합니다. 보내지 않았습니다.';
export const STATE_UNVERIFIED_NOTE = 'state unverified';
export const POST_DECISION_UNKNOWN_EN = 'The transaction was sent but no decision was read. State is unverified. Do not resend.';
export const POST_DECISION_UNKNOWN_KO = '거래는 보냈지만 결정을 읽지 못했습니다. 상태는 확인되지 않았습니다. 다시 보내지 마세요.';

// verdict_kind is paid, held, refused, not_sent, or unknown.
export const REASONS = {
  allowed: {
    verdict_kind: 'paid',
    en: 'Paid. It matches a stamped job.',
    ko: '지급했습니다. 도장 찍힌 일과 같습니다.',
  },
  tier2_escalate: {
    verdict_kind: 'held',
    en: 'Held. Over the review amount.',
    ko: '보류했습니다. 금액이 검토 금액을 넘었습니다.',
  },
  tier2_deny: {
    verdict_kind: 'refused',
    en: 'Refused by the second check. Nothing was paid.',
    ko: '두 번째 검사가 거절했습니다. 지급하지 않았습니다.',
  },
  unknown_mandate: {
    verdict_kind: 'refused',
    en: 'No such mandate.',
    ko: '그런 지시서가 없습니다.',
  },
  unsigned_instruction: {
    verdict_kind: 'refused',
    en: 'Not a stamped instruction.',
    ko: '도장 찍힌 지시문이 아닙니다.',
  },
  owner_impersonation: {
    verdict_kind: 'refused',
    en: 'Someone posed as the owner.',
    ko: '누군가 주인을 사칭했습니다.',
  },
  invalid_signature: {
    verdict_kind: 'refused',
    en: "The stamp doesn't check out.",
    ko: '도장 서명이 맞지 않습니다.',
  },
  wrong_caller: {
    verdict_kind: 'refused',
    en: 'This mandate is for another agent.',
    ko: '다른 에이전트의 지시서입니다.',
  },
  entry_limit_exceeded: {
    verdict_kind: 'refused',
    en: "Over this job's limit.",
    ko: '이 일의 건당 한도를 넘었습니다.',
  },
  budget_exceeded: {
    verdict_kind: 'refused',
    en: 'Over the total budget.',
    ko: '지시서의 총 예산을 넘었습니다.',
  },
  auto_frozen: {
    verdict_kind: 'refused',
    en: 'The mandate is frozen for good.',
    ko: '지시서가 영구 동결됐습니다.',
  },
  nonce_reuse: {
    verdict_kind: 'refused',
    en: 'This mandate number is already registered.',
    ko: '이 지시서 번호는 이미 등록됐습니다.',
  },
  instruction_reused: {
    verdict_kind: 'refused',
    en: 'This request was already used.',
    ko: '이미 쓰인 요청입니다.',
  },
  expired: {
    verdict_kind: 'refused',
    en: 'Expired. Nothing was paid.',
    ko: '기한이 지났습니다. 지급하지 않았습니다.',
  },
  missing_signature: {
    verdict_kind: 'refused',
    en: 'The owner stamp is missing.',
    ko: '주인 도장이 없습니다.',
  },
  invalid_recipient: {
    verdict_kind: 'refused',
    en: 'That recipient account is not valid.',
    ko: '받는 계정이 올바르지 않습니다.',
  },
  missing_parent: {
    verdict_kind: 'refused',
    en: 'The parent mandate is missing.',
    ko: '상위 지시서가 없습니다.',
  },
  child_wider: {
    verdict_kind: 'refused',
    en: 'The child mandate is wider than the parent.',
    ko: '하위 지시서가 상위보다 넓습니다.',
  },
  pending_limit: {
    verdict_kind: 'refused',
    en: 'Too many payments are already waiting.',
    ko: '대기 중인 지급이 너무 많습니다.',
  },
  policy_rule_denied: {
    verdict_kind: 'refused',
    en: 'A policy rule denies this.',
    ko: '정책 규칙이 이 지급을 막습니다.',
  },
  lookalike_account: {
    verdict_kind: 'refused',
    en: 'That account looks like the real payee.',
    ko: '그 계정이 진짜 수취인과 비슷합니다.',
  },
  out_of_scope: {
    verdict_kind: 'refused',
    en: 'That account is outside this job.',
    ko: '그 계정은 이 일의 범위 밖입니다.',
  },
  instruction_binding_mismatch: {
    verdict_kind: 'refused',
    en: 'The instruction does not match this target.',
    ko: '지시문이 이 대상과 맞지 않습니다.',
  },
  zero_amount: {
    verdict_kind: 'refused',
    en: 'The amount is zero. Nothing was paid.',
    ko: '금액이 0입니다. 지급하지 않았습니다.',
  },
  pending_created: {
    verdict_kind: 'held',
    en: 'Held. Waiting for the owner.',
    ko: '보류했습니다. 주인을 기다립니다.',
  },
  pending_approved: {
    verdict_kind: 'paid',
    en: 'The owner approved the held payment.',
    ko: '주인이 보류 건을 승인했습니다.',
  },
  pending_rejected: {
    verdict_kind: 'refused',
    en: 'The owner rejected the held payment.',
    ko: '주인이 보류 건을 거절했습니다.',
  },
  pending_expired: {
    verdict_kind: 'refused',
    en: 'The held payment expired.',
    ko: '보류 건의 기한이 지났습니다.',
  },
  // Rule-proposal decisions. They are not payment results. Included so the table
  // matches every reason_code string in lib.rs.
  already_approved: {
    verdict_kind: 'refused',
    en: 'This rule was already approved.',
    ko: '이 규칙은 이미 승인됐습니다.',
  },
  unknown_proposal: {
    verdict_kind: 'refused',
    en: 'No such rule proposal.',
    ko: '그런 규칙 제안이 없습니다.',
  },
  rule_not_active: {
    verdict_kind: 'refused',
    en: 'That rule is not active.',
    ko: '그 규칙은 적용 중이 아닙니다.',
  },
  duplicate_attempt_not_sent: {
    verdict_kind: 'not_sent',
    en: 'This attempt was already recorded. Nothing was sent.',
    ko: '이미 기록된 시도입니다. 보내지 않았습니다.',
  },
  frozen_not_sent: {
    verdict_kind: 'not_sent',
    en: 'The mandate is frozen. Nothing was sent.',
    ko: '지시서가 동결되어 있습니다. 보내지 않았습니다.',
  },
  freeze_risk_not_sent: {
    verdict_kind: 'not_sent',
    en: 'The next refusal could freeze this mandate for good. Nothing was sent.',
    ko: '다음 거절이 이 지시서를 영구 동결할 수 있습니다. 보내지 않았습니다.',
  },
  network_not_enabled: {
    verdict_kind: 'not_sent',
    en: 'This network is not enabled. Nothing was sent.',
    ko: '이 네트워크는 쓸 수 없습니다. 보내지 않았습니다.',
  },
  chain_id_refused: {
    verdict_kind: 'not_sent',
    en: 'This RPC chain_id is not the configured network. Nothing was sent.',
    ko: '이 RPC의 chain_id가 설정된 네트워크가 아닙니다. 보내지 않았습니다.',
  },
  rpc_preflight: {
    verdict_kind: 'not_sent',
    en: 'Status could not be read before sending. Nothing was sent.',
    ko: '보내기 전에 상태를 읽지 못했습니다. 보내지 않았습니다.',
  },
  rpc_uncertain: {
    verdict_kind: 'unknown',
    en: 'The send result is unknown. Do not resend.',
    ko: '전송 결과를 모릅니다. 다시 보내지 마세요.',
  },
  execution_failure: {
    verdict_kind: 'unknown',
    en: 'The transaction was included and failed. Do not resend.',
    ko: '거래는 들어갔지만 실패했습니다. 다시 보내지 마세요.',
  },
  ledger_corrupt: {
    verdict_kind: 'not_sent',
    en: 'The ledger has a broken line. Nothing was sent.',
    ko: '장부에 깨진 줄이 있습니다. 보내지 않았습니다.',
  },
  ledger_locked: {
    verdict_kind: 'not_sent',
    en: 'The ledger lock is held. Nothing was sent.',
    ko: '장부 잠금이 걸려 있습니다. 보내지 않았습니다.',
  },
  amount_refused: {
    verdict_kind: 'not_sent',
    en: 'The amount is not a valid NEAR value. Nothing was sent.',
    ko: '금액이 올바른 NEAR 값이 아닙니다. 보내지 않았습니다.',
  },
  agent_mismatch_not_sent: {
    verdict_kind: 'not_sent',
    en: 'This key is not the mandate agent. Nothing was sent.',
    ko: '이 열쇠는 지시서의 에이전트가 아닙니다. 보내지 않았습니다.',
  },
  mandate_expired_not_sent: {
    verdict_kind: 'not_sent',
    en: "This mandate's deadline has passed. Nothing was sent.",
    ko: '이 지시서의 기한이 지났습니다. 보내지 않았습니다.',
  },
  over_max_not_sent: {
    verdict_kind: 'not_sent',
    en: "Over this job's limit. Nothing was sent.",
    ko: '이 일의 건당 한도를 넘었습니다. 보내지 않았습니다.',
  },
  over_budget_not_sent: {
    verdict_kind: 'not_sent',
    en: 'Over the remaining budget. Nothing was sent.',
    ko: '남은 예산을 넘었습니다. 보내지 않았습니다.',
  },
  entry_used_not_sent: {
    verdict_kind: 'not_sent',
    en: 'This job was already used. Nothing was sent.',
    ko: '이 일은 이미 쓰였습니다. 보내지 않았습니다.',
  },
  bad_source: {
    verdict_kind: 'not_sent',
    en: 'The source text is not allowed. Nothing was sent.',
    ko: '출처 문구를 쓸 수 없습니다. 보내지 않았습니다.',
  },
  key_refused: {
    verdict_kind: 'not_sent',
    en: 'The agent key file must be a mode 600 regular file.',
    ko: '에이전트 열쇠 파일은 모드 600인 일반 파일이어야 합니다.',
  },
  full_access_key_refused: {
    verdict_kind: 'not_sent',
    en: 'The agent key is a full-access key. Nothing was sent.',
    ko: '에이전트 열쇠가 전체 권한 열쇠입니다. 보내지 않았습니다.',
  },
  key_scope_mismatch: {
    verdict_kind: 'not_sent',
    en: 'The agent key must allow only authorize_and_pay_tiered on this gate. Nothing was sent.',
    ko: '에이전트 열쇠는 이 게이트의 authorize_and_pay_tiered만 허용해야 합니다. 보내지 않았습니다.',
  },
  internal_error: {
    verdict_kind: 'unknown',
    en: 'Something failed before a payment.',
    ko: '지급 전에 문제가 생겼습니다.',
  },
};

// Tier-2 lock strings from tier2.rs. They ride inside tier2_decision events.
// They are not Gate decision reason_code values.
export const TIER2_LOCK_REASONS = [
  '2a_hash_mismatch',
  '2a_external_content',
  '2a_unknown',
  '2a_low_confidence',
  '2b_low_confidence',
  'jev_missing',
  '2b_payee_not_allowed',
  '2b_per_tx_limit',
  '2b_per_day_limit',
  '2b_frequency',
  '2b_time_window',
  '2b_category_missing',
  '2b_category',
];

export function describeReason(code) {
  const key = code == null ? '' : String(code);
  const row = REASONS[key];
  if (row) {
    return {
      reason_code: key,
      verdict_kind: row.verdict_kind,
      reason_en: row.en,
      reason_ko: row.ko,
    };
  }
  const raw = key || 'unknown';
  return {
    reason_code: raw,
    verdict_kind: 'unknown',
    reason_en: `Unrecognized reason (${raw}).`,
    reason_ko: `알 수 없는 사유입니다 (${raw}).`,
  };
}
