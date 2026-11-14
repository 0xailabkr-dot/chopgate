# ChopGate

An AI agent holding its owner's full-access key can send any amount to any account; if a prompt injection steers it, no on-chain check stops the payment.

- ChopGate holds an owner's NEAR in escrow and pays a request only when it matches a job the owner signed. Any other request is refused on chain and pays 0.
- Testnet shows seven runs (A to G): payments, refusals that pay 0, holds, owner approvals, a function-call key, a factory gate with 0 access keys, the same steps in a browser, and an approval bound to the exact request hash.
- Not done: not audited, no mainnet deployment, and no NEAR Intents, USDC, negotiation, or hiring other agents.

## Core limits

Found in a local sandbox run on 2026-11-14 (near-sandbox, contract code hash `8Qtk3jf4RLpfiB7PeXeuPGYcp4USV2yeN5Zn3d5NpAMj`).

- Anyone who knows a live mandate serial can freeze it. Any account can do it: the same refused request from the same account twice in a row (with no passing request in between), or three refusals by the mandate checks in a row, freezes it for good. In that run the first call was `wrong_caller` and the second was `auto_frozen`; the agent then also got `auto_frozen`. No NEAR is paid. Recovery: the owner issues a new mandate (a new serial). The old serial stays frozen. The attacker can freeze the new one the same way. The refusal count goes back to 0 only at `src/lib.rs` line 811, when a request passes the mandate checks with an amount above 0 and the transaction does not fail, whatever follows: a payment, a new hold, a spend-rule refusal (`tier2_deny`), or an allowed request that pays nothing (an `authorize` call or an action other than a transfer). A zero-amount request returns at lines 787-789, before that line, and leaves the count unchanged. A failed payout check at lines 803-808 reverts the whole transaction, so the count is unchanged too. Approving or rejecting a hold later (`resolve_pending`, line 950) does not change it. A spend-rule refusal still uses up the job and its share of the budget, and nothing is paid. Only refusals by the mandate checks count toward three in a row or the same attempt twice.
- Anyone can grow the gate's storage with refused requests that carry long action or target strings. Those strings are kept in the refusal record and the event log. In that run, 3 requests with 15,802-character strings grew storage by 63,758 bytes. The contract has no per-mandate storage cap; in that run a 4th call on the already frozen mandate added 0 bytes, but other mandates on the same gate can be used the same way (not tested). After that, withdrawing the full escrow failed with `LackBalanceForState`, about 0.028 NEAR short. Calling `deposit()` does not fix it: it raises escrow by the same amount. A plain NEAR transfer to the gate account (not `deposit()`) of the shortfall fixes it; then the full withdrawal succeeded. In that run the second and third calls added 15,896 bytes each; larger strings were not tested.
- Fix design, not deployed: calls from anyone other than the mandate's agent would not touch the mandate's counters or storage; stored strings would have a length limit.
- If the stamp key is lost, the escrow stays locked.

