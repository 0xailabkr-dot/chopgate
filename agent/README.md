# ChopGate agent

The agent pays only by calling `authorize_and_pay_tiered` on an owner-signed ChopGate gate, with the agent's own NEAR account key. The gate decides allow, block, or hold. This package does not retry a payment and it does not keep a copy of the owner's signing seed.

Node 22.22.2 or newer is required (`package.json` `engines.node` is `>=22.22.2`, `near-api-js` 7.5.3). The code is ESM.

## Install

```bash
cd chopgate/agent
npm install
```

`package-lock.json` pins `@modelcontextprotocol/sdk` 1.32.2, `near-api-js` 7.5.3, and `zod` 3.25.76.

## Agent key

The agent account has one function-call key. It may call only `authorize_and_pay_tiered` on the mandate's gate, and the allowance must be null. `CHOPGATE_AGENT_KEY` (default `~/.chopgate/agent-key.json`) is that key file: mode `600`, outside this repository. The loader derives the public key from `private_key`, or from `secret_key` when the file is a console key file, and refuses the file (`key_refused`) when `public_key` does not match. Before `status` reports a gate, and again on every `pay`, the library reads `view_access_key` for the file's account and that derived public key. There is no cache: each call reads the chain. That scope check runs at send time on the final block. It is not atomic with the broadcast. `pay` signs with the nonce from that same `view_access_key` result (the viewed nonce plus one) and the block hash from that result. A key change in the window is caught only by the protocol. The protocol is the last line: a function-call key cannot be widened without the owner's full-access key. A full-access key is `full_access_key_refused`. Any other permission, including a function-call key for another receiver, a different method list, or a finite allowance, is `key_scope_mismatch`. A finite allowance says so in English and Korean. An empty `method_names` list is not accepted. Nothing is sent. There is no argument and no environment variable that accepts a full-access key.

