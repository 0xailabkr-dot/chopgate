# Verdict receipts

All inner signing payloads specified below MUST be wrapped in `authorization_bytes(chain_id, deployment_id, owner_public_key, payload)`. The v3 outer domain binds chain, fresh deployment incarnation, owner and native NEAR asset. `new` now requires chain_id and deployment_id; the correct chain is a trusted deployer responsibility. Initialization appends block_timestamp to the deployment label; sign the stored id returned by signature_domain. Later-block account recreation changes the domain even with an identical label. See docs/DETAILS.md (Signing) for the full protocol. Existing state requires migration or fresh initialization.


Every log line starts with `EVENT_JSON:` followed by a NEP-297 JSON envelope.
The envelope has `standard` (string, `chopgate`), `version` (string, `1.0.0`),
`event` (string), and `data` (array containing one object). Event names are
`decision`, `rule_proposal`, `policy_update`, `policy_update_rejected`,
`escrow_deposit`, `payout`, `payout_settled`, `payout_refunded`, and `escrow_withdraw`.
Transactions can emit several events. Consumers must select by event name.
All u64 values are JSON numbers; U128 values are decimal strings.

## Decision data

`register`, `authorize`, `authorize_and_pay`, `approve_rule`, and `revoke_rule` return this same object and emit it
as a `decision` event.

| Field | Type | Meaning |
| --- | --- | --- |
| serial | u64 | Mandate serial; policy update uses 0 |
| verdict | string | `allow` or `block` |
| reason_code | string | Stable machine-readable code below |
| reason | string | Code with underscores replaced by spaces |
| action | string | Requested action; registration uses `register`; policy update uses proposal action, or empty if unknown |
| target | string | Requested target; registration and unknown policy update use empty string |
| amount | U128 | Requested amount; registration uses mandate budget; policy update uses 0 |
| instruction_hash | string | SHA-256 of exact submitted UTF-8 text, lowercase 64-character hex; empty for registration/policy update |
| remaining_budget | U128 | Current remaining mandate budget, or 0 if no mandate exists; policy updates query serial 0 |

Authorization order: unknown mandate, frozen, wrong caller, expiry, unsigned hash,
active deny rule, scope/lookalike, instruction binding, reused entry, entry
maximum, remaining budget, allowed. A successful request consumes one matching
unused entry and debits budget. Tier-1 denials consume neither. Tier-2 denials occur after successful tier-1 consumption, as described below. The second identical
consecutive denial or third consecutive denial freezes the mandate and overrides
the reported reason with `auto_frozen`. Only refusals by the mandate checks count. The refusal count goes back to 0 only at `src/lib.rs` line 811, when a request passes the mandate checks with an amount above 0 and the transaction does not fail, whatever follows: a payment, a new hold, a spend-rule refusal (`tier2_deny`), or an allowed request that pays nothing (an `authorize` call or an action other than a transfer). A zero-amount request returns at lines 787-789, before that line, and leaves the count unchanged. A failed payout check at lines 803-808 reverts the whole transaction, so the count is unchanged too. Approving or rejecting a hold later (`resolve_pending`, line 950) does not change it. A spend-rule refusal still uses the job and its share of the budget, and pays nothing.

## Rule proposal and approval data

`rule_proposal` contains the following fields. `rules()` returns these stored
objects; an `approved` value of true identifies an active deny rule.

| Field | Type | Meaning |
| --- | --- | --- |
| proposal_id | u64 | Increasing identifier, starting at 1 |
| reason_code | string | Underlying denial cause before freeze override |
| action | string | Action to deny |
| target | string | Target to deny |
| count | u64 | 3 at proposal creation |
| proposed_rule | string | `deny`, applying to this exact action/target pair |
| policy_version | u64 | Policy version at proposal creation |
| approved | bool | True only while the deny rule is active |
| revoked | bool | True after revocation; retained history prevents reapproval |

A key emits once, exactly
when its count reaches 3.
`block_counters()` separately counts reported decision codes.

