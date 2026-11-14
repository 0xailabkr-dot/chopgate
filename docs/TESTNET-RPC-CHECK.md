# Testnet public-RPC check

These tables transcribe the saved public testnet RPC outputs for Run A (deterministic rules) and Run B (live judge). They were produced using `https://rpc.testnet.near.org`, method `tx` with `wait_until: FINAL`, and `query` with `request_type: view_code` at `finality: final`. Each table lists the transaction hash and signer, which is all you need to repeat the queries.

Anyone can re-run the read-only queries with the standalone Python 3 script (standard library only):

```bash
python3 scripts/rpc-check.py docs/TESTNET-RPC-CHECK.md
python3 scripts/rpc-check.py docs/TESTNET-RPC-CHECK.md --view-code gater2.cg-tn1-a3r-e8a6d1a3.testnet
python3 scripts/rpc-check.py docs/TESTNET-RPC-CHECK.md --view-code gatej2.cg-tn1-jev-9da8c302.testnet
```

Alternatively pass a TSV with two columns, transaction hash and signer (optional header `tx_hash` and `signer`). No keys are used and no transactions are submitted. Re-running requires network access to the public RPC.

`FINAL` describes finality; `SuccessValue` and `Failure` describe execution outcomes. Reason codes are decoded from the on-chain return value (`SuccessValue`). Refusals are successful calls whose return value carries the reason code. Balances are not in these tables; the payout receipts for the paid scenes are listed after the Run B table. A dash means no JSON reason code was returned; failure text is shown for failed calls. Each run's negative approval fails with `invalid pending signature`. Run B's scene-1 negative reused the original nonce, so it does not isolate the signature check.

## Run A

22 transactions including the owner account creation, all final.