What the key can and cannot do is in the top-level [README](../README.md#how-the-agent-holds-its-keys). The owner creates the agent account in the browser Console (Mandates, Create agent account) or with the owner script `scripts/create-agent-account.mjs`.

## Files the agent needs

`~/.chopgate/agent-key.json`, mode `600` (override with `CHOPGATE_AGENT_KEY`). After you download chopgate-agent-key.json from the console, run chmod 600 on that file, then set CHOPGATE_AGENT_KEY to its path.

The file is one of two JSON shapes. A NEAR CLI credential file has `account_id`, `public_key`, and `private_key`. `private_key` starts with `ed25519:`:

```json
{
  "account_id": "agent.example.testnet",
  "public_key": "ed25519:...",
  "private_key": "ed25519:..."
}
```

The console file `chopgate-agent-key.json` has `type` `chopgate-agent-key`, `version` 1, `account_id`, `public_key`, and `secret_key`. `secret_key` is 64 hex characters of the 32-byte ed25519 seed:

```json
{
  "type": "chopgate-agent-key",
  "version": 1,
  "account_id": "agent.example.testnet",
  "public_key": "ed25519:...",
  "secret_key": "<64 hex characters>"
}
```

The loader opens the file with `O_NOFOLLOW` and checks the mode with `fstat` on that descriptor. Group or other permissions, a symlink, or a `public_key` that does not match the key derived from `private_key` or from `secret_key` are refused (`key_refused`). `toJSON()` omits the secret. `signer.account()` builds a NEAR `Account` that holds the key in memory for the one send.

`~/.chopgate/mandates/` (override with `CHOPGATE_MANDATES`) holds connection snippets written by the owner console:

```json
{
  "network": "testnet",
  "gate": "gate.example.testnet",
  "agent": "agent.example.testnet",
  "serial": 1,
  "budget": "10000000000000000000000000",
  "expires_at": "2000000000000000000",
  "entries": [
    {
      "action": "transfer",
      "target": "payee.example.testnet",
      "max_amount": "1000000000000000000000000",
      "instruction": "pay invoice 104",
      "instruction_hash": "optional lowercase sha256 hex of instruction"
    }
  ]
}
```

A bare integer amount in a mandate file is yoctoNEAR, because that is the value the owner signed. A decimal or a `NEAR` suffix is decimal NEAR. If `instruction_hash` is present it must equal `sha256(instruction)` or the file is rejected. `serial` and a large `expires_at` are decimal strings. A JSON number is accepted only when it is a safe integer.

`~/.chopgate/ledger.jsonl` (override with `CHOPGATE_LEDGER`) records attempts. Each append is opened, written, and `fsync`'d, mode `600`. A check-and-append takes an exclusive lock file (`<ledger>.lock`, created with `open` flag `wx`). The wait is at most a few seconds. A stale lock (older than 60 seconds, or a dead pid older than 1 second) is reported as `ledger_locked` and is not deleted. Remove it only when no ChopGate process is running.

Before a signature is built, the ledger gets an intent row. An intent with no result means the outcome is unknown. A later call with the same gate, mandate serial, and fingerprint is `duplicate_attempt_not_sent` when an intent is still open, or when a result says the broadcast happened or `sent` is `unknown`. Another serial on the same gate is not that duplicate. A result with `broadcast: false` and `sent: false` closes that intent and does not block a later call. A corrupt line fails closed: `pay` returns `ledger_corrupt` and `status` sets `ledger_corrupt`.

The ledger stores account ids, amounts, hashes, outcomes, and a `source` string. `source` is stored as given only when it is at most 200 characters and printable. Anything else is `bad_source` and is not written. The ledger does not store keys or signatures.

Network endpoints are `config/networks.json`. The name `mainnet` and a `networkId` of `mainnet` are refused in code, even when a file says `enabled: true`. `CHOPGATE_NETWORKS_FILE` may only select `networkId` `sandbox` or `testnet`. A gate or agent account that ends in `.near`, other than `test.near` and `*.test.near`, is refused. `*.testnet` accounts are allowed.

Before `status` reads a gate, and again before `pay` or `approve-pending` broadcasts, the library calls RPC method `status`. The reported `chain_id` must equal that network's `networkId`, and it must be `testnet` or `sandbox`. `near-sandbox` initialized with `--chain-id sandbox` reports `chain_id` `sandbox`, and that id is accepted only for a network whose `networkId` is `sandbox`. Any other id, including `mainnet`, is `chain_id_refused` and nothing is sent. If the status call times out or cannot be reached, the result is `rpc_preflight`.

## MCP client

`src/mcp-server.mjs` speaks MCP over stdio. The client block is `config/mcp-config.example.json`:

```json
{
  "mcpServers": {
    "chopgate": {
      "command": "node",
      "args": ["/path/to/chopgate/agent/src/mcp-server.mjs"],
      "env": {
        "CHOPGATE_AGENT_KEY": "/absolute/path/to/agent-key.json",
        "CHOPGATE_MANDATES": "/absolute/path/to/mandates",
        "CHOPGATE_LEDGER": "/absolute/path/to/ledger.jsonl",
        "CHOPGATE_NETWORK": "testnet"
      }
    }
  }
}
```

`pay` reads the network from the mandate file. `CHOPGATE_NETWORK` is the network name for `scripts/approve-pending.mjs` (default `testnet`). Tool handlers run one at a time. The server logs to stderr only. Every pay result, status row, and MCP error carries `reason_code`, `reason_en`, and `reason_ko`.

### chopgate_status

No arguments, or `{ "gate": "gate.example.testnet" }`. Returns JSON text: one row per entry (`entry_id` is `<gate>#<serial>:<index>`), plus the mandate freeze fields.

`entry_id` states are `unused`, `used`, `frozen`, `expired`, or `unknown`. There is no on-chain view of per-entry use or the freeze bit. Status replays `decision` events from the fastnear tx index and archival `viewTransactionStatusWithReceipts`, using the transaction signer as the caller, and merges the local ledger. The signer is not the receipt predecessor, so a cross-contract call can be missed. If the index cannot be read, `source` is `local-only`. Rows are filled from the ledger only when that ledger explains `remaining_budget`. A second RPC can lag a few blocks behind the one that accepted a payment, so a status read immediately after `pay` can stay `unknown` until `remaining_budget` matches.

`freeze_known_from` is `chain` only when that tx-index replay, with no extra local rows, explains `remaining_budget`. Otherwise it is `local-ledger`. In the local-ledger case, `frozen`, `blocks_in_a_row`, and `last_block_fingerprint` are a lower bound from this ledger: the chain may already have more refusals. `freeze_warning_en` / `freeze_warning_ko` say that. They are not a claim that the mandate is safe to pay. When the ledger does not explain the budget, those fields are null and the warning says the freeze state is unknown.

`next_block_would_freeze` is true when a chain replay shows `blocks_in_a_row >= 2`, or when a last blocked fingerprint is stored (repeating that call freezes the mandate). It is false when the mandate is already frozen. On a local-ledger lower bound the same formula is applied to the lower bound only, and the warning says so. `last_block_fingerprint` is the last blocked call this source could see. `unresolved_sends` lists intents and unknown broadcasts that are not explained yet. A corrupt ledger is `ledger_corrupt: true` with `ledger_corrupt_lines`.

When `expires_at <= now` (the machine clock, the same check `pay` uses), the mandate has `expired: true`. Entries that are not already `used` are state `expired`, with the `mandate_expired_not_sent` English and Korean text. `pay` on that entry refuses locally with that same code.

Index replay uses a per-call timeout (8 seconds, `CHOPGATE_RPC_TIMEOUT_MS`) and a total deadline (20 seconds, `CHOPGATE_REPLAY_DEADLINE_MS`). If either is exceeded, `pay` returns `rpc_preflight` and `sent: false`. A fast index error still falls back to `local-only`. A broadcast waits at most 60 seconds (`CHOPGATE_SEND_TIMEOUT_MS`). If that deadline passes after the transaction was handed to the node, `pay` returns `sent: "unknown"` with the tx hash and writes the ledger result that closes the intent, so a later status call is not stuck behind it. `viewMethod`, block time, tx status, and `view_access_key` each wait at most 20 seconds (`CHOPGATE_VIEW_TIMEOUT_MS`) and then fail as `rpc_preflight`.

### chopgate_pay

`{ "entry_id", "amount", "source", "target"?, "instruction"?, "confirm_freeze_risk"? }`.

`amount` is a NEAR decimal. `"5"` and `"5 NEAR"` mean 5 NEAR (5 × 10^24 yoctoNEAR), not 5 yocto. A `yocto` suffix is an integer count of yoctoNEAR. Zero, a negative, scientific notation, more than 24 decimal places, and any value above `u128` are refused locally as `amount_refused`.

`target` and `instruction` default to the entry. On that default call the library also refuses, before a broadcast, when the key account is not `mandate.agent` (`agent_mismatch_not_sent`), when `expires_at` is already past (`mandate_expired_not_sent`), when the amount is over the entry max (`over_max_not_sent`), when the amount is over the mandate budget or the remaining budget (`over_budget_not_sent`), or when that entry is already used (`entry_used_not_sent`).

A caller may override `target` or `instruction`. This module still sends that transaction so the gate can refuse it. The result includes the freeze warning. Do not use an override to route a payment somewhere else.

`source` should be `"owner_chat"` for an instruction the owner wrote. Any other non-empty source is untrusted on chain and can hold the payment. The text must be printable and at most 200 characters.

`confirm_freeze_risk` must be the boolean `true` before a broadcast unless `freeze_known_from` is `chain`. A local-ledger lower bound is not enough: the first call without the flag returns `freeze_risk_not_sent`, `sent: false`, and no transaction. The result's `reason_en` / `reason_ko` say why. When the freeze state is not known from chain history, the text is "Freeze state is not known from chain history. Nothing was sent." When chain history shows that the next refusal would freeze the mandate, the text is "The next refusal would freeze this mandate for good. Nothing was sent." Chain history requires that confirmation when `blocks_in_a_row >= 2` for every call, because this agent cannot prove the gate will allow it (a policy rule, a denied target, or a duplicate tuple can still block), and also when the call repeats `last_block_fingerprint`. A mandate that is already frozen returns `frozen_not_sent`.

`sent` is `false` when nothing was broadcast (local refusal or a failure before broadcast). `sent` is `true` when the transaction was included and this process read an outcome, including an `execution_failure` or a missing decision. `sent` is `"unknown"` when broadcast has started and the outcome was not read back. `verdict_kind` can be `unknown` while `sent` is `true`: the transaction was broadcast, but it is not a gate allow or block. The MCP tool sets `isError` only for `sent: "unknown"` or a thrown error. A known local refusal is a normal result.

After broadcast, a failure while reading the outcome or writing the ledger does not become "Something failed before a payment." The result still carries the tx hash and `sent: true` or `sent: "unknown"`. The ledger append is retried a few times. That retry writes only the local file. It does not send the transaction again. If the append still fails, the result has `ledger_write_failed: true`.

The result also includes `tx_hash`, `explorer_url`, `verdict` (`allow` or `block`), `reason_code`, `reason_en`, `reason_ko`, `verdict_kind`, `held`, `pending_id` when the payment is held, `remaining_budget`, `blocks_in_a_row`, `mandate_frozen`, `next_block_would_freeze`, `last_block_fingerprint`, `freeze_warning_en`, `freeze_warning_ko`, `state_note` when the chain counter was not verified, and the `EVENT_JSON` events.

A transaction hash is base58(sha256(borsh(Transaction))). It does not include the signature. `execution_failure` means the transaction was included and the receipt failed. The chain reverts that call, so the freeze counter and the entry do not change. `state_note` is `state unverified` and the returned freeze fields stay at the pre-send summary. The ledger still records `sent: true`, so a later call with the same fingerprint is `duplicate_attempt_not_sent`. Do not resend it from this agent. `verdict_kind` for that code is `unknown` even though `sent` is `true`. A missing decision uses `internal_error` the same way: the counter is not moved, `state_note` is `state unverified`, and the English text does not say the failure happened before a payment. `auto_frozen` forces `mandate_frozen: true` even when the pre-send summary was stale.

Messages inside the library pass through `redact` before they are returned.

## Freeze and no retry

The gate keeps a block counter on the mandate. A refusal adds one. Three in a row, or the same fingerprint twice, freezes the mandate forever. The fingerprint is action, target, amount, instruction hash, and caller. The refusal count goes back to 0 only at `src/lib.rs` line 811, when a request passes the mandate checks with an amount above 0 and the transaction does not fail, whatever follows: a payment, a new hold, a spend-rule refusal (`tier2_deny`), or an allowed request that pays nothing (an `authorize` call or an action other than a transfer). A zero-amount request returns at lines 787-789, before that line, and leaves the count unchanged. A failed payout check at lines 803-808 reverts the whole transaction, so the count is unchanged too. Approving or rejecting a hold later (`resolve_pending`, line 950) does not change it. Some receipts do not touch the counter: `zero_amount`, `invalid_recipient`, `pending_limit`, `unknown_mandate`. A frozen mandate stays frozen. There is no unfreeze method.

The warning text on every status summary and on a blocked pay result is:

- EN: Do not resend. 3 refusals in a row, or the same attempt twice, freeze this mandate for good.
- KO: 다시 보내지 마세요. 3연속 거절이나 같은 시도 2회면 영구 동결됩니다.

This module does not retry after a block, a hold, or an RPC error. It does not resend. The send provider is given one attempt: `SEND_RESENDS` is 0, and `near-api-js` 7.5.3 treats `retries` as the attempt count including the first try, so the send provider uses `retries: 1`. Passing `retries: 0` would skip the POST. Views use one attempt per URL and then the next URL. A send uses only the first RPC and does not fail over onto a second broadcast.

A held payment (`reason_code` `tier2_escalate`) has already consumed the one-use entry. It waits in escrow until the owner signs `approve_pending`. Paying it again does not finish it.

## Reason codes

Unknown codes use a generic sentence plus the raw code. `verdict_kind` is `paid`, `held`, `refused`, `not_sent`, or `unknown`.

| code | EN | KO |
| --- | --- | --- |
| `allowed` | Paid. It matches a stamped job. | 지급했습니다. 도장 찍힌 일과 같습니다. |
| `tier2_escalate` | Held. Over the review amount. | 보류했습니다. 금액이 검토 금액을 넘었습니다. |
| `tier2_deny` | Refused by the second check. Nothing was paid. | 두 번째 검사가 거절했습니다. 지급하지 않았습니다. |
| `unknown_mandate` | No such mandate. | 그런 지시서가 없습니다. |
| `unsigned_instruction` | Not a stamped instruction. | 도장 찍힌 지시문이 아닙니다. |
| `owner_impersonation` | Someone posed as the owner. | 누군가 주인을 사칭했습니다. |
| `invalid_signature` | The stamp doesn't check out. | 도장 서명이 맞지 않습니다. |
| `wrong_caller` | This mandate is for another agent. | 다른 에이전트의 지시서입니다. |
| `entry_limit_exceeded` | Over this job's limit. | 이 일의 건당 한도를 넘었습니다. |
| `budget_exceeded` | Over the total budget. | 지시서의 총 예산을 넘었습니다. |
| `auto_frozen` | The mandate is frozen for good. | 지시서가 영구 동결됐습니다. |
| `nonce_reuse` | This mandate number is already registered. | 이 지시서 번호는 이미 등록됐습니다. |
| `instruction_reused` | This request was already used. | 이미 쓰인 요청입니다. |
| `expired` | Expired. Nothing was paid. | 기한이 지났습니다. 지급하지 않았습니다. |
| `missing_signature` | The owner stamp is missing. | 주인 도장이 없습니다. |
| `invalid_recipient` | That recipient account is not valid. | 받는 계정이 올바르지 않습니다. |
| `missing_parent` | The parent mandate is missing. | 상위 지시서가 없습니다. |
| `child_wider` | The child mandate is wider than the parent. | 하위 지시서가 상위보다 넓습니다. |
| `pending_limit` | Too many payments are already waiting. | 대기 중인 지급이 너무 많습니다. |
| `policy_rule_denied` | A policy rule denies this. | 정책 규칙이 이 지급을 막습니다. |
| `lookalike_account` | That account looks like the real payee. | 그 계정이 진짜 수취인과 비슷합니다. |
| `out_of_scope` | That account is outside this job. | 그 계정은 이 일의 범위 밖입니다. |
| `instruction_binding_mismatch` | The instruction does not match this target. | 지시문이 이 대상과 맞지 않습니다. |
| `zero_amount` | The amount is zero. Nothing was paid. | 금액이 0입니다. 지급하지 않았습니다. |
| `pending_created` | Held. Waiting for the owner. | 보류했습니다. 주인을 기다립니다. |
| `pending_approved` | The owner approved the held payment. | 주인이 보류 건을 승인했습니다. |
| `pending_rejected` | The owner rejected the held payment. | 주인이 보류 건을 거절했습니다. |
| `pending_expired` | The held payment expired. | 보류 건의 기한이 지났습니다. |
| `already_approved` | This rule was already approved. | 이 규칙은 이미 승인됐습니다. |
| `unknown_proposal` | No such rule proposal. | 그런 규칙 제안이 없습니다. |
| `rule_not_active` | That rule is not active. | 그 규칙은 적용 중이 아닙니다. |
| `duplicate_attempt_not_sent` | This attempt was already recorded. Nothing was sent. | 이미 기록된 시도입니다. 보내지 않았습니다. |
| `frozen_not_sent` | The mandate is frozen. Nothing was sent. | 지시서가 동결되어 있습니다. 보내지 않았습니다. |
| `freeze_risk_not_sent` | The next refusal could freeze this mandate for good. Nothing was sent. The result text is more specific: chain state unknown, or the next refusal would freeze. | 다음 거절이 이 지시서를 영구 동결할 수 있습니다. 보내지 않았습니다. 결과 문장은 체인 상태를 모르는 경우와 다음 거절이 동결하는 경우를 구분합니다. |
| `network_not_enabled` | This network is not enabled. Nothing was sent. | 이 네트워크는 쓸 수 없습니다. 보내지 않았습니다. |
| `chain_id_refused` | This RPC chain_id is not the configured network. Nothing was sent. | 이 RPC의 chain_id가 설정된 네트워크가 아닙니다. 보내지 않았습니다. |
| `rpc_preflight` | Status could not be read before sending. Nothing was sent. | 보내기 전에 상태를 읽지 못했습니다. 보내지 않았습니다. |
| `rpc_uncertain` | The send result is unknown. Do not resend. | 전송 결과를 모릅니다. 다시 보내지 마세요. |
| `execution_failure` | The transaction was included and failed. Do not resend. `sent` is true and `verdict_kind` is unknown. The chain did not consume the entry. This ledger still blocks the same fingerprint. | 거래는 들어갔지만 실패했습니다. 다시 보내지 마세요. `sent`는 true이고 `verdict_kind`는 unknown입니다. 체인은 항목을 소모하지 않았습니다. 이 장부는 같은 지문을 막습니다. |
| `ledger_corrupt` | The ledger has a broken line. Nothing was sent. | 장부에 깨진 줄이 있습니다. 보내지 않았습니다. |
| `ledger_locked` | The ledger lock is held. Nothing was sent. | 장부 잠금이 걸려 있습니다. 보내지 않았습니다. |
| `amount_refused` | The amount is not a valid NEAR value. Nothing was sent. | 금액이 올바른 NEAR 값이 아닙니다. 보내지 않았습니다. |
| `agent_mismatch_not_sent` | This key is not the mandate agent. Nothing was sent. | 이 열쇠는 지시서의 에이전트가 아닙니다. 보내지 않았습니다. |
| `mandate_expired_not_sent` | This mandate's deadline has passed. Nothing was sent. | 이 지시서의 기한이 지났습니다. 보내지 않았습니다. |
| `over_max_not_sent` | Over this job's limit. Nothing was sent. | 이 일의 건당 한도를 넘었습니다. 보내지 않았습니다. |
| `over_budget_not_sent` | Over the remaining budget. Nothing was sent. | 남은 예산을 넘었습니다. 보내지 않았습니다. |
| `entry_used_not_sent` | This job was already used. Nothing was sent. | 이 일은 이미 쓰였습니다. 보내지 않았습니다. |
| `bad_source` | The source text is not allowed. Nothing was sent. | 출처 문구를 쓸 수 없습니다. 보내지 않았습니다. |
| `key_refused` | The agent key file must be a mode 600 regular file. | 에이전트 열쇠 파일은 모드 600인 일반 파일이어야 합니다. |
| `full_access_key_refused` | The agent key is a full-access key. Nothing was sent. | 에이전트 열쇠가 전체 권한 열쇠입니다. 보내지 않았습니다. |
| `key_scope_mismatch` | The agent key must allow only authorize_and_pay_tiered on this gate. Nothing was sent. | 에이전트 열쇠는 이 게이트의 authorize_and_pay_tiered만 허용해야 합니다. 보내지 않았습니다. |
| `internal_error` | Something failed before a payment. | 지급 전에 문제가 생겼습니다. |

Tier-2 lock strings (`2a_hash_mismatch`, `2a_external_content`, `2a_unknown`, `2a_low_confidence`, `2b_low_confidence`, `jev_missing`, `2b_payee_not_allowed`, `2b_per_tx_limit`, `2b_per_day_limit`, `2b_frequency`, `2b_time_window`, `2b_category_missing`, `2b_category`) ride inside `tier2_decision` events. They are not decision `reason_code` values.

## Owner approval

`scripts/approve-pending.mjs` is for the owner, not the agent model.

```bash
export OWNER_SIGNING_KEY_FILE=/path/to/owner.seed   # hex of the 32-byte ed25519 seed
export SUBMITTER_KEY_FILE=/path/to/submitter.json   # NEAR CLI credential of the gas payer
export CHOPGATE_NETWORK=testnet
node scripts/approve-pending.mjs --gate gate.example.testnet --id 1 --approve
node scripts/approve-pending.mjs --gate gate.example.testnet --id 1 --reject
```

The script reads `pending_item` and `signature_domain`. The pending request hash is SHA-256 of Borsh(`action`, `target`, `amount`, `serial`, `instruction_hash`), matching the contract. It does not include source, predecessor, created_at, deadline, or the report. The deadline is read with `BigInt` and compared to the latest block time. The pending id is one `BigInt` for the signature and for the call args. It is sent as a JSON number only when it is a safe integer. A larger id fails before a transaction is built. `OWNER_SIGNING_KEY_FILE` and `SUBMITTER_KEY_FILE` must be mode `600` regular files. The script refuses a missing field, a missing item, or a deadline that has already passed. It prints the tx hash, the explorer link, and the events. It exits non-zero unless `--approve` produced `pending_approved`, or `--reject` produced `pending_rejected`. It does not print the seed.

## Tests

```bash
node test/key-scope-test.mjs
node test/reasons-test.mjs
node test/mcp-smoke.mjs
node test/sandbox-e2e.mjs
```

`CHOPGATE_SANDBOX` is required for the sandbox test and for the Run D runner when the network is sandbox. There is no default sandbox binary. `CHOPGATE_WASM` still overrides the gate wasm. The default wasm path, relative to `test/sandbox-e2e.mjs` and to the Run D script under `scripts/`, is `../../target/near/chopgate.wasm` (the repository `target/near/chopgate.wasm`). `test/reasons-test.mjs` cross-checks contract reason strings against `CHOPGATE_CONTRACT_LIB` and `CHOPGATE_CONTRACT_TIER2` (default `../../src/lib.rs` and `../../src/tier2.rs`, relative to that test file). If those files are missing it skips that cross-check and says so. The in-repo English and Korean table is still checked. The sandbox test starts `near-sandbox` with a home under `.sandbox-tmp`, deploys the gate wasm, and drives the library. It deletes that directory, including every key it created. Sandbox has no tx index, so status reports `local-only` and `freeze_known_from: "local-ledger"`. Sends in that mode are refused once without `confirm_freeze_risk`, then sent only when the test passes `confirm_freeze_risk: true`. `test/mcp-smoke.mjs` uses its own temp directory and does not delete `.sandbox-tmp`.

Run D on sandbox (`test/rund-sandbox.sh`) sets `RUND_CONFIRM_FREEZE=1`. D1–D4 each record a local `freeze_risk_not_sent` and then an operator-confirmed re-call with `confirm_freeze_risk: true`. That second call is deliberate. It is not an automatic retry of a send. The sandbox runner also transfers 2 NEAR of balance onto the agent after the 0.3 NEAR creation transfer, because this sandbox's gas price attaches about 0.301 NEAR to a 300 TGas call. That top-up is sandbox-only and adds no key. Testnet does not do it.
D8 calls `authorize_and_pay_tiered` on the gate with the agent function-call key and a 1 yoctoNEAR deposit; the protocol rejects it (`InvalidTxError.InvalidAccessKeyError.DepositWithFunctionCall`) before the contract runs, because a function-call key cannot attach NEAR.

## Limitations

- Mainnet is refused in code. A config file cannot enable it. The same refusal covers a `networkId` other than `sandbox` or `testnet`, a production `.near` account id, and an RPC `status` `chain_id` that is not exactly the configured `testnet` or `sandbox` id.
- Entry use and the freeze counter are not views. A missing tx index means status only knows what this ledger recorded and what `remaining_budget` still shows. Those freeze numbers are a lower bound (`freeze_known_from: "local-ledger"`), not chain history. A lagging second RPC can leave that unexplained for a few blocks.
- The duplicate check is the gate, the mandate serial, and the fingerprint. The same call under another serial on the same gate is not a duplicate in this ledger.
- A child mandate can consume a parent entry at registration time. That consumption is not in the child's decision events, so a parent file can show `unknown` for those entries.
- The agent key can send an overridden target or instruction. The gate must be the thing that blocks it. Do not treat a local send as permission.
- Entries are one-use even when the payment is only held. A failed payout does not restore the entry or the budget.
- The contract owner key is fixed at `new`. This package cannot rotate it.
- The owner's seed and the agent's NEAR key are different. Losing the seed strands escrow. This repository must not contain either key.
- `pay` attaches no deposit. The NEAR comes from the gate's escrow.
- The module talks to the first RPC in the list for a send and does not fail over onto a second broadcast.
