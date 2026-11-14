# ChopGate: design notes and earlier runs

Statements here describe the design; the claims that are backed by named tests and testnet transactions are listed in the [README](../README.md).

## Overview
ChopGate is a local NEAR escrow prototype with signed permissions, a dual lock and a human approval inbox (Korean UI).
Tier 1 verifies owner signatures and single-use instruction entries; an unsigned instruction cannot pass through a pass hint.
The contract verifies reports against an owner-signed judge-key policy and the full request hash. Missing signatures, unregistered keys and wrong request hashes escalate; authenticated confident external-content labels and off-list payees deny. Outcomes combine as Deny > Escalate > Pass.
Owner-signed spending rules check payment and daily limits, time windows, frequency and categories. Limit/window/frequency failures initially escalate, but approval cannot override them: current deterministic rules must pass.
JEV Noul source classification is a model judgment, not proof. The local checks use an offline mock; a separate live JEV connection (TypeSafe System One, model `jev-latest`) is used by `examples/testnet_jev_demo.rs` — see "JEV live connection".
The mock Noul representation derives confidence as |2p − 1|; authenticated reports with a mismatched instruction hash deny. Unauthenticated reports are ignored and escalate.
A failed recheck resolves as rejection and refunds reserved escrow. Rejection or expiry pays nothing. Mandate budget and single-use entries remain consumed. Only signed tier2 configuration updates can add known payees.

## How ChopGate differs from spending-limit wallets
The contract enforces the cumulative budget exactly, including under concurrent requests (test: attack_budget_overrun_concurrent).
Human approval is bound to the hash of the exact execution content (test: attack_approval_bound_to_request_hash).
Instruction-source judgment (JEV Noul; offline mock in local checks, live JEV only in the testnet JEV demo) is a model judgment, not proof.

## Agent Economy and attacks
The Agent Economy demo asserts an allowed API subscription payment, an above-limit payment approved after an owner-signed limit increase, and a blocked hidden instruction with zero transfer.
Its attack checks cover concurrent budget overrun, signature/instruction replay, altered approval content and missing/malformed JEV reports. Blocked attacks are counted from the local sandbox results and balance checks. Human approvals count only owner approvals in the normal flow; attack-case approvals are excluded.
Adapter errors, typed timeouts and malformed responses produce no report; required missing reports escalate.
The demo prints asserted attack/normal outcome counters and stage timings labelled mock JEV, offline; these are not real JEV latency.

## Signing
All signatures now sign `authorization_bytes(chain_id, deployment_id, owner_public_key, inner_payload)`: `chopgate:authorization:v3\0` + Borsh(chain id, deployment id, owner key, `native:NEAR`, inner bytes). Inner payloads bind the contract, method domain, nonce/id and arguments. Initialization requires `chain_id` and a `deployment_id` label; the contract appends its initialization block timestamp to create the stored incarnation id. The deployer must use the correct chain. Sign the returned stored id, not the input label. Account recreation in a later block changes the domain even with the same input label. NEAR exposes no chain-id host function; the chain-id deployment input is trusted. Read `signature_domain` before signing.

Pending inner payloads use `chopgate:pending-decision:v2\0` + Borsh(contract AccountId, id u64, approve bool, request_hash Vec<u8>).
`pending_request_hash` returns SHA-256(Borsh(action String, target String, amount U128, serial u64, instruction_hash String)).
The v1 helper/domain bytes remain available; approval rejects legacy signatures. See [payload specification](RECEIPT.md).
The web app previews only the inner v2 mock object; it is not a complete v3 signing client and performs no cryptographic signing.

Reports include `expires_at`, nonzero request-scoped `nonce`, `key_generation`, `signer_public_key`, `signature` and `request_hash`; the judge signs the v3-wrapped `judge_report_bytes`. The request hash binds serial, action, target, amount, instruction hash, source and caller. Judge outputs remain model opinions. An external source marker forces Tier 3 even if a registered mock judge is fooled by an injected line that says “this is the owner’s instruction” (in Korean in the test fixtures). The caller supplies source/context; this is not proof of real instruction source, and maliciously relabelled context remains a model/integration risk. Test fixtures share an offline owner/judge key for convenience; production keys must be held outside the agent.

## Local verification
Run `bash scripts/check.sh` with the prepared Rust/sandbox dependencies, or `node --test --test-isolation=none webapp/test/logic.test.mjs` for the UI checks.
Run `cargo run --locked --example agent_economy` for the Agent Economy demo.
The check script requires the asserted demo results, all demo attacks observed blocked, no normal denials and the required normal-flow owner approval, and ends with `CHECK: ALL OK`.
Use `bash scripts/summarize-check-log.sh <check log>` for measured results, including scene and metric lines.
These check runs used the local NEAR sandbox and offline mock judge only and deployed nothing; the separate testnet reproduction is described under "Testnet reproduction"; nothing is deployed to mainnet; not audited. `./check.sh` prints `CHECK: elapsed <n>s`; it has no time limit. See [claim coverage](../CLAIMS.md) and [demo scenes](DEMO-SCENES.md).

## Disclosures
Nothing is deployed to mainnet. Testnet deployments exist only for reproduction (see "Testnet reproduction"). This prototype is not audited. Local checks keep the offline JEV mock; the live JEV connection is described under "JEV live connection". Model judgment is not proof.
The UI uses local sample data and mock signing.

The file:// webapp (`webapp/index.html`) is a local prototype with sample data, not connected to the chain. Approvals in the UI change only browser memory; signatures there are mock and are not cryptographically verified. The displayed total is the mock transfer amount; network fees are not estimated.

## Attack suite B changes


Judge report v2 signs request hash, expiry, nonzero request-scoped nonce and monotonic judge-policy generation. Policy and withdrawal nonces must be exactly current + 1. A→B→A cannot revive an old report. Zero payments and invalid NEAR recipient names return denials before entry/budget consumption. Consumed instruction/budget remains consumed after cancellation, expiry or transfer failure, as before. Transfers and withdrawals settle once by recorded receipt id; a later failed callback cannot refund a successful transfer.