`policy_update` data:

| Field | Type | Meaning |
| --- | --- | --- |
| proposal_id | u64 | Updated proposal |
| old_version | u64 | Version used in signature |
| new_version | u64 | old_version + 1 |
| change | string | `approved` or `revoked` |
| rule | object | Updated rule with `action` (string), `target` (string), `effect` (string, `deny`) |

`policy_update_rejected` data:

| Field | Type | Meaning |
| --- | --- | --- |
| proposal_id | u64 | Requested proposal |
| reason_code | string | Rejection code |
| policy_version | u64 | Unchanged current version |

Policy starts at 1. Approval signs `chopgate:rule-approval:v1` plus a zero byte,
then Borsh(contract AccountId, proposal_id u64, current policy_version u64,
action string, target string). Use `rule_approval_bytes`. The signer must be
the configured owner ed25519 key. Signature JSON is 128 hex characters.
Approval checks missing signature, owner key, proposal existence, prior approval,
then signature validity. Rejections preserve policy version and active rules.

Revocation signs `chopgate:rule-revoke:v1` plus a zero byte and the same Borsh tuple as approval; use `rule_revocation_bytes`. Checks run in order: missing signature, owner key, proposal existence, signature validity at the current version, then active status. A stale or replayed signature returns `invalid_signature`, including after a successful revocation. A valid current-version signature for a never-approved or revoked rule returns `rule_not_active`. Success clears `approved`, sets `revoked`, increments the version, and emits `policy_update` with `change:"revoked"`. Failures preserve version and rules and emit `policy_update_rejected` plus `decision`. Policy decisions still use the decision schema; earlier pre-tier demos rendered them separately as `POLICY-RECEIPT`.

Each cause/action/target key emits at most one proposal for the lifetime of the gate, including after revocation. Further same-cause blocks do not emit a replacement.

## Complete reason codes

| Code | Meaning | Method(s) |
| --- | --- | --- |
| allowed | Request accepted | register, authorize, approve_rule, revoke_rule |
| nonce_reuse | Serial already registered | register |
| missing_signature | Signature omitted/null | register, approve_rule, revoke_rule |
| owner_impersonation | Missing, malformed, or foreign signer public key | register, approve_rule, revoke_rule |
| invalid_signature | Malformed or non-verifying signature | register, approve_rule, revoke_rule |
| expired | Mandate or parent has expired | register, authorize |
| missing_parent | Parent serial is unknown | register |
| auto_frozen | Parent/mandate frozen, or denial triggered freeze | register, authorize |
| wrong_caller | Caller is not the required agent | register, authorize |
| child_wider | Child fails unused-entry subset, maximum, budget, expiry, or strict narrowing requirements | register |
| unknown_mandate | Serial is unknown | authorize |
| unsigned_instruction | Computed hash is absent from every signed entry | authorize |
| policy_rule_denied | Active deny rule matches the action and target | authorize |
| lookalike_account | Pair is absent and target resembles a listed target | authorize |
| out_of_scope | No entry for the action/target pair | authorize |
| instruction_binding_mismatch | Signed hash belongs to another pair | authorize |
| instruction_reused | All entries matching the pair and hash are consumed or delegated | authorize |
| entry_limit_exceeded | Amount exceeds every matching unused entry maximum | authorize |
| budget_exceeded | Amount exceeds remaining mandate budget | authorize |
| unknown_proposal | Proposal identifier is unknown | approve_rule, revoke_rule |
| rule_not_active | Valid current-version signature, but rule is not active | revoke_rule |
| already_approved | Proposal is active or was previously revoked | approve_rule |

## Example event lines

These concrete examples use the exact text `Transfer under the signed entries`,
a 100-unit mandate, and a one-unit allowed request. The second line is its blocked
replay. The proposal example corresponds to three out-of-scope requests for
`delete` on `remote.test` (amounts 1, 2, 3); the third decision is overridden by
freeze, while the proposal retains `out_of_scope`.