The full list is in [Limitations](#limitations).

## What it is

ChopGate is a NEAR smart contract (a gate) that holds an owner's funds in escrow and sits between an AI agent and those funds. The agent's key cannot move them; it can only ask the gate to pay.
The gate pays only a request that matches a mandate: a list of jobs the owner signed, each with a recipient, a maximum amount and the exact instruction text. Any other payment request is refused in a successful transaction that pays 0 and records a reason code. A forged owner approval makes the transaction fail. Either way nothing is paid.
Above a review amount the payment is held until the owner approves it. After the deadline (one hour at most) it can no longer be approved and nothing is paid (shown on testnet: [2qjtEiQD...](https://testnet.nearblocks.io/txns/2qjtEiQDzfSj5NWmsxdtJiGSLt7aYA3n76qzEGNC56iF)).
On NEAR testnet, seven recorded runs (A to G) show payments, refusals with 0 NEAR paid, holds and owner approvals, an agent function-call key that cannot send NEAR or call anything else (Run D), a factory-created gate with 0 access keys (Run E), the same steps done from a browser with a wallet (Run F), and an approval bound to the exact request hash (Run G).
Testnet only. Not audited. No mainnet deployment and no real funds. Binding an approval to the exact request hash is shown on testnet in [Run G](docs/RUNS.md#run-g).

Words used below: a **gate** is the contract account that holds the escrow. A **mandate** is the owner-signed list of jobs for one agent, with a total budget and an expiry. The **stamp key** is the owner's signing key for the gate (an ed25519 key made in the browser, separate from the wallet key). The **review amount** is the line above which a payment waits for the owner.

## Try it in two minutes

Demo: https://0xailabkr-dot.github.io/chopgate/

The home page shows a short looping illustration and a five-scene walkthrough, and the Proof page starts with a 96-second recorded walkthrough.

1. **Proof.** Open [Proof](https://0xailabkr-dot.github.io/chopgate/verify/). The page reads 10 testnet transactions live from a public archival NEAR RPC node (`https://archival-rpc.testnet.fastnear.com` first, then `https://archival-rpc.testnet.near.org`) and shows the verdict, the reason code and the payout of each. Refused rows have no payout, and each hash links to the explorer. The runs these rows come from are listed in [Testnet evidence](#testnet-evidence).

2. **Try.** If you have no NEAR testnet wallet, create one at [wallet.intear.tech](https://wallet.intear.tech) (choose Web; it starts with about 2.5 testnet NEAR, far more than the attacks cost). On the same page, connect the wallet (the list has 6 wallets; signing in the wallet window was tested with Intear; Meteor was checked up to the mainnet-account notice) and press the four attack buttons. They go to one test gate, `gatec.chopgate-runc-cc790216.testnet`. You type nothing; your wallet signs; each call attaches 0 NEAR and 30 Tgas, and costs about 0.0003 testnet NEAR in gas. Forged owner signatures are made with a throwaway key created in the tab.

   | Attack | What is sent | Result |
   |---|---|---|
   | 1 | a payment request with no mandate | Refused, `unknown_mandate`, paid 0 |
   | 2 | a mandate signed with the throwaway key | Refused, `owner_impersonation`, paid 0 |
   | 3 | a request on mandate #900, which is bound to another agent and already frozen by earlier attempts | Refused, `auto_frozen`, paid 0 |
   | 4 | `approve_pending` for hold 1 with a forged signature | the transaction fails, `invalid pending signature`, paid 0 |

   The eight signed transactions and the wallet-cancel line are in [Run C](docs/RUNS.md#run-c).

3. **Console.** Open [Console](https://0xailabkr-dot.github.io/chopgate/console/) to create your own gate with a testnet wallet. You need about 7.5 testnet NEAR: a new Intear wallet starts with about 2.5 and one faucet request adds 5. The steps are in [Use it](#use-it). To look at a live gate without a wallet, open [Tour](https://0xailabkr-dot.github.io/chopgate/tour/): it reads the Run D gate from the chain and shows its escrow, spend rules, held payments and latest transactions.

Without the hosted page: `git clone https://github.com/0xailabkr-dot/chopgate && cd chopgate && python3 -m http.server 8000 --directory site`, then open http://localhost:8000. The full local check, `./check.sh` (about 2.5 minutes, ends with `CHECK: ALL OK`), is in [Verify locally](#verify-locally).

### Check it from a terminal

These two checks were run on 2026-11-14. Step 1 needs no account. Step 2 uses near-cli-rs 0.31.1 and any testnet account. Attach 0 NEAR. Gas is about 0.0003 NEAR.

1. Read a refused transaction from the archival RPC.

   ```
   curl -s https://archival-rpc.testnet.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tx","params":{"tx_hash":"6KgX8YMVc8E2FfQ8DWxX4cdjzaF2kTm9oULrskq6sf9t","sender_account_id":"cgw3-ll5tpm.testnet","wait_until":"FINAL"}}' | jq -c '{status: .result.final_execution_status, events: [.result.receipts_outcome[].outcome.logs[] | ltrimstr("EVENT_JSON:") | fromjson | .data[] | {verdict, reason_code}], paid_receipts: [.result.receipts_outcome[].outcome.executor_id | select(. == "payeec.chopgate-runc-cc790216.testnet")] | length}'
   ```

   Output:

   ```
   {"status":"FINAL","events":[{"verdict":"block","reason_code":"unknown_mandate"}],"paid_receipts":0}
   ```

   `paid_receipts` 0 means no receipt reached the payee: nothing was transferred.

2. Send attack 1 yourself (a payment request with no mandate) to `gatec.chopgate-runc-cc790216.testnet`.

   ```
   near contract call-function as-transaction gatec.chopgate-runc-cc790216.testnet authorize_and_pay_tiered json-args '{"serial":777777,"action":"transfer","target":"payeec.chopgate-runc-cc790216.testnet","amount":"1000000000000000000000","instruction":"ChopGate live demo attack","source":"owner_chat","judge_hint":"pass"}' prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as <your-account>.testnet network-config testnet sign-with-keychain send
   ```

   Expected: the call succeeds and returns `{"verdict": "block", "reason_code": "unknown_mandate", "remaining_budget": "0", ...}`; the gate log is one EVENT_JSON `decision` with verdict block. Recorded run: 2026-11-14 22:53 KST from testnet account `cg-rta-t2-f0443a.testnet`, transaction [7xVapQQV3uAGARSg7tBktYxLLC3UKEJhVoJhQBiNvMQa](https://testnet.nearblocks.io/txns/7xVapQQV3uAGARSg7tBktYxLLC3UKEJhVoJhQBiNvMQa), gas used 2.9 Tgas, fee 0.0002605627374085 NEAR. The returned JSON:

   ```
   {"action":"transfer","amount":"1000000000000000000000","instruction_hash":"55719352052602c83dfc4bf5759bd608c3bde863cec397412fe67fdba7a868ad","reason":"unknown mandate","reason_code":"unknown_mandate","remaining_budget":"0","serial":777777,"target":"payeec.chopgate-runc-cc790216.testnet","verdict":"block"}
   ```

## Verify locally

Network: rustup installs the pinned toolchain and the `wasm32-unknown-unknown` target listed in `rust-toolchain.toml` if they are missing (rustup behaviour; that download is not timed here). Cargo downloads crates from crates.io on the first build. Later runs use the cargo cache. `rust-toolchain.toml` pins channel `1.86.0`, profile `minimal`, and target `wasm32-unknown-unknown`.

1. `cargo test --locked --lib`

   You should see: `test result: ok. 47 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.11s`.

   Needs: Rust 1.86.0.

2. `cargo test --locked --no-run --lib --tests && cargo build --locked --examples`

   Optional. It makes step 3 faster on a cold cache. It compiles the library tests and the examples.

   You should see: ``Finished `dev` profile [unoptimized + debuginfo] target(s) in 4.45s``.

   Needs: Rust 1.86.0.

   Network: same as the note above.

3. `./check.sh` (runs `scripts/check.sh`)

   You should see: `CHECK: docs static OK`, `CHECK: elapsed <N>s` (about 2-3 minutes in our runs; varies by machine; the script has no time limit), and the last line `CHECK: ALL OK`.

   Needs: Rust 1.86.0 with the `wasm32-unknown-unknown` target, cargo-near 0.20.3, Node.js 24, and near-sandbox 2.13.4. If any of these is missing, `./check.sh` stops and prints an install hint.

   Network: same as the note above. `./check.sh` itself does not download near-sandbox. If that binary is missing, the script stops and prints an install hint with the download URL. An offline run of the same code is recorded in [the run record](docs/DETAILS.md#run-record).

   No API key is needed: `./check.sh` uses an offline mock judge.

   The docs check scans the text files in `docs/` (html, js, css, json, md, vtt, srt, txt) for key-material patterns (`private_key`, `secret_key`, `seed_phrase`, `BEGIN PRIVATE KEY`, and `ed25519:` followed by 80 or more base58 characters). The same check also scans the whole repository (text files, skipping binary files and `target/` if present) for common machine-local absolute directory prefixes. A raw hex key or a key without the `ed25519:` prefix would not be caught, so this check is not proof that no secret exists.

4. `cargo near build non-reproducible-wasm --locked --env "RUSTFLAGS=--remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo-home"`

   The cargo home path is replaced so the bytes do not depend on where cargo keeps crates.

   See the result: `wc -c target/near/chopgate.wasm && sha256sum target/near/chopgate.wasm` (on macOS, `shasum -a 256`).

   You should see: the wasm file `target/near/chopgate.wasm`, 537066 bytes, sha256 `6e20ac13c62f77ecec9b6adbc48bf6cb52d818f9251ac797fc6581a0b18c1c1e`. This equals the Run B on-chain code (code hash `8Qtk3jf4RLpfiB7PeXeuPGYcp4USV2yeN5Zn3d5NpAMj`). cargo-near also prints a line `To update run: ... cargo-near near self-update`; that is a notice, not an error.

   Needs: Rust 1.86.0 with the `wasm32-unknown-unknown` target, and cargo-near 0.20.3.

   Network: same as the note above.

### What the tests show

| Claim | Evidence (test in this repository) |
|---|---|
| An instruction that is not in the owner-signed mandate pays nothing. | `tests/escrow.rs::blocked_unsigned_instruction_pays_zero`, `src/lib.rs::unit_tests::unsigned_instruction_blocked` |
| A mandate signed with a foreign key, or used by the wrong caller, is refused. | `tests/incidents.rs::owner_impersonation_foreign_key_and_caller` |
| A payment over the per-payment limit pays nothing. | `tests/escrow.rs::blocked_over_limit_pays_zero`, `tests/incidents.rs::entry_amount_over_limit_blocked` |
| In a sandbox attack test, six 1 NEAR requests against a 2 NEAR budget (three sent concurrently) paid at most 2 NEAR in total; the others were refused with `budget_exceeded` or `auto_frozen` and no transfer. | `tests/attacks.rs::attack_budget_overrun_concurrent` |
| An owner approval is bound to the hash of the exact request; an approval signed by another key, or with wrong signature bytes, fails and leaves the item pending. | `tests/attacks.rs::attack_approval_bound_to_request_hash`, `tests/pending_sig_negative.rs::approve_pending_rejects_other_key_signature`, `tests/pending_sig_negative.rs::approve_pending_rejects_wrong_signature` |
| A payment above the review amount is reserved in escrow and paid exactly once after owner approval. | `tests/tiers.rs::threshold_reserves_and_owner_approval_pays_exactly_once` |
| After the hold deadline, `expire_pending` (or a late approval) returns the reserved amount to the contract's escrow and pays nothing. | `tests/tiers.rs::timeout_and_late_approval_restore_without_paying` |
| A payee outside the owner's allowlist is denied. | `src/jev.rs::tests::off_allowlist_payee_is_2b_deny` |
| A judge answer cannot override a tier-1 denial or the demo's mandatory limits. | `src/judge.rs::tests::tier2_cannot_override_tier1_deny_any_hint`, `src/jev_live.rs::tests::mandatory_rules_cannot_be_overridden` |
| A judge error, timeout, malformed answer or missing key goes to human review (fail closed). | `src/jev_live.rs::tests::errors_fail_closed_to_human_review`, `tests/jev_live_calls.rs::stub_failures_fail_closed`, `tests/attacks.rs::attack_jev_failure_fails_closed` |

`./check.sh` also runs the attack suites (`tests/attack_suite_a.rs`, `tests/attack_suite_b.rs`), the incident tests (`tests/incidents.rs`), the scripted demo (`examples/demo.rs`), the agent loop (`examples/agent_loop.rs`), the local Agent Economy demo (`examples/agent_economy.rs`, showing an agent paying within an owner-signed budget; no testnet evidence for it) and the UI tests (`webapp/test/logic.test.mjs`). The check script, not a separate test, asserts the demo results and metrics it prints. The outcome of each attack-suite test, including which ones make a payment, is in the generated table in [CLAIMS.md](CLAIMS.md#attack-suites-a-and-b).

The run record is in [docs/DETAILS.md#run-record](docs/DETAILS.md#run-record).

## How it works

Each payment request from the agent must match an owner-signed mandate (who may call, who may be paid, the limits).
Above the review amount it is held until the owner signs the exact request hash.
A refusal is a successful transaction: nothing is paid, and a reason is returned.
Three refusals by the mandate checks in a row, or the same refused attempt twice, freeze the mandate.
The refusal count goes back to 0 only at `src/lib.rs` line 811, when a request passes the mandate checks with an amount above 0 and the transaction does not fail, whatever follows: a payment, a new hold, a spend-rule refusal (`tier2_deny`), or an allowed request that pays nothing (an `authorize` call or an action other than a transfer). A zero-amount request returns at lines 787-789, before that line, and leaves the count unchanged. A failed payout check at lines 803-808 reverts the whole transaction, so the count is unchanged too. Approving or rejecting a hold later (`resolve_pending`, line 950) does not change it.
A spend-rule refusal still uses up the job and its share of the budget, and nothing is paid.
There is no unfreeze.
The owner registers a new mandate (a new serial). The old serial stays frozen.
Deterministic rules run first.
A model cannot override them.
A judge failure fails closed.
Details: [judge model](docs/DETAILS.md#judge-model).

## Use it

Creating one gate on testnet locks 5.49566 NEAR in the new gate account. The Run E total, including gas, is in [Run E](docs/RUNS.md#run-e).

### Owner steps (browser)

Done end to end with the Intear testnet wallet ([Run F](docs/RUNS.md#run-f)). The wallet pays gas. The owner's signatures come from a separate stamp key: an ed25519 key made in the browser that signs mandates, settings and approvals.

1. Create a testnet wallet at [wallet.intear.tech](https://wallet.intear.tech). When Intear asks, choose Web. It starts with about 2.5 NEAR (2.49947 NEAR observed).
2. Request the [faucet](https://docs.near.org/getting-started/faucet): one request adds about 5 NEAR (chain-verified 2.49947 -> 7.49947 NEAR) and covers the gate (about 5.51 NEAR: 5.49566 locked, the rest gas), the agent account (1 NEAR), and a small deposit (up to about 0.9 NEAR). See [Run F](docs/RUNS.md#run-f).
3. Open the Console at https://0xailabkr-dot.github.io/chopgate/console/ and connect the wallet. One wallet account has one gate. If the stamp key is lost, that gate's escrow cannot be withdrawn and the same wallet account cannot create a new gate.
4. Stamp key: press Create stamp key, then Download backup. The key is stored unencrypted in this browser and cannot be replaced. If it is lost, the escrow stays locked.
5. Create gate: the Console reads `required_deposit()` from the factory and shows the amount (5.49566 NEAR plus gas). If it cannot read that view it shows a fallback of about 5.6 NEAR and keeps the Create button locked. Approve in the wallet. You get the gate address and a transaction link, and after a reload the Console finds your gate again. The new gate account has 0 access keys.
6. Add funds: deposit testnet NEAR into the gate's escrow. To take money back out, fill in Recipient and Withdrawal amount on the same step and press Withdraw: the stamp key signs the request, the wallet sends it, and the gate pays that account from escrow.
7. Spend rules: set the review amount. The stamp key signs it. The other rules are optional and off by default. On this same step, fill in the payee list with each account the agent will pay (the recipient account). If you switch "Apply these rules" on, that list is an allowlist: the gate then pays only those accounts. The Console does not save the rules switched on with an empty list.
8. Mandates: type an agent name and press Create agent account (Agent steps, step 1). Then set a budget (for example 1 NEAR), an expiry and at least one job: the recipient account, a per-job limit (for example 0.1 NEAR) and the exact instruction text (for example `Pay invoice 42`). If the spend rules are switched on, add each recipient to the payee list first (step 7). Press Issue mandate, then Copy mandate JSON; the agent needs that text.
9. Approvals: a payment above the review amount waits here. Approve and Reject are signed with the stamp key.
10. History: the Console history view shows the latest 8 transactions, with verdicts and reason codes.

The owner can withdraw escrow at any time with the stamp key. If that key is lost, the escrow cannot be withdrawn. Money reserved by a held payment is not part of the escrow balance until the hold is approved, rejected or expired, so a withdrawal cannot take it. An amount above the escrow balance is stopped in the Console before the wallet opens ("That is more than the escrow balance.").

### Agent steps

1. In the Console, under Mandates, type an agent name and press Create agent account. One transaction creates a sub-account of your wallet account: CreateAccount, Transfer 1 NEAR (for gas), and AddKey of a function-call key for your gate and `authorize_and_pay_tiered`. Press Save file to keep `chopgate-agent-key.json`. The Console shows this key once. No agent key is in this repository.
2. Move the key file to the agent's default path and restrict it (adjust the first path to where your browser saved the file): `mkdir -p ~/.chopgate/mandates && mv ~/Downloads/chopgate-agent-key.json ~/.chopgate/agent-key.json && chmod 600 ~/.chopgate/agent-key.json`. The agent refuses a key file that other users can read. On Windows the agent refuses to run because of the key-file permission check (chmod 600). Run it in WSL.
3. Save the mandate JSON you copied in owner step 8 as `~/.chopgate/mandates/mandate-1.json` (any `.json` name in that folder works).
4. Install the agent (Node.js 22.22.2 or later): `git clone https://github.com/0xailabkr-dot/chopgate && cd chopgate/agent && npm install`. Add the server to your MCP host, then restart the host. Most hosts take a block like this:

   ```json
   {
     "mcpServers": {
       "chopgate": {
         "command": "node",
         "args": ["/absolute/path/to/chopgate/agent/src/mcp-server.mjs"]
       }
     }
   }
   ```

   With the default paths above no other setting is needed; for other paths set `CHOPGATE_AGENT_KEY` (the key file), `CHOPGATE_MANDATES` (the folder) and `CHOPGATE_LEDGER` (a file the agent writes). The Agent page of the demo shows the config block, and [agent/README.md](agent/README.md) lists every parameter. The recommended default is to require host approval for the pay tool. For Claude Code, add `"permissions": {"ask": ["mcp__chopgate__chopgate_pay"]}` to the settings. A result `held` (reason `tier2_escalate`) means the owner must approve it in the Console Approvals step; a refusal means the payment is blocked and nothing was paid. Do not retry the same request.
5. Call `chopgate_status`. It lists the owner-signed jobs, each with an `entry_id`; copy it exactly as printed. Then call `chopgate_pay` with `entry_id`, `amount` (in NEAR) and `source` (`"owner_chat"` for an instruction the owner wrote), for example `{"entry_id": "<gate>#<serial>:0", "amount": "0.01", "source": "owner_chat"}`. A request that matches returns `verdict` `allow`, `reason_code` `allowed` and an `explorer_url`. A payment above the review amount returns `held` with a `pending_id` and waits in the Console under Approvals. If `chopgate_pay` answers `freeze_risk_not_sent`, nothing was sent: the agent could not rule out that one more refusal would freeze the mandate. Repeat the call with `confirm_freeze_risk: true` to accept that risk. Run F set that flag on its first call.

The factory is `cg-u1f-fdf59d31.testnet`, code hash `KmMxbye2PkLVWJ7dnjWGepVsccteC6pdJpnde9cCQGZ`. It has no admin or upgrade method. Its source is in `factory/`.

### CLI steps

These commands use near-cli-rs (the `near` command, https://github.com/near/near-cli-rs). They were run with near-cli-rs 0.31.1. Install: `curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/near-cli-rs/releases/latest/download/near-cli-rs-installer.sh | sh` (the installer from the near-cli-rs releases page).

1. Create a faucet-sponsored account.

`near account create-account sponsor-by-faucet-service <you>.testnet autogenerate-new-keypair save-to-keychain network-config testnet create`

You should see a new account with 10 NEAR (the CLI's faucet service gives 10 NEAR; the web faucet in the browser steps gives 5).

2. Call `create_gate`. `owner_public_key` is the ed25519 public key of your owner signing key. Any ed25519 public key whose private key you hold works. For a quick check you can pass the public key of the account you just created (`near account list-keys <you>.testnet network-config testnet now` prints it). To issue mandates or approve holds later you must sign with that key; the browser Console creates a dedicated stamp key for this. `required_deposit` returns yoctoNEAR and today's value is 5495660000000000000000000 yoctoNEAR = 5.49566 NEAR. Prepaid gas 300 Tgas (the Console attaches 300 Tgas too; Run E attached 200 Tgas and used 80.04 Tgas). The factory refuses less than 200 Tgas (`prepaid gas below 200 Tgas`; 199 Tgas was refused in a sandbox test). The factory names the gate from the calling account's name, not from the owner signing key: "g" + the first 20 hex characters (first 80 bits) of sha256(caller account name) + "." + factory account. One gate per calling account per factory. Finding a different account name whose hash gives the same gate name takes about 2^80 tries (targeted collision). A second create_gate from the same account fails and is refunded. There is no admin or upgrade method. One batch: CreateAccount, Transfer, DeployContract (gate wasm), and new. Read the deposit first:

`near contract call-function as-read-only cg-u1f-fdf59d31.testnet required_deposit json-args '{}' network-config testnet now`

`near contract call-function as-transaction cg-u1f-fdf59d31.testnet create_gate json-args '{"owner_public_key":"ed25519:<your owner public key>"}' prepaid-gas '300 Tgas' attached-deposit '5.49566 NEAR' sign-as <you>.testnet network-config testnet sign-with-keychain send`

3. Find your gate address:

`near contract call-function as-read-only cg-u1f-fdf59d31.testnet gate_account_for json-args '{"owner":"<you>.testnet"}' network-config testnet now`

You should see your gate address. For the Run E account `cg-u1v-1f7640e2.testnet` the output is `"g69d4c038440a403cc5ca.cg-u1f-fdf59d31.testnet"`.

Then:

`near account view-account-summary <gate> network-config testnet now`

`near account list-keys <gate> network-config testnet now`

You should see code hash `8Qtk3jf4RLpfiB7PeXeuPGYcp4USV2yeN5Zn3d5NpAMj` and 0 keys (Run E gate on testnet: same).

Earlier sandbox measurement: [details](docs/DETAILS.md#earlier-factory-sandbox-measurement-superseded). Estimates: [details](docs/DETAILS.md#cost-of-one-gate-design-comparison).

## Testnet evidence

All transactions are on NEAR testnet. Each hash links to `https://testnet.nearblocks.io/txns/<hash>`.

| Run | Gate account | Code hash | What it shows | Details |
|---|---|---|---|---|
| A | `gater2.cg-tn1-a3r-e8a6d1a3.testnet` | `2QQAUeG61PtyTKLFLXMScNELTWh9b6oWMJ6B2uCQDsD2` (an earlier build, not rebuilt; not the repository build) | Rules: normal pay, unsigned instruction, impersonation x3, over the limit, hold, owner approval | [full tables](docs/DETAILS.md#testnet-runs-a-and-b-full-tables) |
| B | `gatej2.cg-tn1-jev-9da8c302.testnet` | `8Qtk3jf4RLpfiB7PeXeuPGYcp4USV2yeN5Zn3d5NpAMj` | Live JEV judge (JEV is TypeSafe's judge model, an off-chain model that scores a request) | [full tables](docs/DETAILS.md#testnet-runs-a-and-b-full-tables), [Run B](docs/DETAILS.md#jev-testnet-run-b) |
| C | `gatec.chopgate-runc-cc790216.testnet` | `8Qtk3jf4RLpfiB7PeXeuPGYcp4USV2yeN5Zn3d5NpAMj` | Four Try attacks, each signed twice in a wallet popup, none paid | [Run C](docs/RUNS.md#run-c) |
| D | `cg-u3g-b7f26e6c.testnet` | `8Qtk3jf4RLpfiB7PeXeuPGYcp4USV2yeN5Zn3d5NpAMj` | Agent function-call key, wrapper stop, hold, and owner approval | [Run D](docs/RUNS.md#run-d) |
| E | `g69d4c038440a403cc5ca.cg-u1f-fdf59d31.testnet` | `8Qtk3jf4RLpfiB7PeXeuPGYcp4USV2yeN5Zn3d5NpAMj` | Factory `cg-u1f-fdf59d31.testnet` created this gate | [Run E](docs/RUNS.md#run-e) |
| F | `g81c38e479450fbf416bd.cg-u1f-fdf59d31.testnet` | `8Qtk3jf4RLpfiB7PeXeuPGYcp4USV2yeN5Zn3d5NpAMj` | Browser Console with the Intear wallet | [Run F](docs/RUNS.md#run-f) |
| G | `gb8c3037084b97f7e51ca.cg-u1f-fdf59d31.testnet` | `8Qtk3jf4RLpfiB7PeXeuPGYcp4USV2yeN5Zn3d5NpAMj` | Approval bound to the exact request hash | [Run G](docs/RUNS.md#run-g) |

## How the agent holds its keys

`view_access_key_list` at block 277574923, and again at 08:20 KST, showed one function-call key and no full-access key on `rund2.cg-u3o-b7f26e6c.testnet`.

`near account list-keys rund2.cg-u3o-b7f26e6c.testnet network-config testnet now`

You should see 1 key: FunctionCall, receiver `cg-u3g-b7f26e6c.testnet`, method `authorize_and_pay_tiered`, allowance null.

The account was created in one transaction ([Run D](docs/RUNS.md#run-d)). The MCP server and the agent module (`agent/src/`) read only that key file and accept no full-access key.

It can call `authorize_and_pay_tiered`, pay gas, and read public state. It cannot send NEAR, call another account, call `withdraw_escrow`, `register`, `approve_pending` or `set_tier2_config`, change keys, or attach NEAR. The protocol rejects those before they reach a contract. NEAR's documentation says function-call keys "do not allow to attach NEAR tokens to the call" ([access keys](https://docs.near.org/protocol/accounts-contracts/access-keys)). Run D measured that: D8 attached 1 yoctoNEAR and got `DepositWithFunctionCall`, the D6 transfer got `RequiresFullAccess`, the D6 call to another account got `ReceiverMismatch`, and D7 got `MethodNameMismatch`. Nothing entered a block.

### Limits of that key

The balance pays gas only. The key can call only `authorize_and_pay_tiered`, so it cannot withdraw that balance (D6-D8), and the key cannot be replaced or widened. To rotate it, the owner creates a new agent account and a new mandate. When the balance cannot pay gas, the agent stops until someone sends NEAR. Anyone can send NEAR.

Each call reserves 300 TGas, so the account needs more than 0.3 NEAR: measured 0.30092 NEAR (0.3 NEAR was refused with `NotEnoughBalance`). Unused gas is refunded. The D4 call cost is in [Run D](docs/RUNS.md#run-d). Create the agent account with 1 NEAR.

A leaked key can only do what the agent can do. Requests the spend rules deny (`tier2_deny`) use up the job and its share of the budget and pay nothing. The refusal count goes back to 0 only at `src/lib.rs` line 811, when a request passes the mandate checks with an amount above 0 and the transaction does not fail, whatever follows: a payment, a new hold, a spend-rule refusal (`tier2_deny`), or an allowed request that pays nothing (an `authorize` call or an action other than a transfer). A zero-amount request returns at lines 787-789, before that line, and leaves the count unchanged. A failed payout check at lines 803-808 reverts the whole transaction, so the count is unchanged too. Approving or rejecting a hold later (`resolve_pending`, line 950) does not change it. Refusals by the mandate checks can freeze it: three in a row, or the same refused request twice in a row (with no passing request in between). Nothing is paid. Payments go only to owner-signed recipients, within owner-signed amounts (Run D: D2 swapped recipient `out_of_scope`, D3 over the entry limit `entry_limit_exceeded`, both paid 0). Above the review amount, the owner still approves.

A prompt injection can make the agent pass source `owner_chat` and `confirm_freeze_risk` true. `confirm_freeze_risk` is a value the caller passes, so an agent that ignores the warning can set it itself. The lock is on chain, not in the wrapper: the gate judges that request by the same rules. Only refusals by the mandate checks count. Three in a row, or the same refused request twice in a row (with no passing request in between), freeze the mandate (gate code: `s.blocks >= 3`, or the same refused attempt twice in a row). The refusal count goes back to 0 only at `src/lib.rs` line 811, when a request passes the mandate checks with an amount above 0 and the transaction does not fail, whatever follows: a payment, a new hold, a spend-rule refusal (`tier2_deny`), or an allowed request that pays nothing (an `authorize` call or an action other than a transfer). A zero-amount request returns at lines 787-789, before that line, and leaves the count unchanged. A failed payout check at lines 803-808 reverts the whole transaction, so the count is unchanged too. Approving or rejecting a hold later (`resolve_pending`, line 950) does not change it. A spend-rule refusal still uses up the job and its share of the budget, and nothing is paid. Keep host tool approval on for `chopgate_pay`. The example is in [Agent steps](#agent-steps), step 4. The MCP specification says hosts SHOULD present confirmation prompts for tool calls (https://modelcontextprotocol.io/specification/2025-06-18/server/tools).

## Limitations

- Testnet prototype; not audited; no mainnet deployment.
- The judge is a model opinion. The on-chain judge key was generated for that run, so the signature only shows that the demo signed the report.
- Instruction `source` is supplied by the caller. A mislabelled source is an integration risk.
- What Run B did not re-run on testnet is in [JEV testnet Run B](docs/DETAILS.md#jev-testnet-run-b).
- `webapp/index.html` is a local prototype (sample data, mock signing), not connected to the chain.
- For Runs A to D the owner signing keys were generated in memory and discarded. Withdrawing escrow needs the owner's signature (`tests/escrow.rs::agent_cannot_withdraw_and_owner_can`), so the escrow left on those gates stays locked. Run F is different: its owner key is the stamp key in the tester's browser, and Run F withdrew from its gate three times (F18, F19, F23).
- `expire_pending` was called once on testnet: on Run C hold 3 ([2qjtEiQD...](https://testnet.nearblocks.io/txns/2qjtEiQDzfSj5NWmsxdtJiGSLt7aYA3n76qzEGNC56iF)) it logged `pending_expired`, paid 0, and returned 0.005 NEAR to escrow. It returns the hold to escrow and pays nothing. Holds that are still stored are listed in [Open holds](docs/RUNS.md#open-holds).
- Only refusals by the mandate checks count toward a freeze: three in a row, or the same refused request twice in a row (with no passing request in between). The refusal count goes back to 0 only at `src/lib.rs` line 811, when a request passes the mandate checks with an amount above 0 and the transaction does not fail, whatever follows: a payment, a new hold, a spend-rule refusal (`tier2_deny`), or an allowed request that pays nothing (an `authorize` call or an action other than a transfer). A zero-amount request returns at lines 787-789, before that line, and leaves the count unchanged. A failed payout check at lines 803-808 reverts the whole transaction, so the count is unchanged too. Approving or rejecting a hold later (`resolve_pending`, line 950) does not change it. There is no unfreeze. `register` refuses the frozen mandate's serial number with `nonce_reuse`, so the owner registers a new mandate with a new serial number. The old serial stays frozen. Anyone who knows a live serial can freeze it. The 2026-11-14 sandbox run is in [Core limits](#core-limits). Nothing is paid.
- A request that matches the mandate but is denied by the spend rules (`tier2_deny`, for example a payee that is not on the list) still uses up its job and its share of the budget, and nothing is paid. In Run F two such requests took a 1 NEAR budget down to 0.49 NEAR: [3bCCcBYnYgjY9Xsmh4YcWyPfvNkbQ4k7Nv6LD1UUaeWB](https://testnet.nearblocks.io/txns/3bCCcBYnYgjY9Xsmh4YcWyPfvNkbQ4k7Nv6LD1UUaeWB) and [F3JaX4UfHJK2ziKzVzqcXTCuz6bwJKW4PmLWVgLLNYVr](https://testnet.nearblocks.io/txns/F3JaX4UfHJK2ziKzVzqcXTCuz6bwJKW4PmLWVgLLNYVr).
- `record_block` stores one counter per distinct (reason, action, target), and the event log keeps the action and target strings. Storage grows. The contract account pays for it. The 2026-11-14 sandbox numbers and the recovery (a plain NEAR transfer of the shortfall, not `deposit()`, then withdraw) are in [Core limits](#core-limits).
- If the node refuses a call before it enters a block (for example `NotEnoughBalance`), the agent module reports `rpc_uncertain` ("The send result is unknown. Do not resend.") although nothing was sent.
- If the archival RPC node does not answer within 8 seconds (`CHOPGATE_RPC_TIMEOUT_MS`), the agent module stops before sending and reports `rpc_preflight` ("Status could not be read before sending. Nothing was sent.").
- The gate address comes from the calling account's name (first 80 bits of its sha256), not the owner key; one gate per account per factory; a targeted collision takes about 2^80 tries.
- Attack 4 uses the held payments already on the test gate (ids 1-2, past their one-hour deadline but not removed; hold 3 was removed with `expire_pending`). Attack 4 sends `approve_pending` for hold 1 with a forged owner signature. Hold 1 is still stored on the gate (past its deadline), and the gate checks the signature before the deadline, so the expected result is a failed transaction, `invalid pending signature`, paid 0 (seen twice in the wallet popup; links in [Run C](docs/RUNS.md#run-c)). If someone removes hold 1 with `expire_pending`, the same button shows `unknown or resolved pending`, paid 0.
- The stamp key is stored in this browser, unencrypted. Anyone with access to this browser profile, or a script running on this page, can copy it. Testnet only.
- The stamp key is stored separately for each site address. On another address (including the public address and the subdomain) you must import the backup file. (한국어: 도장 키는 사이트 주소마다 따로 저장됩니다. 다른 주소(공개 주소와 서브도메인 포함)에서는 백업 파일을 가져와야 합니다.)
- A withdrawal carries a number that must be higher than the last one. The Console takes it from the value saved in this browser. The withdrawal-number lookup reads up to 200 indexed transactions (one page of the FastNEAR transaction index). The Console history view shows the latest 8. If an older withdrawal lies beyond that page and this browser has no saved value, the gate refuses the first try as a replay; the Console raises the number by one on the next try. That case was not run on testnet.
- After you import a stamp key from a backup file, the Console keeps Deposit and Withdraw locked until you press Download backup once in that browser.
- The wallet list is a local copy of the NEAR Connect manifest with 6 wallets (meteor-wallet, intear-wallet, ledger, nightly-wallet, ethereum-wallets, near-cli). Signing in the wallet window was tested with Intear. Meteor was checked up to the mainnet-account notice. At run time NEAR Connect loads each wallet's connector script from the URL in that manifest. Intear's script is `https://wallet.intear.tech/near-selector.js` and opens `wallet.intear.tech` in a frame. Those scripts are not in this repository and are not pinned.
- Commit ids quoted in `docs/` come from the private development history and are not in this repository. This repository starts from a single snapshot commit.
- The hosted demo is built from `site/`. `docs/index.html` is an earlier copy of the Proof page that `./check.sh` reads; it is not the hosted page and has no wallet demo.

Gate and factory access keys, including the key-deletion transactions, are in [Gate account keys](docs/RUNS.md#gate-account-keys).

If `create_gate` fails, the factory sends the deposit back to the caller. If the caller's account is deleted before the refund arrives, or the refund still fails on the sixth attempt (`refund_stuck`), the amount stays on the factory account and no method can take it out. Neither case was reproduced in the sandbox.

Each gate keeps a 0.1 NEAR storage reserve (10,000 bytes). One reserve is shared by four kinds of record, and alone it would cover about 30 mandate registrations, or 41 refused-request records, or 151 holds, or 357 payments. When it runs out, `register`, payment requests and holds fail with `LackBalanceForState`; a payment or withdrawal that fails returns its amount to escrow. A local sandbox run on 2026-11-14 grew storage until withdrawing the full escrow failed with `LackBalanceForState`, about 0.028 NEAR short. Calling `deposit()` does not fix it. A plain NEAR transfer of the shortfall to the gate account, not `deposit()`, does; then the full withdrawal succeeded. See [Core limits](#core-limits).

The factory checks only that `owner_public_key` is an ed25519 key of 32 bytes that are not all zero. It does not check that the bytes are a valid curve point. Nobody can sign for a gate created with such a key, and its deposit is not refunded.

Not proven:

- a late or stuck factory refund (`refund_stuck`) actually occurring;
- creating a gate with a key that is not a valid curve point;
- the coverage counts for that 0.1 NEAR reserve (about 30, 41, 151 and 357 records), and a real 80-bit gate-name collision.

More detail: [DETAILS](docs/DETAILS.md), [CLAIMS](CLAIMS.md), [scenes](docs/DEMO-SCENES.md), [receipt](docs/RECEIPT.md).

## Hackathon tracks

### Security

| Requirement | Status | Evidence |
|---|---|---|
| Four Signals | Partial | The gate records a reason code when a request has no mandate, a foreign owner key, an amount over the limit, or a payee off the list ([Run C](docs/RUNS.md#run-c), [Run D](docs/RUNS.md#run-d)). The docs do not define four named Signals. |
| When a signal says warn, ask a human | Partial | A payment above the review amount is held until the owner approves it ([Run D](docs/RUNS.md#run-d), [Run F](docs/RUNS.md#run-f)). Judge p(yes) from 0.50 up to 0.90 goes to human approval ([judge model](docs/DETAILS.md#judge-model)). There is no signal named warn. |
| A log of a prompt-injected agent | Partial | Run F record F9 refused an instruction the owner did not sign (`unsigned_instruction`, [CY8x4yoDCrQnk6piEmJDh7XrZ4oZWNf7NHGUUSvpzAaV](https://testnet.nearblocks.io/txns/CY8x4yoDCrQnk6piEmJDh7XrZ4oZWNf7NHGUUSvpzAaV), [Run F](docs/RUNS.md#run-f)). Run D record D2 refused a swapped recipient (`out_of_scope`, [J8TLYrzG3rAXefjMKbYNXYQ49A6Hm1UPLx1XmtGUmiFN](https://testnet.nearblocks.io/txns/J8TLYrzG3rAXefjMKbYNXYQ49A6Hm1UPLx1XmtGUmiFN), [Run D](docs/RUNS.md#run-d)). In a local test on 2026-11-14, an LLM agent refused an injected notice. In a later try with the MCP server connected, it ignored an injected payee in an invoice and called `chopgate_pay` once to the mandate payee. The result was `rpc_uncertain`, and the transaction was not observed on chain. No gate refusal was produced. |
| Function-call key and its limits | Met | One function-call key for `authorize_and_pay_tiered`. It cannot send NEAR, call another method, or attach a deposit ([How the agent holds its keys](#how-the-agent-holds-its-keys), [Limits of that key](#limits-of-that-key), [Run D](docs/RUNS.md#run-d)). |

### Agents

| Requirement | Status | Evidence |
|---|---|---|
| How the agent holds its keys | Met | The key file is mode 600, outside this repository. A full-access key is refused ([Agent key](agent/README.md#agent-key), [How the agent holds its keys](#how-the-agent-holds-its-keys)). |
| Spending within a budget | Met | A mandate has a total budget. Requests over it pay nothing (`budget_exceeded` in [What the tests show](#what-the-tests-show)). Run D paid 0.01 NEAR inside the mandate ([Run D](docs/RUNS.md#run-d)). |
| A receipt per task | Partial | Each pay call returns a verdict, a reason code, and an explorer link ([Agent steps](#agent-steps), [Run F](docs/RUNS.md#run-f)). A judged request writes a receipt ([JEV live connection](docs/DETAILS.md#jev-live-connection)). A daily receipt is not shown. |
| NEAR Intents, USDC, negotiation, hiring other agents | Not done | This repository does not show NEAR Intents, USDC, negotiation, or hiring other agents. |

[HACKATHON.md](HACKATHON.md) has the summary.

## Libraries

- In the contract wasm: `near-sdk` 5.24.1 (the only direct dependency) and the crates it pulls in.
- Tests and demos only (dev-dependencies, not in the wasm): `near-workspaces` 0.22.1, `tokio`, `serde_json`, `anyhow`, `ed25519-dalek` 2, `rand` 0.8, `bs58`, `hex`, `sha2` and `reqwest` 0.12. Exact versions are in `Cargo.lock`.
- Exactly 12 test-only places use `SigningKey::from_bytes(&[N; 32])` with a constant byte, in `src/lib.rs` (inside `#[cfg(test)] mod unit_tests`), `tests/attack_suite_a.rs`, `tests/attack_suite_b.rs` and `tests/pending_sig_negative.rs`; none is compiled into the contract wasm, and none is a NEAR account key.
- Web app (`webapp/`) and `docs/receipt-viewer.html`: plain HTML, CSS and JavaScript; the UI tests use Node's built-in `node:test`. No npm packages.
- Hosted demo (`site/`): plain HTML, CSS and JavaScript modules, no build step. One third-party file is bundled for the wallet selector: NEAR Connect 0.12.0 (`site/assets/vendor/near-connect-0.12.0.bundle.mjs`, with a copy in `site/verify/nc/`; npm package `@hot-labs/near-connect`, source https://github.com/hot-dao/near-selector, MIT). That file includes `@noble/ed25519` 2.3.0 (MIT). The wallet list `site/assets/vendor/near-connect-wallets-testnet.json` is a local copy of the NEAR Connect manifest with 6 testnet wallets. The fonts (Sora, Michroma, IBM Plex Sans, IBM Plex Mono) are bundled under the SIL Open Font License 1.1 (`site/assets/fonts/`). License texts are in [NOTICE](NOTICE).
- Agent (`agent/`): Node.js 22.22.2 or later; dependencies are listed in `agent/package.json` (`@modelcontextprotocol/sdk` 1.32.2, `near-api-js` 7.5.3, `zod` 3.25.76).
- Tooling: Rust 1.86.0, cargo-near 0.20.3, near-sandbox 2.13.4, Node.js 24 (UI tests).

## License

Apache License 2.0, see [LICENSE](LICENSE). Third-party notices are in [NOTICE](NOTICE).