| Scene | Step | Transaction hash | Final status | Outcome | Reason code (from SuccessValue) | Signer | Receiver |
|---|---|---|---|---|---|---|---|
| Pre-run | faucet create owner | 3zqHaiApUDPQmxLeY3mAHDSoZ3ApJWBphEDftSV62m9X | FINAL | SuccessValue | - | testnet | cg-tn1-a3r-e8a6d1a3.testnet |
| Setup | create gate subaccount | JAf6QVycKefkWhgFCYtJAJ9MDBViPUxhRHSLhjMFMYFN | FINAL | SuccessValue | - | cg-tn1-a3r-e8a6d1a3.testnet | gater2.cg-tn1-a3r-e8a6d1a3.testnet |
| Setup | create agent subaccount | EhaZh5UeHMq2FrswQA4px5Tv3tE5o68tzwxMjk9wR7Ge | FINAL | SuccessValue | - | cg-tn1-a3r-e8a6d1a3.testnet | agentr2.cg-tn1-a3r-e8a6d1a3.testnet |
| Setup | create payee subaccount | GwZfuhP1aNSmDHXwobmRCX3zLPT9zJYusAt58b61PMvy | FINAL | SuccessValue | - | cg-tn1-a3r-e8a6d1a3.testnet | payeer2.cg-tn1-a3r-e8a6d1a3.testnet |
| Setup | deploy wasm | 8sDwHXXNDMApRzG7y5kqoZkEP5MQhiinbk95B7rvbyZ3 | FINAL | SuccessValue | - | gater2.cg-tn1-a3r-e8a6d1a3.testnet | gater2.cg-tn1-a3r-e8a6d1a3.testnet |
| Setup | init new() | 77ek18GN73kv3VE3tn5b911J2NbeU5d5TkwLkUoBCGd4 | FINAL | SuccessValue | - | gater2.cg-tn1-a3r-e8a6d1a3.testnet | gater2.cg-tn1-a3r-e8a6d1a3.testnet |
| Setup | deposit 0.3 NEAR escrow | BFGhrJC1WHdaAw43bWC5doNETiYFanzWkPCWcsBdMr8P | FINAL | SuccessValue | - | cg-tn1-a3r-e8a6d1a3.testnet | gater2.cg-tn1-a3r-e8a6d1a3.testnet |
| Setup | set_tier2_config threshold 0.05 NEAR (owner-signed) | 78Qf1NS5Fc1xsVnvRsx39Qbvc2Lgvi6xRRinFja47BaV | FINAL | SuccessValue | - | agentr2.cg-tn1-a3r-e8a6d1a3.testnet | gater2.cg-tn1-a3r-e8a6d1a3.testnet |
| Setup | register mandate serial 1 (owner-signed) | 82hVvwabYnrRkypRxdFFcr35ee9FJoA11VeGTqfrAFj3 | FINAL | SuccessValue | allowed | agentr2.cg-tn1-a3r-e8a6d1a3.testnet | gater2.cg-tn1-a3r-e8a6d1a3.testnet |
| Setup | register mandate serial 2 (owner-signed) | EWpBojm36E8NR1PoUpMvLh8xWB63uj4ic5ELbUmfLcT6 | FINAL | SuccessValue | allowed | agentr2.cg-tn1-a3r-e8a6d1a3.testnet | gater2.cg-tn1-a3r-e8a6d1a3.testnet |
| Setup | register mandate serial 3 (owner-signed) | 61y6TNrYPx3fau1atm5JBC6DvsRdW2V77aB15qmFabRL | FINAL | SuccessValue | allowed | agentr2.cg-tn1-a3r-e8a6d1a3.testnet | gater2.cg-tn1-a3r-e8a6d1a3.testnet |
| Setup | register mandate serial 4 (owner-signed) | DtWU3xUoUpREmKXgK9e65AzsWWsJnjfaZqe7oqrW5rV8 | FINAL | SuccessValue | allowed | agentr2.cg-tn1-a3r-e8a6d1a3.testnet | gater2.cg-tn1-a3r-e8a6d1a3.testnet |
| Setup | register mandate serial 5 (owner-signed) | Ad8PGSdzHCgn2FUd8Qtf2oJkKStiu1pXTZyrRtozVaRW | FINAL | SuccessValue | allowed | agentr2.cg-tn1-a3r-e8a6d1a3.testnet | gater2.cg-tn1-a3r-e8a6d1a3.testnet |
| 1 normal payment | authorize_and_pay_tiered 0.01 NEAR, signed instruction | YMhtFDUFTPuG3FSBFAnBsGevJuNs3yaz7dU8VmVdF7H | FINAL | SuccessValue | allowed | agentr2.cg-tn1-a3r-e8a6d1a3.testnet | gater2.cg-tn1-a3r-e8a6d1a3.testnet |
| 2 instruction outside signed mandate refused | authorize_and_pay_tiered with instruction not in signed mandate | 2BrrGmpfuoiMEEgrDdZxKvzvwVWhfBn3Krpu1ZVxVaz2 | FINAL | SuccessValue | unsigned_instruction | agentr2.cg-tn1-a3r-e8a6d1a3.testnet | gater2.cg-tn1-a3r-e8a6d1a3.testnet |
| 3 owner impersonation refused | attacker account registers mandate signed by its own key | 9HmBVt44uCfnyQhekGCamYiBZQWMY2GxVWrim2GPG8jY | FINAL | SuccessValue | owner_impersonation | cg-tn1-attacker-0626733e.testnet | gater2.cg-tn1-a3r-e8a6d1a3.testnet |
| 3 owner impersonation refused | attacker account claims owner public key with forged signature | CKRvg2yXeQcDJXEWf6CGRuEE6YJrCB4bWsVCNukmrhx | FINAL | SuccessValue | invalid_signature | cg-tn1-attacker-0626733e.testnet | gater2.cg-tn1-a3r-e8a6d1a3.testnet |
| 3 owner impersonation refused | attacker account calls agent's mandate serial 3 | BSeUm4GYryFsrAyRMnRXL2rjwSyty5BzcDK4bsKG4W4o | FINAL | SuccessValue | wrong_caller | cg-tn1-attacker-0626733e.testnet | gater2.cg-tn1-a3r-e8a6d1a3.testnet |
| 4 over-limit payment refused | authorize_and_pay_tiered 0.02 NEAR over 0.01 entry limit | 5KG3WK6ntCKYHPzmhvKUQ5ha7FXwQGZQg7KWTW2k9nn5 | FINAL | SuccessValue | entry_limit_exceeded | agentr2.cg-tn1-a3r-e8a6d1a3.testnet | gater2.cg-tn1-a3r-e8a6d1a3.testnet |
| 5 payment after human approval | authorize_and_pay_tiered 0.08 NEAR above 0.05 threshold | Fn43pxJbw8YpiAwSEKkDbFrTM9fEATPuFx1CVJpdCgnm | FINAL | SuccessValue | tier2_escalate | agentr2.cg-tn1-a3r-e8a6d1a3.testnet | gater2.cg-tn1-a3r-e8a6d1a3.testnet |
| 5 negative approval signature | approve_pending signed by a different key over the exact payload (expect failure) | Be1EYYjXWe1Hz4TSpTRy9ZACrMsRznQEen9JZx7QHCzn | FINAL | Failure | Failure: invalid pending signature | agentr2.cg-tn1-a3r-e8a6d1a3.testnet | gater2.cg-tn1-a3r-e8a6d1a3.testnet |
| 5 payment after human approval | approve_pending with owner signature over request hash | 3snsdMbuhZXbbZmtLPpUPozQ8MqCRWJLBk8Jz1DfrDeN | FINAL | SuccessValue | - | agentr2.cg-tn1-a3r-e8a6d1a3.testnet | gater2.cg-tn1-a3r-e8a6d1a3.testnet |