```jsonl
EVENT_JSON:{"standard":"chopgate","version":"1.0.0","event":"decision","data":[{"serial":1,"verdict":"allow","reason_code":"allowed","reason":"allowed","action":"transfer","target":"vault.test","amount":"1","instruction_hash":"1062256b81699587227a86e63f7777df6005a2a2dca423e0227ff5f2a981196c","remaining_budget":"99"}]}
EVENT_JSON:{"standard":"chopgate","version":"1.0.0","event":"decision","data":[{"serial":1,"verdict":"block","reason_code":"instruction_reused","reason":"instruction reused","action":"transfer","target":"vault.test","amount":"1","instruction_hash":"1062256b81699587227a86e63f7777df6005a2a2dca423e0227ff5f2a981196c","remaining_budget":"99"}]}
EVENT_JSON:{"standard":"chopgate","version":"1.0.0","event":"rule_proposal","data":[{"proposal_id":1,"reason_code":"out_of_scope","action":"delete","target":"remote.test","count":3,"proposed_rule":"deny","policy_version":1,"approved":false,"revoked":false}]}
EVENT_JSON:{"standard":"chopgate","version":"1.0.0","event":"policy_update","data":[{"proposal_id":1,"old_version":2,"new_version":3,"rule":{"action":"delete","target":"remote.test","effect":"deny"},"change":"revoked"}]}
```

To check proposal timing - see `learning_proposal_emitted_only_on_third_block` in `tests/incidents.rs`: no proposal on attempts 1, 2 or 4, exactly one on attempt 3. Run `cargo test --test incidents --locked` to check the incident cases.

Authorization reason codes above also apply to `authorize_and_pay`.

## Escrow events

`escrow_deposit` (any depositor; positive attached deposit):

| Field | Type | Meaning |
| --- | --- | --- |
| depositor | AccountId | Funding caller |
| amount | U128 | Attached yoctoNEAR |
| escrow_balance | U128 | Counter after funding |

`payout` (passed or approved transfer through any paying authorization path):

| Field | Type | Meaning |
| --- | --- | --- |
| serial | u64 | Authorizing mandate |
| recipient | AccountId | Transfer destination |
| amount | U128 | Scheduled yoctoNEAR |
| escrow_balance | U128 | Counter after scheduling |

`payout_settled` and `payout_refunded` (private transfer callback):

| Field | Type | Meaning |
| --- | --- | --- |
| serial | u64 | Authorizing mandate |
| recipient | AccountId | Transfer destination |
| amount | U128 | Settled or refunded yoctoNEAR |
| escrow_balance | U128 | Current counter; unchanged on success, restored on failure |

`payout` still means scheduled. Transfer success emits `payout_settled`; failure
restores the escrow counter with checked addition and emits `payout_refunded`.
Only escrow is restored: mandate budget and single-use entries remain consumed,

`escrow_withdraw` (owner-key signature required):

| Field | Type | Meaning |
| --- | --- | --- |
| nonce | u64 | Strictly increasing withdrawal nonce, initially 0 |
| recipient | AccountId | Transfer destination |
| amount | U128 | Scheduled yoctoNEAR |
| escrow_balance | U128 | Counter after scheduling |

Withdrawal signs `chopgate:escrow-withdraw:v1` followed by a zero byte and
Borsh(contract AccountId, amount U128, recipient AccountId, nonce u64), using
`withdrawal_bytes`. The signature is 128 hex characters verified against the
configured owner key. Nonce must exceed the last scheduled withdrawal nonce; amount must
be positive and covered by escrow. The submitting account need not be the owner.

Payouts validate recipient syntax and escrow before any state change; failures
panic with `payout_unavailable`. Blocked decisions schedule no transfer. The `payout` and `escrow_withdraw` events
record scheduling, not settlement.