The one-command check remains `bash scripts/check.sh`; its metric assertions and `CHECK: ALL OK` marker are retained. These check runs used the local NEAR sandbox and offline mock judge only and deployed nothing; the separate testnet reproduction is described under "Testnet reproduction"; nothing is deployed to mainnet; not audited. State layout and report signing bytes changed; existing deployed state requires a reviewed migration or fresh initialization. The case inventory is in CLAIMS.md.

## Testnet reproduction

Testnet only. No mainnet deployment, no real funds. Testnet NEAR from the faucet has no value.

**Mock notice (testnet_demo only).** `examples/testnet_demo.rs` uses no JEV: it submits no judge report: it passes `judge_hint:"pass"` and the contract's built-in DefaultJudge (amount threshold) decides escalation. `tier2_decision` events therefore show `report_authenticated:false`. Model judgment is not proof.


Tools: rustc 1.86.0 with `wasm32-unknown-unknown`, cargo-near 0.20.3, near-cli-rs 0.31.1 (only for faucet account creation), Node.js 24 (for `scripts/check.sh`).

Steps:
1. Local checks: `bash scripts/check.sh` (ends with `CHECK: ALL OK`; on a cold cache you can build first with `cargo test --locked --no-run --lib --tests && cargo build --locked --examples`; the script has no time limit).
2. Build: `cargo near build non-reproducible-wasm --locked`, then `sha256sum target/near/chopgate.wasm`.
3. Accounts: one funded owner account (about 8 testnet NEAR; the 537,066-byte contract (the `18a89b6` build) needs about 5.4 NEAR of storage) and one attacker account, each with a key file `~/.near-credentials/testnet/<account>.json` (legacy keychain, mode 600). Faucet example: `near account create-account sponsor-by-faucet-service <name>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create`. Never print, log or commit key files.
4. Run: `RUN_TAG=<tag> WASM_PATH=target/near/chopgate.wasm OWNER_ACC=<owner>.testnet ATTACKER_ACC=<attacker>.testnet OUT_JSON=<rows.json> cargo run --locked --example testnet_demo`. It creates `gate<tag>`, `agent<tag>` and `payee<tag>` subaccounts of the owner (gate gets `GATE_BALANCE_MILLI`, default 6500 = 6.5 NEAR), deploys, initializes with `chain_id` testnet and deployment label `near-tn-1-<tag>`, and prints one `ROW {json}` line per transaction (tx hash, block height, result, events) and one `EXPECT … OK|MISMATCH` line. Each `EXPECT` line checks only that row's transaction status and returned `reason_code` (or, for the negative approval, the failure text) against the "Expected" column below. Additional `ASSERT … OK|MISMATCH` lines check scene 1 (`payout_settled` event, payee +0.01 NEAR, escrow −0.01 NEAR), the negative approval (item still pending, escrow unchanged) and the owner approval (`pending_approved` event with matching id, serial, target and amount; `payout_settled` event; payee +0.08 NEAR; escrow 0.08 NEAR lower than before scene 5 — it is reserved at escalation and not refunded). Other events and balances in the table are printed but not asserted. It ends with `TESTNET DEMO RESULT: k/n rows as expected, m mismatch line(s)` (a row counts once however many of its checks fail) and exits non-zero on any mismatch. Optional `REUSE=1` reuses existing subaccounts; the program refuses to run if the gate subaccount already has an initialized contract.
5. The owner signing key is generated in memory for the run and discarded. Later owner-signed calls (settings changes, `withdraw_escrow`) are then impossible, and the remaining escrow stays locked on testnet.

Expected outcomes (all are successful transactions that return a `reason_code`, except the negative approvals, which fail):

| Scene | Call | Expected |
|---|---|---|
| 1 normal pass | `authorize_and_pay_tiered` 0.01 NEAR, signed instruction | `allowed`, `payout_settled`, payee +0.01 NEAR |
| 2 unsigned instruction | instruction not in the signed mandate | `unsigned_instruction` |
| 3 owner impersonation | attacker registers a mandate signed by its own key / claims the owner key with a forged signature / calls the agent's mandate | `owner_impersonation` / `invalid_signature` / `wrong_caller` |
| 4 limit exceeded | 0.02 NEAR over a 0.01 entry limit | `entry_limit_exceeded` |
| 5 human approval | 0.08 NEAR over the 0.05 threshold, then owner-signed `approve_pending` | `tier2_escalate` + `pending_created`, then `pending_approved`, `payout_settled` |
| 5- negative | one `approve_pending` transaction: signed by a different key (default `NEG_MODE=other_key`) or wrong signature bytes (`NEG_MODE=wrong_sig`) | transaction failure `invalid pending signature`; item stays pending, escrow unchanged |

Transaction examples from the gate1 run (explorer `https://testnet.nearblocks.io/txns/<tx>`):

| Step | tx | Block | Result |
|---|---|---|---|
| deploy wasm | `3KgNr2x9VvfRWKtj2QtRfAMvjiHHSnZb5T8B33kDbEjL` | 277232595 | success |
| init `new()` | `25mLVtthPSJ8sV8xA6KCNNWWwWLffso6YMJEaR6nWQku` | 277232613 | success |
| scene 1 | `GJsUC3vJTdEL98MsbtkeyxDjcs4VeABRbRN9pDKAf8qr` | 277232775 | `allowed` |
| scene 2 | `VUwWXrmWKaB8qmRxMnyQ6oTEbfRKhvhA8iDSWsrd8tQ` | 277232804 | `unsigned_instruction` |
| scene 3 | `J63k835qujzPk8ZS9JRz4RhusdEYsDkc4ZAWqzJzGfQW` | 277232823 | `owner_impersonation` |
| scene 4 | `YpetFcb4tHjGaPbhXUg8t6ek2yRZHS39wGEagKLd9bC` | 277232882 | `entry_limit_exceeded` |
| scene 5 escalate | `26sp2QbxE2a49CB3rNp5h1CFqC1477RKjurRz6Y96qLx` | 277232902 | `tier2_escalate` |
| scene 5 approve | `HUNxrhsFGwtQxhe54kbL96KhSsjko9wsDWYoqrW9myuc` | 277232931 | `pending_approved` |