`view_code` at finality `final`, account `gater2.cg-tn1-a3r-e8a6d1a3.testnet`: bytes `538072`, sha256 `14da3c88d9034b87d429554513b5289c4303ffaf21a06123491bcd85dc971771`, code_hash `2QQAUeG61PtyTKLFLXMScNELTWh9b6oWMJ6B2uCQDsD2`.

## Run B

19 transactions including the owner account creation, all final.

| Scene | Step | Transaction hash | Final status | Outcome | Reason code (from SuccessValue) | Signer | Receiver |
|---|---|---|---|---|---|---|---|
| Pre-run | faucet create owner | xJrRRwzpKSnJBVWpCf5TtNRTKd6cke7aUMggZ6psLEa | FINAL | SuccessValue | - | testnet | cg-tn1-jev-9da8c302.testnet |
| Setup | create gate subaccount | G5bPZxYsBQvc1jsVbubKHSY52hpzf84WrFVBESdELGoq | FINAL | SuccessValue | - | cg-tn1-jev-9da8c302.testnet | gatej2.cg-tn1-jev-9da8c302.testnet |
| Setup | create agent subaccount | 5TTeucrbaPPbEFE4o8toAZ99SYSLGzaoNnyxnje4fVez | FINAL | SuccessValue | - | cg-tn1-jev-9da8c302.testnet | agentj2.cg-tn1-jev-9da8c302.testnet |
| Setup | create payee subaccount | JEDk5f1sNvMEfU1gwniXUTpU3Dt2xU1eULQ6p2WHiUHK | FINAL | SuccessValue | - | cg-tn1-jev-9da8c302.testnet | payeej2.cg-tn1-jev-9da8c302.testnet |
| Setup | deploy wasm | ARufsfgjtTSFbLXyMTGMxEFuDujq4y1rZcPgdoSitH15 | FINAL | SuccessValue | - | gatej2.cg-tn1-jev-9da8c302.testnet | gatej2.cg-tn1-jev-9da8c302.testnet |
| Setup | init new() | HikLozcC2URQR6vYpc5qq5FCPDAcpmnDg2PPtGhchdDW | FINAL | SuccessValue | - | gatej2.cg-tn1-jev-9da8c302.testnet | gatej2.cg-tn1-jev-9da8c302.testnet |
| Setup | deposit 0.3 NEAR escrow | 9BGb5uuC8KWg5SJgMj6V4nVeCWuh2WSG3QptTR4sB8AY | FINAL | SuccessValue | - | cg-tn1-jev-9da8c302.testnet | gatej2.cg-tn1-jev-9da8c302.testnet |
| Setup | set_tier2_config threshold 0.05 NEAR (owner-signed) | 3Aq77ZxrvNqeLqBvEEoxk3ENgc3r4HdF4wFwJsR1Fvtm | FINAL | SuccessValue | - | agentj2.cg-tn1-jev-9da8c302.testnet | gatej2.cg-tn1-jev-9da8c302.testnet |
| Setup | set_judge_policy: register JEV judge key (owner-signed) | Fa1HpQRNcnMKZaNKmZmwChkaTimRxZF5YFkn3Y9YX6Nm | FINAL | SuccessValue | - | agentj2.cg-tn1-jev-9da8c302.testnet | gatej2.cg-tn1-jev-9da8c302.testnet |
| Setup | register mandate serial 1 (owner-signed) | FdAAEFnsPkgPRgbjFPbAf4jEXrM8UekaoY8T7pLq2R4J | FINAL | SuccessValue | allowed | agentj2.cg-tn1-jev-9da8c302.testnet | gatej2.cg-tn1-jev-9da8c302.testnet |
| Setup | register mandate serial 11 (owner-signed) | AEEFLs2aZuAGdMXLYMLyPTwmV8XdZwMtFwJDd4r2D6rg | FINAL | SuccessValue | allowed | agentj2.cg-tn1-jev-9da8c302.testnet | gatej2.cg-tn1-jev-9da8c302.testnet |
| Setup | register mandate serial 4 (owner-signed) | AC554SY4GqETEbX8oMoejWvZfKKvUqVgDvwKJaYPwKgB | FINAL | SuccessValue | allowed | agentj2.cg-tn1-jev-9da8c302.testnet | gatej2.cg-tn1-jev-9da8c302.testnet |
| Setup | register mandate serial 5 (owner-signed) | BeWw4pBKEuE7xArpzMVCSwoet7aLU75ebBH3fDwyNKRZ | FINAL | SuccessValue | allowed | agentj2.cg-tn1-jev-9da8c302.testnet | gatej2.cg-tn1-jev-9da8c302.testnet |
| 1 normal payment (JEV) | authorize_and_pay_dual 0.01 NEAR with signed live JEV report | 5jKyD4pijamkUG1S5rT1ZjeiLiX9LXC2tY6DXpCPMFCv | FINAL | SuccessValue | allowed | agentj2.cg-tn1-jev-9da8c302.testnet | gatej2.cg-tn1-jev-9da8c302.testnet |
| 1 negative: re-pointed JEV report | authorize_and_pay_dual serial 11 with a re-pointed copy of the scene-1 JEV report (stale signature, original nonce reused) | HcJCv5AepZRRPaKamxk8pGPCzrNVpKBnDn3FSzBwcQ8A | FINAL | SuccessValue | tier2_escalate | agentj2.cg-tn1-jev-9da8c302.testnet | gatej2.cg-tn1-jev-9da8c302.testnet |
| 4 over-limit payment refused (JEV) | authorize_and_pay_dual 0.02 NEAR over 0.01 entry limit with live JEV report | 7Tcypc346TsBRvncodHiX74rWp7CJ83366Gu4jJNK7ux | FINAL | SuccessValue | entry_limit_exceeded | agentj2.cg-tn1-jev-9da8c302.testnet | gatej2.cg-tn1-jev-9da8c302.testnet |
| 5 human approval (JEV) | authorize_and_pay_dual 0.08 NEAR above 0.05 human-review amount with live JEV report | Bbtz2nUBy5EumKyFLm3tEejucmJvoPLdrFoSBUxrmPkc | FINAL | SuccessValue | tier2_escalate | agentj2.cg-tn1-jev-9da8c302.testnet | gatej2.cg-tn1-jev-9da8c302.testnet |
| 5 negative approval signature | approve_pending signed by a different key over the exact payload (expect failure) | 6pxdFLzkgh1ckJHvBTpBq8CaeoYbuWqAKdBHcdWTGQaa | FINAL | Failure | Failure: invalid pending signature | agentj2.cg-tn1-jev-9da8c302.testnet | gatej2.cg-tn1-jev-9da8c302.testnet |
| 5 payment after human approval | approve_pending with owner signature over request hash | 6gTqLx9oVTyE2287kDbyZweHDrqEq3TwuyKKKpd9bmEw | FINAL | SuccessValue | - | agentj2.cg-tn1-jev-9da8c302.testnet | gatej2.cg-tn1-jev-9da8c302.testnet |