`withdraw_settled` and `withdraw_refunded` are emitted by the private withdrawal
callback. Both carry `nonce` (u64), `recipient` (AccountId), `amount` (U128), and
`escrow_balance` (U128). Success leaves the counter unchanged; failure restores
escrow with checked addition and a defensive saturation fallback, as for payouts.
The withdrawal nonce is not rolled back, so the signature cannot be replayed.
`authorize` continues to return decisions without scheduling transfers.

Mandate registration signs `chopgate:owner-mandate:v1` followed by a zero byte and
Borsh(contract AccountId, Mandate), using `signing_bytes`. The `chopgate:owner-mandate:v1`
domain separates mandate signatures from other signed operations.

## Three-tier payment extension

The owner-mandate, withdrawal and rule signing domains above are unchanged.
`authorize` remains tier-1 only, consumes successful entries/budget, and never
moves funds or creates pending items. Both `authorize_and_pay` and
`authorize_and_pay_tiered` apply tier 2 only after tier 1 passes. The original
method supplies source `""` and no hint; the new method takes the same arguments
plus `source: String` and `judge_hint: Option<String>`.

Tier-1 denial returns immediately without consulting either judge or hint.
Tier 2 uses `pass`, `escalate`, `deny`, combined by strictest (deny > escalate >
pass). Unknown hint strings are treated as no opinion, consistently with an
omitted hint. On-chain code cannot call an LLM;
the adapter runs off-chain in the caller.
`source` is caller-declared, not proven. The default judge is a simple rule set,
not a security guarantee.

`tier2_decision` contains `tier:2`, `serial`, `verdict` (the tier-2 vocabulary),
`target`, `amount`, `source`, and `escrow_balance`. It is emitted only for a
tier-1 pass. The normal `decision` event and return object retain their schema
and `allow`/`block` vocabulary. Tier-2 deny returns `block` / `tier2_deny`;
escalate returns `block` / `tier2_escalate`; pass uses `allow` / `allowed`.
Tier-2 deny creates no reservation or pending item and moves no funds. Because
tier 1 already succeeded, its entry and budget remain consumed on deny too.

### Configuration signature and view

`set_tier2_config(config: Tier2Config, signature: String)` verifies the owner's
ed25519 key, independent of the submitting account. `tier2_config()` returns:

| Field in signing order | Borsh type | Default |
| --- | --- | --- |
| config_nonce | u64 | 0; updates must strictly increase |
| amount_threshold | U128 (u128) | u128::MAX, disabled |
| pending_ttl_ns | u64 | 3,600,000,000,000 (one hour); must be positive |
| new_payee_check | bool | false |
| trusted_sources | Vec<String> | empty, disabled |
| known_payees | Vec<String> | empty |
| denied_targets | Vec<String> | empty |

Exact bytes: ASCII `chopgate:tier2-config:v1` followed by a zero byte, then
Borsh(contract AccountId, config_nonce u64, amount_threshold U128,
pending_ttl_ns u64, new_payee_check bool, trusted_sources Vec<String>,
known_payees Vec<String>, denied_targets Vec<String>) in that order.
`tier2_config_bytes(contract, &config)` serializes `(contract, config)`;
Borsh structs concatenate fields, so the layout is exactly the tuple above.
Signatures are 128 hex characters. Nonce replay, invalid signatures and zero
TTL panic. Config replacement replaces the supplied lists, including known
payees. Payouts never add known payees; only this owner-signed configuration can add them.

Amount strictly above threshold escalates; equality passes. An unknown payee
escalates when enabled. A source absent from a nonempty trusted list escalates.
A denied target always denies, taking precedence over all escalation rules.

### Pending lifecycle, signatures and receipts

Escalation of a transfer consumes the tier-1 entry and mandate budget and
subtracts its amount from spendable escrow. It stores a pending item and pays
nothing. This deliberately preserves the existing failed-payout authorization
history semantics: reject/timeout/refund restore ESCROW ONLY, never entries or
budget. Total reserved value remains accounted for in pending items. Withdrawals
and new payments use only spendable escrow.