The gate1 run predates the negative approval steps. The gaten1 run below sent both negative variants; the current demo sends one negative transaction per run. Negative approval examples from the `gaten1.cg-tn1-a3-e5831b86.testnet` run (code sha256 `6e20ac13c62f77ecec9b6adbc48bf6cb52d818f9251ac797fc6581a0b18c1c1e`):

| Step | tx | Block | Result |
|---|---|---|---|
| approve_pending, wrong signature | `2Dv9jThh7SPNUGxZtLd1RERhXoBFBUokG2heiuB37EA8` | 277313966 | failure: `invalid pending signature` |
| approve_pending, different key | `HEhKP9DL15zRKQ8RoDzRaSmwzHak3Hw2WrzL8vGr7pkm` | 277313984 | failure: `invalid pending signature` |
| approve_pending, owner signature | `9msx1kZ923rZzqrXttKtzTUW7rWr4pDXm2iSCvwvgSCx` | 277314018 | `pending_approved`, `payout_settled` |

Build paths: `cargo near build non-reproducible-wasm` embeds the absolute `$CARGO_HOME/registry/src/...` path of dependencies in panic-location strings, so the wasm sha256 changes with the CARGO_HOME location. For a path-independent build add `--env "RUSTFLAGS=--remap-path-prefix=$CARGO_HOME=/cargo-home"`; with rustc 1.86.0 and cargo-near 0.20.3 this gave 537,066 bytes, sha256 `6e20ac13c62f77ecec9b6adbc48bf6cb52d818f9251ac797fc6581a0b18c1c1e`, from two different CARGO_HOME paths. Local negative tests: `cargo test --locked --test pending_sig_negative` (each rejection must carry the message `invalid pending signature`; both tests end with an owner-signed positive control).


## Earlier runs and measurements

### Run record

Latest fresh-clone run, 2026-11-14, from the private development history (commit `65c8110`). The contract code, the tests and the check scripts are the same as in this repository; later changes added the hosted site, the agent and the factory folders and edited documents. The same script was run again on 2026-11-14, offline, on a fresh clone of the snapshot commit of this repository: exit code 0, last line `CHECK: ALL OK`. The table below is from the earlier run: warm shared cargo cache and target directory, rustc 1.86.0. Times vary by machine. On a cold cache everything takes longer because crates are compiled. Our other `./check.sh` runs with a warm cache took 134-157 s.

| Command | Time | Result |
|---|---|---|
| `cargo test --locked --lib` | 6 s | last line `test result: ok. 47 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.11s` |
| `cargo test --locked --no-run --lib --tests && cargo build --locked --examples` | 14 s | last line ``Finished `dev` profile [unoptimized + debuginfo] target(s) in 4.45s`` |
| `./check.sh` | 134 s | `CHECK: docs static OK`, `CHECK: elapsed 134s`, last line `CHECK: ALL OK` |
| `cargo near build non-reproducible-wasm --locked --env "RUSTFLAGS=--remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo-home"` | 5 s (cached) | `target/near/chopgate.wasm`, 537066 bytes, sha256 `6e20ac13c62f77ecec9b6adbc48bf6cb52d818f9251ac797fc6581a0b18c1c1e`. The line `To update run: ... cargo-near near self-update` is a notice, not an error. |

Offline run of the same work commit `65c8110`: a fresh clone inside a network namespace with no network except loopback (`curl https://crates.io` failed), with the crates already in the cargo cache and near-sandbox already installed. `./check.sh` printed `CHECK: docs static OK`, `CHECK: elapsed 137s`, and the last line `CHECK: ALL OK` (exit code 0).

### Local evidence page (docs/)

URL: none. This page is not hosted; serve it locally as shown below.

This section describes the page in `docs/`, an earlier copy of the Proof page that `./check.sh` reads. The hosted demo is in `site/`. The local page is static files in `docs/` (no build step, no server code). It reads the scene transactions from the archival RPC `https://archival-rpc.testnet.near.org`. The badge shows "Reading archival RPC…", "Live from archival RPC" when all live reads succeeded, or "Recorded copy" when any live transaction read failed or the URL has `?source=recorded`. A live transaction read fails without network and also on repeated loads within about a minute (the public archival RPC limited repeated requests in our test). With `?source=recorded` in the URL, it shows the same data from `docs/data/scene-txs.json` with the badge "Recorded copy". It compares each contract's on-chain `code_hash` with the repository wasm sha256 (base58). It never asks for a key. The page includes a 96-second demo video, `docs/chopgate-demo-b.mp4` (about 3.2 MB), with English subtitles.

Do this, see this: `python3 -m http.server 8000 --directory docs`, then open http://127.0.0.1:8000/. Serve the folder over HTTP as shown; opening `index.html` as a `file://` URL is untested. http://127.0.0.1:8000/?source=recorded always shows "Recorded copy".

Limits: testnet only. The page reads public RPC only and never asks for a key. The wallet attack demo is not in this `docs/` copy; the hosted demo in `site/` has it. The "Live from archival RPC" badge depends on the public archival RPC being up.

`docs/receipt-viewer.html` is a local tool for viewing saved logs. The hosted demo is in `site/`. This `docs/` page is the local evidence page.

### Testnet runs A and B: full tables

**Wallet.** Runs A, B, D and E were signed with command-line keys. Runs C and F were signed in a browser wallet (Intear). The demo programs (`examples/testnet_demo.rs`, `examples/testnet_jev_demo.rs`) create the gate, agent and payee sub-accounts with fresh keys, and the agent account sends the scene transactions (Run A scene 3 uses the separate attacker account). The owner signing key is a separate ed25519 key, not a NEAR account key: its public key is set once in `new(owner_public_key)`, and the contract checks owner signatures against it. The demo generates that key in memory for each run and does not save it. An owner approval is that key's signature over the held request; the agent account forwards it in `approve_pending(id, signature)`. Browser wallet connection was not included in Runs A and B. Later, Runs C and F used the Intear browser wallet and Run D used a function-call agent key; see the [README](../README.md).