`view_code` at finality `final`, account `gatej2.cg-tn1-jev-9da8c302.testnet`: bytes `537066`, sha256 `6e20ac13c62f77ecec9b6adbc48bf6cb52d818f9251ac797fc6581a0b18c1c1e`, code_hash `8Qtk3jf4RLpfiB7PeXeuPGYcp4USV2yeN5Zn3d5NpAMj`.

## Payout receipts

Read with `EXPERIMENTAL_tx_status` (`wait_until: FINAL`) on `https://rpc.testnet.near.org`. Each paid scene has a `Transfer` receipt from the gate contract to the payee and a `payout_settled` event from the `on_payout` callback.

- Run A scene 1 `YMhtFDUFTPuG3FSBFAnBsGevJuNs3yaz7dU8VmVdF7H`: receipt `Bz5mCJs8gRqDoHnKZsWtJr8D316cHZf6oF1w1ydtTs5c`, Transfer 10000000000000000000000 yoctoNEAR (0.01 NEAR) `gater2.cg-tn1-a3r-e8a6d1a3.testnet` → `payeer2.cg-tn1-a3r-e8a6d1a3.testnet`.
- Run A scene 5 owner approval `3snsdMbuhZXbbZmtLPpUPozQ8MqCRWJLBk8Jz1DfrDeN`: receipt `9RcVWUL4DP3TQPpNxASSmwR715ehJYSKRVk4SkQdnygs`, Transfer 80000000000000000000000 yoctoNEAR (0.08 NEAR) `gater2.cg-tn1-a3r-e8a6d1a3.testnet` → `payeer2.cg-tn1-a3r-e8a6d1a3.testnet`.
- Run B scene 1 `5jKyD4pijamkUG1S5rT1ZjeiLiX9LXC2tY6DXpCPMFCv`: receipt `94fyv9q2FYf9naJhVyHu48Qj6YScLD98oBhvhL1Pwe47`, Transfer 10000000000000000000000 yoctoNEAR (0.01 NEAR) `gatej2.cg-tn1-jev-9da8c302.testnet` → `payeej2.cg-tn1-jev-9da8c302.testnet`.
- Run B scene 5 owner approval `6gTqLx9oVTyE2287kDbyZweHDrqEq3TwuyKKKpd9bmEw`: receipt `E9BYohAyVbDxCBS3QiVKHEM3znErAiW9vXi8KjiJ6biX`, Transfer 80000000000000000000000 yoctoNEAR (0.08 NEAR) `gatej2.cg-tn1-jev-9da8c302.testnet` → `payeej2.cg-tn1-jev-9da8c302.testnet`.