`pending_item(id: u64) -> Option<PendingItem>` and `pending_items() ->
Vec<PendingItem>` show unresolved items, ordered by id. Item fields: `id`,
`serial`, `action`, `target`, `amount`, `instruction_hash`, `source`,
`predecessor` (AccountId), `created_at` and `deadline` (u64 nanoseconds).
Deadline is created_at + configured TTL; arithmetic overflow panics. The
predecessor is recorded for audit and gains no approval authority.

`approve_pending(id: u64, signature: String)` and
`reject_pending(id: u64, signature: String)` use NEW bytes: ASCII
`chopgate:pending-decision:v2` followed by a zero byte, then
Borsh(contract AccountId, pending id u64, approve bool, request_hash Vec<u8>).
The request hash is SHA-256 of Borsh(action String, target String, amount U128,
serial u64, instruction_hash String), exposed by `pending_request_hash`.
The v1 helper and domain bytes are preserved but v1 signatures are no longer accepted. Approve uses true,
reject uses false. Use `pending_decision_v2_bytes`; signature is 128 hex
characters. Borsh encodes AccountId/string as u32 LE byte length + UTF-8,
vectors as u32 LE element count + elements, integers LE, bool as one byte
(0/1). Contract, id and approve flag prevent cross-contract, cross-id and
opposite-decision replay. Invalid signature panics before removing the item.
Unknown/resolved ids panic.

A failed recheck resolves as rejected and restores escrow. Only a passing recheck removes the item and schedules the SAME payout
and `on_payout` machinery as a direct pass. Reserved escrow is not subtracted
again. A rejection restores escrow. At or after the deadline, even a signed
approval resolves as expired, restores escrow and returns normally: it must
not panic and roll back restoration. `expire_pending(id)` is callable by anyone
at or after the deadline; before deadline or after resolution it panics.
There is no background on-chain timer.

Events `pending_created`, `pending_approved`, `pending_rejected`, and
`pending_expired` each contain `id`, `serial`, `target`, `amount`, `deadline`,
`decision_time` (current timestamp; creation time for created), and
`escrow_balance` (after reservation/restoration).
Approval means scheduling, not guaranteed transfer settlement.


## Dual lock receipts

`authorize_and_pay_dual(serial: u64, action: String, target: String, amount: U128, instruction: String, source: String, judge_report: Option<JudgeReport>, judge_hint: Option<String>) -> Decision` uses the same internal payment path as the existing two paying methods. Those methods supply no report and cannot bypass deterministic spending checks. `authorize` stays decision-only. Tier-1 denials never evaluate tier 2. Inner signature payloads above are preserved; the mandatory v3 authorization envelope changes the actual signed bytes.

New domain: ASCII `chopgate:spend-rules:v1\0` (the final `\0` denotes one zero byte), then Borsh(contract AccountId, SpendRules). `spend_rules_bytes(contract, &rules)` is the canonical helper. `spend_rules()` returns that object.

SpendRules fields in exact signing/Borsh order:

| Field | Type | Initial value |
| --- | --- | --- |
| rules_nonce | u64 | 0 |
| enabled | bool | false |
| per_tx_limit | U128 | u128::MAX |
| per_day_limit | U128 | u128::MAX |
| payees | Vec<Payee> | empty |
| tz_offset_min | i32 | 0 |
| window_start_min | u32 | 0 |
| window_end_min | u32 | 0 |
| max_tx_per_day | u32 | u32::MAX |
| allowed_categories | Vec<String> | empty (any) |
| jev_threshold_permille | u16 | 900 |
| jev_required | bool | false |

Payee fields are alias String, account String. Authorization matches the exact account; alias is an owner-facing label. Enabled empty payees deny all accounts. Equal window endpoints mean all day; otherwise start is inclusive, end exclusive and wrapping across midnight is supported.