**Run A (no model judge, deterministic rules only)** used contract `gater2.cg-tn1-a3r-e8a6d1a3.testnet`, on-chain code hash `2QQAUeG61PtyTKLFLXMScNELTWh9b6oWMJ6B2uCQDsD2` (538,072 bytes, sha256 `14da3c88d9034b87d429554513b5289c4303ffaf21a06123491bcd85dc971771`, saved `view_code`), built from commit `6eaa143` (see "Why the two runs have different code hashes" below). [The saved public-RPC check](TESTNET-RPC-CHECK.md) records 22 transactions including the owner account creation, all final.

| Scene | Result | Transaction |
|---|---|---|
| 1 normal payment, 0.01 NEAR | `allowed`; 0.01 NEAR transferred to the payee | [YMhtFDUFTPuG3FSBFAnBsGevJuNs3yaz7dU8VmVdF7H](https://testnet.nearblocks.io/txns/YMhtFDUFTPuG3FSBFAnBsGevJuNs3yaz7dU8VmVdF7H) |
| 2 instruction not in the mandate | `unsigned_instruction` | [2BrrGmpfuoiMEEgrDdZxKvzvwVWhfBn3Krpu1ZVxVaz2](https://testnet.nearblocks.io/txns/2BrrGmpfuoiMEEgrDdZxKvzvwVWhfBn3Krpu1ZVxVaz2) |
| 3 owner impersonation (attacker signs with its own key) | `owner_impersonation` | [9HmBVt44uCfnyQhekGCamYiBZQWMY2GxVWrim2GPG8jY](https://testnet.nearblocks.io/txns/9HmBVt44uCfnyQhekGCamYiBZQWMY2GxVWrim2GPG8jY) |
| 3 owner impersonation (forged signature) | `invalid_signature` | [CKRvg2yXeQcDJXEWf6CGRuEE6YJrCB4bWsVCNukmrhx](https://testnet.nearblocks.io/txns/CKRvg2yXeQcDJXEWf6CGRuEE6YJrCB4bWsVCNukmrhx) |
| 3 wrong caller | `wrong_caller` | [BSeUm4GYryFsrAyRMnRXL2rjwSyty5BzcDK4bsKG4W4o](https://testnet.nearblocks.io/txns/BSeUm4GYryFsrAyRMnRXL2rjwSyty5BzcDK4bsKG4W4o) |
| 4 over the 0.01 NEAR limit | `entry_limit_exceeded` | [5KG3WK6ntCKYHPzmhvKUQ5ha7FXwQGZQg7KWTW2k9nn5](https://testnet.nearblocks.io/txns/5KG3WK6ntCKYHPzmhvKUQ5ha7FXwQGZQg7KWTW2k9nn5) |
| 5 above the 0.05 NEAR review amount | `tier2_escalate` (held) | [Fn43pxJbw8YpiAwSEKkDbFrTM9fEATPuFx1CVJpdCgnm](https://testnet.nearblocks.io/txns/Fn43pxJbw8YpiAwSEKkDbFrTM9fEATPuFx1CVJpdCgnm) |
| 5 approval signed by another key | fails: `invalid pending signature` | [Be1EYYjXWe1Hz4TSpTRy9ZACrMsRznQEen9JZx7QHCzn](https://testnet.nearblocks.io/txns/Be1EYYjXWe1Hz4TSpTRy9ZACrMsRznQEen9JZx7QHCzn) |
| 5 owner approval | 0.08 NEAR transferred to the payee (`payout_settled`) | [3snsdMbuhZXbbZmtLPpUPozQ8MqCRWJLBk8Jz1DfrDeN](https://testnet.nearblocks.io/txns/3snsdMbuhZXbbZmtLPpUPozQ8MqCRWJLBk8Jz1DfrDeN) |

**Run B (live judge)** used JEV (TypeSafe's judge model).

- Contract: `gatej2.cg-tn1-jev-9da8c302.testnet`. On-chain code: 537,066 bytes, sha256 `6e20ac13c62f77ecec9b6adbc48bf6cb52d818f9251ac797fc6581a0b18c1c1e`, code hash `8Qtk3jf4RLpfiB7PeXeuPGYcp4USV2yeN5Zn3d5NpAMj`.
- Source: the testnet contract is the build of commit `18a89b6`. Rebuilding that commit with `cargo near build non-reproducible-wasm --locked --env "RUSTFLAGS=--remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo-home"` (rustc 1.86.0, cargo-near 0.20.3) gives the same bytes and sha256, and the base58 form of that sha256 is the on-chain code hash.
- Run B was deployed from `ab5f21e`. `git diff ab5f21e 18a89b6 -- src Cargo.toml Cargo.lock` touches only `src/jev_live.rs`, which is compiled only for native targets (`#[cfg(not(target_arch = "wasm32"))]`) and is not in the wasm.
- [The saved public-RPC check](TESTNET-RPC-CHECK.md) records 18 run transactions plus the owner account creation, all final; only the negative approval fails. The full 18-row table and the JEV request ids are under "JEV testnet Run B" below.

**Why the two runs have different code hashes.** Run A (`gater2…`, code hash `2QQAUeG61PtyTKLFLXMScNELTWh9b6oWMJ6B2uCQDsD2`, 538,072 bytes) was built from commit `6eaa143`. Run B (`gatej2…`, code hash `8Qtk3jf4RLpfiB7PeXeuPGYcp4USV2yeN5Zn3d5NpAMj`, 537,066 bytes) was deployed from `ab5f21e`, and its code equals the `18a89b6` build. `git diff 6eaa143 18a89b6 -- src Cargo.toml Cargo.lock` changes `src/jev_live.rs`, one line in `src/lib.rs` that declares that native-only module, and the dev-dependencies (a new `reqwest` dev-dependency and a `tokio` feature, plus one matching `Cargo.lock` line). None of these is compiled into the wasm, so the contract logic in both wasm files comes from the same source. The likely cause of the different bytes is the build path: Run A was built without `--remap-path-prefix`, and its wasm contains a 51-byte local `CARGO_HOME` path 29 times where the Run B wasm contains `/cargo-home` (see "Build paths" in [Testnet reproduction](#testnet-reproduction)). Those path strings alone make Run A 1,160 bytes longer, while the files differ by 1,006 bytes, so other small byte differences exist as well. This is an inference: Run A's wasm has not been rebuilt from `6eaa143` to confirm it.

Here p(yes) is the model's probability of "yes". Tier 2 means human approval; `tier2_escalate` is the reason code for a payment sent there. p(yes) is an off-chain JEV answer; the contract does not call JEV. The demo copies it as text into the signed judge report's `mode` string, so it appears in the transaction arguments and, for scenes 1 and 5, in the contract's `tier2_decision` event log (`mode`, with `source_q_permille` 980); the log lines are quoted in the saved RPC check under "Judge fields in event logs". Scene 4 is refused by the entry limit before tier 2, so its p(yes) is only in the transaction arguments.

| Scene | JEV p(yes) (off chain; see note above) | Final decision | Transaction |
|---|---|---|---|
| 1 normal payment | 0.98 | allow; 0.01 NEAR transferred to the payee | [5jKyD4pijamkUG1S5rT1ZjeiLiX9LXC2tY6DXpCPMFCv](https://testnet.nearblocks.io/txns/5jKyD4pijamkUG1S5rT1ZjeiLiX9LXC2tY6DXpCPMFCv) |
| 1 negative: re-pointed judge report | – | escalated (`tier2_escalate`); the `tier2_decision` event log shows `report_authenticated: false` (quoted in the saved RPC check). A 0.01 NEAR hold was created (`pending_created`, id 1) and is still open (see Open holds in the saved RPC check). The original nonce was reused, so this escalation does not separate a bad judge-report signature from nonce replay | [HcJCv5AepZRRPaKamxk8pGPCzrNVpKBnDn3FSzBwcQ8A](https://testnet.nearblocks.io/txns/HcJCv5AepZRRPaKamxk8pGPCzrNVpKBnDn3FSzBwcQ8A) |
| 4 over the limit | 0.06 | block (`entry_limit_exceeded`) | [7Tcypc346TsBRvncodHiX74rWp7CJ83366Gu4jJNK7ux](https://testnet.nearblocks.io/txns/7Tcypc346TsBRvncodHiX74rWp7CJ83366Gu4jJNK7ux) |
| 5 above the review amount | 0.98 | human approval (`tier2_escalate`) | [Bbtz2nUBy5EumKyFLm3tEejucmJvoPLdrFoSBUxrmPkc](https://testnet.nearblocks.io/txns/Bbtz2nUBy5EumKyFLm3tEejucmJvoPLdrFoSBUxrmPkc) |
| 5 negative: approval signed by another key | – | fails: `invalid pending signature` | [6pxdFLzkgh1ckJHvBTpBq8CaeoYbuWqAKdBHcdWTGQaa](https://testnet.nearblocks.io/txns/6pxdFLzkgh1ckJHvBTpBq8CaeoYbuWqAKdBHcdWTGQaa) |
| 5 owner approval | – | 0.08 NEAR transferred to the payee (`payout_settled`) | [6gTqLx9oVTyE2287kDbyZweHDrqEq3TwuyKKKpd9bmEw](https://testnet.nearblocks.io/txns/6gTqLx9oVTyE2287kDbyZweHDrqEq3TwuyKKKpd9bmEw) |

### Judge model

The deterministic rules decide first. A judge model can add one opinion. In the demo, a judge answer cannot override the mandatory limits: over the per-payment maximum, a different recipient, or above the review amount (tested locally: `src/jev_live.rs::tests::mandatory_rules_cannot_be_overridden`). Below those limits, a signed judge report can let a payment pass without human approval: in Run B scene 1 a report signed by the registered demo judge key ended `allowed`, while a re-pointed copy with a stale signature escalated (`tier2_escalate`).

- **Live judge (testnet JEV demo only):** TypeSafe System One, model `jev-latest`; the responses in Run B reported version `jev-1.14.0`. One yes/no question asks whether the payment is inside the owner's mandate scope. p(yes) ≥ 0.90 → allow; 0.50 ≤ p(yes) < 0.90 → human approval; p(yes) < 0.50 → block. Thresholds are in `config/jev.json`.
- **Fail closed:** no key, an HTTP error, a malformed answer or a timeout → human review. No retries.
- **Local checks:** `./check.sh` uses an offline mock judge (no key needed).
- **What it is not:** a model answer is an opinion, not proof. The contract does not verify any TypeSafe signature, so nothing on chain proves that a judge call happened.

### Earlier factory sandbox measurement (superseded)

_This is an earlier factory version, replaced by the current factory design whose sandbox required_deposit is 5.49566 NEAR. The figures below are from that earlier measurement._

A wallet holding only 2.5 NEAR cannot create a gate; after one faucet request (+5 NEAR) it can under the structure this project is building first. That structure is (b): the gate wasm is embedded in a factory. A factory sandbox measurement on 2026-11-14 computed `required_deposit` as 5498840000000000000000000 yoctoNEAR (5.49884 NEAR), plus gas. 2.5 NEAR is below 5.49884 NEAR, so that wallet cannot attach `required_deposit`, and it cannot create a gate under (b).

This figure is from that sandbox run. It is not a testnet measurement and not a mainnet measurement. The factory source is in `factory/`. There is no mainnet deployment.

The factory in that measurement embeds the same gate wasm as Run B: 537,066 bytes, sha256 `6e20ac13c62f77ecec9b6adbc48bf6cb52d818f9251ac797fc6581a0b18c1c1e`. The contract multiplies storage by `env::storage_byte_cost()`. The sandbox printed `byte_cost=10000000000000000000` (10^19 yoctoNEAR per byte). That is the protocol parameter as the sandbox reported it, not a mainnet measurement.

Of `required_deposit`, `gate_funding` is 5495660000000000000000000 yoctoNEAR (5.49566 NEAR). That amount is transferred to the new gate and stays there: code storage, priced state bytes, and a 0.1 NEAR reserve. `record_fee` is 3180000000000000000000 yoctoNEAR (0.00318 NEAR) and stays on the factory.

The design estimate for the same (b) step is in [Cost of one gate](#cost-of-one-gate-design-comparison) below. The owner and agent steps are in the README ([Use it](../README.md#use-it)); [Run F](RUNS.md#run-f) shows them done on testnet.

### Cost of one gate: design comparison

Design estimates from our design note of 2026-11-14. The note assumes gate wasm W = 537,066 bytes and factory code F = 150-250 KB. These figures are design estimates, not measured mainnet costs. There is no mainnet deployment.

The structure this project is building first is (b), gate wasm embedded in a factory. Under (b) the design estimate to create one gate is about 5.39 NEAR locked, plus the 0.1 NEAR reserve, about 5.5 NEAR. See the earlier sandbox measurement above.

The same design note is why one screen showed 0.015 NEAR and a later part of the note says about 0.115-0.12 NEAR. Both numbers are in that note, and neither is a measurement. The (a) "create one gate" cell is about 0.015 NEAR: account creation 0.0071 + storage 0.004-0.007 + gas about 0.002. That is the protocol lock without the recommended reserve. The same table's "each additional gate" row is about 0.015 + a 0.1 reserve. A later table in the same note writes the (a) `create_gate` amount to attach as about 0.12 NEAR. So 0.015 is the lock without the reserve, and 0.115-0.12 is that lock plus the recommended 0.1 NEAR reserve.

(a) is a global contract (the wasm is registered once on the network). (b) embeds the gate wasm in a factory. (c) is a command-line script that deploys each gate on its own. "Burned" is not returned. "Locked" stays in the account that holds the storage.

| Step | (a) Global contract | (b) Wasm embedded in the factory | (c) Command-line script |
|---|---|---|---|
| Code registration | **53.707 NEAR burned** (W × 0.0001), plus gas of about 63.6 Tgas = 0.0064 NEAR. Once per network. Not returned. | None (already inside the factory). | None. |
| Factory deploy | Factory account creation 0.007 + storage for F locks **1.5-2.5 NEAR**, plus gas about 0.003. | Factory account creation 0.007 + storage for F+W (687-787 KB) locks **6.9-7.9 NEAR**, plus gas about 77-88 Tgas = 0.009. | None. |
| Create one gate | Account creation 0.0071 + storage (account 100 B + identifier 32 B + state 300-600 B) locks 0.004-0.007 + gas (factory call, `new`, callback) about 0.002. Total **about 0.015 NEAR**. | Account creation 0.0071 + storage for W plus state locks **5.374-5.377 NEAR** (permanent; the gate cannot be deleted) + gas about 0.005. Total **about 5.39 NEAR**. | Account creation 0.0071 + storage **about 5.375 locked** + deploy 0.0039 + `new` 0.0002. Total **about 5.39 NEAR**. |
| First setup (shared) | `set_tier2_config`, `set_spend_rules`, and one `register`: burn about 0.0008 NEAR. Each transaction needs attached gas from the starting balance at 0.001 NEAR per Tgas (30 Tgas is 0.03 NEAR, and that gas is refunded). | Same. | Same. |
| Minimum deposit (shared) | The contract requires more than 0, so at least 1 yoctoNEAR. For use, the note recommends the sum of amounts to pay plus a storage reserve of 0.05-0.1 NEAR. Each mandate and each hold adds a few hundred bytes of state, and the gate balance pays that storage. | Same. | Same. |
| Total through the first gate (one owner) | 53.71 + 1.5-2.5 + 0.015 + reserve 0.1 ≈ **55.4-56.4 NEAR** (includes the 53.7 burn). | 6.9-7.9 + 5.39 + reserve 0.1 ≈ **12.4-13.4 NEAR** (all locked; the burn is about 0.03). | 5.39 + reserve 0.1 ≈ **5.5 NEAR**. |
| Each additional gate | **about 0.015 + reserve 0.1** | about 5.5 | about 5.5 |
| Break-even | (a) costs less than (b) from about the 10th gate (53.7 / 5.37 ≈ 10). The design note says this matches the docs recommendation to use a global contract at 10 or more. | — | — |

For one owner and one gate, the note's estimate is lower for (c) or (b) than for (a). If many people each use a gate, the note's choice is (a), and the 53.7 NEAR code-registration burn happens once. Building (b) first, and also preparing the (a) path, is design intent only. The testnet factory `cg-u1f-fdf59d31.testnet` is deployed ([Run E](RUNS.md#run-e)). There is no mainnet deployment.

### JEV live connection

`src/jev_live.rs` (decision rule, request body, response parsing, receipts; native only, not in the wasm) and `tests/jev_live/mod.rs` (HTTP transport) connect to TypeSafe System One: `POST https://api.typesafe.ai/v1/systemone` with `Authorization: Bearer <key>`. The request is `{model, state, questions}` and contains one yes/no question, `pay_automatically` (question v2: is the payment inside the owner's mandate scope?). The response fields used are `model` (the version that answered), `answers.pay_automatically.noul` (p(yes)), `usage`, and the `x-typesafe-request-id` header.

- Model: `jev-latest` (the response reports the concrete version, e.g. `jev-1.14.0`).
- `state` contains only the amount, the recipient, the mandate scope (action, target, per-payment maximum, human-review amount) and the previous decision. No keys, signatures or other content.
- Thresholds live in `config/jev.json`: p(yes) ≥ `allow_min` (0.90) → allow; `tier2_min` (0.50) ≤ p(yes) < `allow_min` → tier 2 (human approval); p(yes) < `tier2_min` → block.
- Mandatory rules come first and a JEV answer cannot override them: over the mandate maximum or a different recipient → block; above the human-review amount (0.05 NEAR in the demo) → tier 2.
- Fail closed: no key, transport error, HTTP error (401/429/529/…), malformed answer, missing request id or timeout (`timeout_ms`) → human review. There are no automatic retries.
- Every judged request writes a receipt: model version, request id, p(yes), thresholds, JEV/mandatory/final decision, and `report_authenticated`. That flag is true only when a parsed response came from the documented endpoint `https://api.typesafe.ai/v1/systemone`; replayed fixtures (`source: fixture`) and any other endpoint such as the local test stub (`source: stub`) never set it.
- The endpoint must be `https://`; plain `http://` is accepted only when the host is exactly 127.0.0.1, localhost or [::1] (a local test stub), and an endpoint with userinfo (`user@host`) is rejected, so the key is not sent in cleartext to another host. Redirects are not followed: a 3xx answer is an HTTP error and goes to human review. `call_budget` must be 1–10.
- On chain, the demo signs a judge report with a per-run in-memory judge key that is registered by an owner-signed `set_judge_policy`. In the current native demo code (not the Run B transactions), the report encodes the final decision: allow → `owner_signed` with q = max(900, floor(1000·p)); tier 2 → q capped at 899; block → `external_content` with q = 1000 (tested locally: `src/jev_live.rs::tests::report_encoding_matches_contract_threshold`). The signed `mode` string carries `model;request_id;p_yes`. The demo sets `category` to `not_asked` with `category_q_permille` 1000; that is not a model output.
- What the on-chain flag proves: `report_authenticated: true` in the contract's `tier2_decision` event only shows that the report was signed by the per-run demo judge key registered by the owner. That key is generated in memory by the demo and attests to nothing else. The contract does not verify any TypeSafe signature, so nothing on chain proves that a JEV call happened. The request ids appear in the signed `mode` string in the transaction arguments (and for scenes 1 and 5 in the `tier2_decision` event log), and in the local receipts.
- The API key is not in this repository. It is read only from `TYPESAFE_API_KEY` or from a file named by `JEV_KEY_FILE`, and it is sent only in the Authorization header. `.gitignore` excludes `secrets/` and `*.env`.
- Live calls are counted in the `JEV_CALL_LOG` file: each HTTP attempt writes a `"phase":"attempt"` line before the request is sent and a `"phase":"outcome"` line afterwards. Calls are the attempt lines, and calls stop at `call_budget`. If the counter file cannot be read or appended to, no call is made and the request goes to human review.

Tests: `cargo test --lib jev_live` (fixtures, no key) and `cargo test --test jev_live_calls` (a local one-shot HTTP stub on 127.0.0.1 for allow, mandatory override, 401, 529, 307 redirect, malformed, missing request id, timeout, budget and an unusable counter file; no key; stub answers never authenticate). The live test `live_scenes_1_4_5_once_each` runs only with `JEV_LIVE=1`, a key, `JEV_CALL_LOG` and `JEV_OUT_DIR`. `fixtures/jev_live/recorded_q1_scene*.json` (question v1, live test) and `recorded_q2_scene*.json` (question v2, testnet Run B) are recorded live responses; only model, answers, usage and the request id are kept.

Testnet: `RUN_TAG=<tag> WASM_PATH=target/near/chopgate.wasm OWNER_ACC=<owner>.testnet JEV_KEY_FILE=<path outside the repo> JEV_CALL_LOG=<file> JEV_OUT_DIR=<dir> OUT_JSON=<rows.json> cargo run --locked --example testnet_jev_demo` runs scenes 1, 4 and 5 with one live JEV call each. Negative transactions: scene 1 sends a re-pointed copy of the scene-1 JEV report for another mandate, with the stale signature (in Run B the original nonce was reused); scene 4's over-limit call is itself the negative case; scene 5 sends one `approve_pending` signed by a different key. The owner approval asserts the `pending_approved` event (id, serial, target, amount), `payout_settled`, payee +0.08 NEAR and escrow −0.08 NEAR.

### JEV testnet Run B

Run B used commit `ab5f21e` (its on-chain code equals the `18a89b6` build documented above) on contract `gatej2.cg-tn1-jev-9da8c302.testnet`. Its 18 run transactions are all final, with the outcomes listed in [TESTNET-RPC-CHECK.md](TESTNET-RPC-CHECK.md#run-b). Three JEV answers (model `jev-1.14.0`, question v2), one each for scenes 1, 4 and 5, appear as request ids in the signed `mode` strings ([judge fields](TESTNET-RPC-CHECK.md#judge-fields-in-event-logs)).

| Scene | p(yes) | JEV | Mandatory | Final | Request id |
|---|---|---|---|---|---|
| 1 (0.01 NEAR, within scope) | 0.98 | allow | allow | allow | `req_01a1ce75c551767195dd2e0252c6da17` |
| 4 (0.02 NEAR, entry limit 0.01) | 0.06 | block | block (entry_limit_exceeded) | block | `req_01a1ce7647517e2db7d933378523ee86` |
| 5 (0.08 NEAR, review above 0.05) | 0.98 | allow | tier2 (0.08 NEAR is above the 0.05 NEAR review amount; on-chain reason `tier2_escalate`) | tier2 → owner approval | `req_01a1ce7680cb763f9dd70317e72567c4` |

Differences between `ab5f21e` (used in Run B) and the current code, not re-run on testnet:

- In Run B the scene-5 report encoded the JEV decision (allow, q = 980); the escalation came from the contract's own `amount_threshold` (0.05 NEAR). The current code signs the final decision (tier 2, score at most 0.899).
- In Run B the scene-1 negative reused the original report nonce, so the escalation does not separate a bad judge-report signature from nonce replay.

Run B ran from an earlier revision of the demo code. Its deployed wasm is byte-identical to this repository's build (step 4). Not on testnet: scene 5 encodes the final decision (human approval, score at most 0.899) instead of the raw JEV allow, and the scene 1 negative test uses a fresh nonce. In Run B that negative reused the original report nonce, so it does not separate a bad judge-report signature from nonce replay.

| # | Scene | Step | Result | Transaction |
|---|---|---|---|---|
| 1 | setup | create gate subaccount | success | [G5bPZxYsBQvc1jsVbubKHSY52hpzf84WrFVBESdELGoq](https://testnet.nearblocks.io/txns/G5bPZxYsBQvc1jsVbubKHSY52hpzf84WrFVBESdELGoq) |
| 2 | setup | create agent subaccount | success | [5TTeucrbaPPbEFE4o8toAZ99SYSLGzaoNnyxnje4fVez](https://testnet.nearblocks.io/txns/5TTeucrbaPPbEFE4o8toAZ99SYSLGzaoNnyxnje4fVez) |
| 3 | setup | create payee subaccount | success | [JEDk5f1sNvMEfU1gwniXUTpU3Dt2xU1eULQ6p2WHiUHK](https://testnet.nearblocks.io/txns/JEDk5f1sNvMEfU1gwniXUTpU3Dt2xU1eULQ6p2WHiUHK) |
| 4 | setup | deploy wasm | success | [ARufsfgjtTSFbLXyMTGMxEFuDujq4y1rZcPgdoSitH15](https://testnet.nearblocks.io/txns/ARufsfgjtTSFbLXyMTGMxEFuDujq4y1rZcPgdoSitH15) |
| 5 | setup | init new() | success | [HikLozcC2URQR6vYpc5qq5FCPDAcpmnDg2PPtGhchdDW](https://testnet.nearblocks.io/txns/HikLozcC2URQR6vYpc5qq5FCPDAcpmnDg2PPtGhchdDW) |
| 6 | setup | deposit 0.3 NEAR escrow | success | [9BGb5uuC8KWg5SJgMj6V4nVeCWuh2WSG3QptTR4sB8AY](https://testnet.nearblocks.io/txns/9BGb5uuC8KWg5SJgMj6V4nVeCWuh2WSG3QptTR4sB8AY) |
| 7 | setup | set_tier2_config threshold 0.05 NEAR (owner-signed) | success | [3Aq77ZxrvNqeLqBvEEoxk3ENgc3r4HdF4wFwJsR1Fvtm](https://testnet.nearblocks.io/txns/3Aq77ZxrvNqeLqBvEEoxk3ENgc3r4HdF4wFwJsR1Fvtm) |
| 8 | setup | set_judge_policy: register JEV judge key (owner-signed) | success | [Fa1HpQRNcnMKZaNKmZmwChkaTimRxZF5YFkn3Y9YX6Nm](https://testnet.nearblocks.io/txns/Fa1HpQRNcnMKZaNKmZmwChkaTimRxZF5YFkn3Y9YX6Nm) |
| 9 | setup | register mandate serial 1 (owner-signed) | success; reason_code=allowed | [FdAAEFnsPkgPRgbjFPbAf4jEXrM8UekaoY8T7pLq2R4J](https://testnet.nearblocks.io/txns/FdAAEFnsPkgPRgbjFPbAf4jEXrM8UekaoY8T7pLq2R4J) |
| 10 | setup | register mandate serial 11 (owner-signed) | success; reason_code=allowed | [AEEFLs2aZuAGdMXLYMLyPTwmV8XdZwMtFwJDd4r2D6rg](https://testnet.nearblocks.io/txns/AEEFLs2aZuAGdMXLYMLyPTwmV8XdZwMtFwJDd4r2D6rg) |
| 11 | setup | register mandate serial 4 (owner-signed) | success; reason_code=allowed | [AC554SY4GqETEbX8oMoejWvZfKKvUqVgDvwKJaYPwKgB](https://testnet.nearblocks.io/txns/AC554SY4GqETEbX8oMoejWvZfKKvUqVgDvwKJaYPwKgB) |
| 12 | setup | register mandate serial 5 (owner-signed) | success; reason_code=allowed | [BeWw4pBKEuE7xArpzMVCSwoet7aLU75ebBH3fDwyNKRZ](https://testnet.nearblocks.io/txns/BeWw4pBKEuE7xArpzMVCSwoet7aLU75ebBH3fDwyNKRZ) |
| 13 | 1 | authorize_and_pay_dual 0.01 NEAR with signed live JEV report | success; reason_code=allowed | [5jKyD4pijamkUG1S5rT1ZjeiLiX9LXC2tY6DXpCPMFCv](https://testnet.nearblocks.io/txns/5jKyD4pijamkUG1S5rT1ZjeiLiX9LXC2tY6DXpCPMFCv) |
| 14 | 1− (negative) | authorize_and_pay_dual serial 11 with a re-pointed copy of the scene-1 JEV report (stale signature, original nonce) | success; reason_code=tier2_escalate | [HcJCv5AepZRRPaKamxk8pGPCzrNVpKBnDn3FSzBwcQ8A](https://testnet.nearblocks.io/txns/HcJCv5AepZRRPaKamxk8pGPCzrNVpKBnDn3FSzBwcQ8A) |
| 15 | 4 | authorize_and_pay_dual 0.02 NEAR over 0.01 entry limit with live JEV report | success; reason_code=entry_limit_exceeded | [7Tcypc346TsBRvncodHiX74rWp7CJ83366Gu4jJNK7ux](https://testnet.nearblocks.io/txns/7Tcypc346TsBRvncodHiX74rWp7CJ83366Gu4jJNK7ux) |
| 16 | 5 | authorize_and_pay_dual 0.08 NEAR above 0.05 human-review amount with live JEV report | success; reason_code=tier2_escalate | [Bbtz2nUBy5EumKyFLm3tEejucmJvoPLdrFoSBUxrmPkc](https://testnet.nearblocks.io/txns/Bbtz2nUBy5EumKyFLm3tEejucmJvoPLdrFoSBUxrmPkc) |
| 17 | 5− (negative) | approve_pending signed by a different key over the exact payload (expect failure) | failure: invalid pending signature | [6pxdFLzkgh1ckJHvBTpBq8CaeoYbuWqAKdBHcdWTGQaa](https://testnet.nearblocks.io/txns/6pxdFLzkgh1ckJHvBTpBq8CaeoYbuWqAKdBHcdWTGQaa) |
| 18 | 5 (owner approval) | approve_pending with owner signature over request hash | success | [6gTqLx9oVTyE2287kDbyZweHDrqEq3TwuyKKKpd9bmEw](https://testnet.nearblocks.io/txns/6gTqLx9oVTyE2287kDbyZweHDrqEq3TwuyKKKpd9bmEw) |