Event lines from the same transactions (`payout_settled`, quoted as logged):

- `YMhtFDUFTPuG3FSBFAnBsGevJuNs3yaz7dU8VmVdF7H`: `{"event":"payout_settled","data":[{"serial":1,"recipient":"payeer2.cg-tn1-a3r-e8a6d1a3.testnet","amount":"10000000000000000000000","escrow_balance":"290000000000000000000000"}]}`
- `3snsdMbuhZXbbZmtLPpUPozQ8MqCRWJLBk8Jz1DfrDeN`: `{"event":"payout_settled","data":[{"serial":5,"recipient":"payeer2.cg-tn1-a3r-e8a6d1a3.testnet","amount":"80000000000000000000000","escrow_balance":"210000000000000000000000"}]}`
- `5jKyD4pijamkUG1S5rT1ZjeiLiX9LXC2tY6DXpCPMFCv`: `{"event":"payout_settled","data":[{"serial":1,"recipient":"payeej2.cg-tn1-jev-9da8c302.testnet","amount":"10000000000000000000000","escrow_balance":"290000000000000000000000"}]}`
- `6gTqLx9oVTyE2287kDbyZweHDrqEq3TwuyKKKpd9bmEw`: `{"event":"payout_settled","data":[{"serial":5,"recipient":"payeej2.cg-tn1-jev-9da8c302.testnet","amount":"80000000000000000000000","escrow_balance":"200000000000000000000000"}]}`

## Refusals and holds: no Transfer receipt

Read with `EXPERIMENTAL_tx_status` on `https://archival-rpc.testnet.near.org` (read only). None of these transactions has a `Transfer` receipt other than the system gas refund, and none logs `payout_settled`:

- Run A: `2BrrGmpfuoiMEEgrDdZxKvzvwVWhfBn3Krpu1ZVxVaz2` (`unsigned_instruction`), `9HmBVt44uCfnyQhekGCamYiBZQWMY2GxVWrim2GPG8jY` (`owner_impersonation`), `CKRvg2yXeQcDJXEWf6CGRuEE6YJrCB4bWsVCNukmrhx` (`invalid_signature`), `BSeUm4GYryFsrAyRMnRXL2rjwSyty5BzcDK4bsKG4W4o` (`wrong_caller`), `5KG3WK6ntCKYHPzmhvKUQ5ha7FXwQGZQg7KWTW2k9nn5` (`entry_limit_exceeded`), `Fn43pxJbw8YpiAwSEKkDbFrTM9fEATPuFx1CVJpdCgnm` (`tier2_escalate`, hold), `Be1EYYjXWe1Hz4TSpTRy9ZACrMsRznQEen9JZx7QHCzn` (failed approval).
- Run B: `HcJCv5AepZRRPaKamxk8pGPCzrNVpKBnDn3FSzBwcQ8A` (`tier2_escalate`, hold), `7Tcypc346TsBRvncodHiX74rWp7CJ83366Gu4jJNK7ux` (`entry_limit_exceeded`), `Bbtz2nUBy5EumKyFLm3tEejucmJvoPLdrFoSBUxrmPkc` (`tier2_escalate`, hold), `6pxdFLzkgh1ckJHvBTpBq8CaeoYbuWqAKdBHcdWTGQaa` (failed approval).

## Judge fields in event logs

Read with `EXPERIMENTAL_tx_status` (`wait_until: FINAL`) on `https://rpc.testnet.near.org`. Fields quoted from the contract's `tier2_decision` event (`EVENT_JSON`, standard `chopgate`) and from the function-call arguments.

- Run B scene 1 `5jKyD4pijamkUG1S5rT1ZjeiLiX9LXC2tY6DXpCPMFCv` (`authorize_and_pay_dual`): event `"report_authenticated":true,"source_q_permille":980,"threshold":900,"mode":"jev-live;model=jev-1.14.0;request_id=req_01a1ce75c551767195dd2e0252c6da17;p_yes=0.9800","verdict":"pass"`.
- Run B scene-1 negative `HcJCv5AepZRRPaKamxk8pGPCzrNVpKBnDn3FSzBwcQ8A` (`authorize_and_pay_dual`, serial 11): event `"report_authenticated":false,"source_q_permille":null,"mode":"none","verdict":"escalate"`, followed by `pending_created` (id 1, 0.01 NEAR).
- Run B scene 4 `7Tcypc346TsBRvncodHiX74rWp7CJ83366Gu4jJNK7ux` (`authorize_and_pay_dual`): no `tier2_decision` event (refused with `entry_limit_exceeded` first); the arguments carry `"mode":"jev-live;model=jev-1.14.0;request_id=req_01a1ce7647517e2db7d933378523ee86;p_yes=0.0600"`.
- Run B scene 5 `Bbtz2nUBy5EumKyFLm3tEejucmJvoPLdrFoSBUxrmPkc` (`authorize_and_pay_dual`): event `"lock":"2c","report_authenticated":true,"source_q_permille":980,"threshold":900,"mode":"jev-live;model=jev-1.14.0;request_id=req_01a1ce7680cb763f9dd70317e72567c4;p_yes=0.9800","verdict":"escalate"`, followed by `pending_created` (id 2, 0.08 NEAR).

## Open holds

`query` with `request_type: call_function`, method `pending_items`, `finality: final`, read on 2026-11-12 after both runs (id, serial, amount in yoctoNEAR):

- `gatej2.cg-tn1-jev-9da8c302.testnet`: id 1, serial 11, 10000000000000000000000 (0.01 NEAR).
- `gatej1.cg-tn1-jev-b81933d0.testnet` (earlier incomplete run): id 1, serial 11, 10000000000000000000000 (0.01 NEAR); id 2, serial 5, 80000000000000000000000 (0.08 NEAR).
- `gater2.cg-tn1-a3r-e8a6d1a3.testnet`: none.