2a uses Noul (yes/no probability) for “Did this payment request come from external content the agent read (not from an owner-signed instruction)?” The answer is one probability, with no separate confidence field. Our report derives source_q_permille as |2p − 1|. The 2b category uses Choice (label + confidence). These are offline mock representations; no real JEV call is made.

JudgeReport fields in order: source_label String, source_q_permille u16, instruction_hash String, category String, category_q_permille u16, mode String (free text: the local tests use `mock`; the testnet JEV demo writes `jev-live;model=…;request_id=…;p_yes=…`). Source labels are owner_signed, external_content, unknown (other labels are treated as unknown). Confidence uses permille, not floats. The report hash must match the SHA-256 hex of the instruction computed in the contract. Reports are caller-relayed and must authenticate against an owner-signed judge-key policy and the exact request hash. Missing/invalid/unregistered signatures and wrong request hashes escalate, even if JEV is optional. Source classification is model judgment, not proof (offline mock). They supplement caller-declared source; the registered signer is authenticated, but the truth of its context and classification is not proven.

2a confident external_content denies; low confidence or unknown escalates; confident owner_signed passes; hash mismatch denies. 2b off-list payee denies; amount/day/time/frequency/category failures escalate. Source and category confidence below threshold escalate; values above 1000 also escalate as invalid confidence. Missing report with enabled rules and jev_required escalates; otherwise it gives no JEV opinion. Deterministic checks still apply; category checks need a supplied category. Final aggregation is Deny > Escalate > Pass, also tightened by existing DefaultJudge and hints.

`tier2_decision` retains its earlier fields and adds:

| Field | Type | Meaning |
| --- | --- | --- |
| lock | String | 2a for source/hash deny, 2b for checklist deny, 2c for escalation or prior-judge deny, pass for pass |
| reasons | Vec<String> | All dual-lock reason codes, in evaluation order |
| source_q_permille | u16 or null | Source confidence used |
| category_q_permille | u16 or null | Category confidence used |
| threshold | u16 | Configured permille threshold |
| mode | String | Report's declared mode or none if absent |

Reason codes: `2a_external_content`, `2a_low_confidence`, `2a_unknown`, `2a_hash_mismatch`, `2b_payee_not_allowed`, `2b_per_tx_limit`, `2b_per_day_limit`, `2b_time_window`, `2b_frequency`, `2b_category`, `2b_low_confidence`, `jev_missing`. Reasons describe the dual lock; a legacy judge/hint can tighten with no dual-lock reasons. Returned Decision reason_code remains tier2_deny or tier2_escalate as appropriate. Pending events retain their existing id, serial, target, amount, deadline, decision_time and escrow_balance fields; the associated tier2_decision contains the lock/evidence.

Daily accounting uses floor((block_timestamp_ns / 60_000_000_000 + tz_offset_min) / 1440). Every outstanding reservation is also counted against the current day, including across midnight/timezone changes. Approval excludes its own reservation, checks current rules including all other reservations, then schedules and charges in the same state transition. Initial limit/window/frequency failures escalate; owner approval cannot make an exception without a signed policy change. Rejection/expiry releases the reservation but never restores mandate budget or single-use entries.

JudgePolicy contains nonce u64 and keys Vec<PublicKey>; `set_judge_policy` verifies a v3-wrapped `judge_policy_bytes` owner signature and increasing nonce. JudgeReport adds signer_public_key Option<String>, signature Option<String>, request_hash String (lowercase SHA-256 hex). `judge_request_hash` hashes Borsh(serial, action, target, amount, instruction_hash, source, caller). `judge_report_bytes` binds contract, request hash, signer key, source label/confidence, instruction hash, category/confidence and mode; wrap it in the SAME owner/chain/deployment authorization domain and sign with the registered judge key. No signature includes itself.

`tier2_decision` includes report_authenticated; confidence/mode fields expose only authenticated evidence. `2b_category_missing` escalates when an enabled category allowlist has no authenticated evidence. Caller-declared external source markers force escalation even if the model claims owner_signed. Source/context truth remains an integration/model risk.
