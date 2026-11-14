# ChopGate: testnet runs

The gate wasm was rebuilt from this repository's files with the step 4 command on 2026-11-14 and gave the same sha256 as the code deployed in Run B. Run C, Run D and the gates of Run E, Run F and Run G show that code hash on chain. Why Run A differs: [full tables](DETAILS.md#testnet-runs-a-and-b-full-tables).

Runs A and B are in [DETAILS](DETAILS.md#testnet-runs-a-and-b-full-tables).

## Run C

Gate `gatec.chopgate-runc-cc790216.testnet`. Code hash `8Qtk3jf4RLpfiB7PeXeuPGYcp4USV2yeN5Zn3d5NpAMj`.

Each attack was signed twice in the Intear wallet popup (`wallet.intear.tech`) by `cgw3-ll5tpm.testnet`: attack 1: [6KgX8YMVc8E2FfQ8DWxX4cdjzaF2kTm9oULrskq6sf9t](https://testnet.nearblocks.io/txns/6KgX8YMVc8E2FfQ8DWxX4cdjzaF2kTm9oULrskq6sf9t) and [634QFtj7X24BvDbmPMsPRxnRXvuGGVpNbzduzR6yrjW1](https://testnet.nearblocks.io/txns/634QFtj7X24BvDbmPMsPRxnRXvuGGVpNbzduzR6yrjW1); attack 2: [4bbZJgYyy6nB3pQ7tkZtAoJrQyCzZKdB2MRXAKv88Y3o](https://testnet.nearblocks.io/txns/4bbZJgYyy6nB3pQ7tkZtAoJrQyCzZKdB2MRXAKv88Y3o) and [JAVxkcrPifaNTzBAbpqQwXUVihn6rFECyR3wzmarhtqh](https://testnet.nearblocks.io/txns/JAVxkcrPifaNTzBAbpqQwXUVihn6rFECyR3wzmarhtqh); attack 3: [DjKSLhq6h2BVvVL2wqZVBWUwCu5Qkyr7J58NAPRgJ5w4](https://testnet.nearblocks.io/txns/DjKSLhq6h2BVvVL2wqZVBWUwCu5Qkyr7J58NAPRgJ5w4) and [AfhephhXpJ1mw1JdrEV1KYMSWFsMpYT9ETb9y7TVKppo](https://testnet.nearblocks.io/txns/AfhephhXpJ1mw1JdrEV1KYMSWFsMpYT9ETb9y7TVKppo); attack 4: [9jjZmkCG14mZk3AmgZ26MCniNfEEockxTE6xZ9BgapT8](https://testnet.nearblocks.io/txns/9jjZmkCG14mZk3AmgZ26MCniNfEEockxTE6xZ9BgapT8) and [Cd82RoM23JTzAuXvuaPTqEsFYzz3r7r9aZ1yadLULuHK](https://testnet.nearblocks.io/txns/Cd82RoM23JTzAuXvuaPTqEsFYzz3r7r9aZ1yadLULuHK). Cancelling in the wallet showed "The wallet rejected the request." and sent nothing. Attack 4 uses a held payment that is still stored on the test gate; [Limitations](../README.md#limitations) says what the button shows if someone removes that hold.

## Run D

Run D gate `cg-u3g-b7f26e6c.testnet` was deployed by CLI ([DHKgERE4A7iaJ3D8XmJLn8PFjcnMyDnGyYVxe8qcMXzN](https://testnet.nearblocks.io/txns/DHKgERE4A7iaJ3D8XmJLn8PFjcnMyDnGyYVxe8qcMXzN)), same code hash as Run B. Agent: `rund2.cg-u3o-b7f26e6c.testnet`.

Created in one transaction (CreateAccount + Transfer of 1 NEAR + AddKey FunctionCall): [C2KPATFJbPG6RyZ36AEHg29vjRwY8qnKVWoQA3jmCpxG](https://testnet.nearblocks.io/txns/C2KPATFJbPG6RyZ36AEHg29vjRwY8qnKVWoQA3jmCpxG).

D4 was sent only after an explicit confirmation flag. The wrapper does not sign until the caller passes confirm_freeze_risk: true. In this run the test operator set it; no person pressed a button.

| Scene | What | Result | Transaction |
|---|---|---|---|
| D1 | normal pay, 0.01 NEAR | `allowed`; payee +0.01 NEAR | [55LaWnQDJVY6oexuBENMUQuT6c8c8eq7rauZCqX42Ahe](https://testnet.nearblocks.io/txns/55LaWnQDJVY6oexuBENMUQuT6c8c8eq7rauZCqX42Ahe) |
| D2 | swapped recipient | `out_of_scope`; payee delta 0 | [J8TLYrzG3rAXefjMKbYNXYQ49A6Hm1UPLx1XmtGUmiFN](https://testnet.nearblocks.io/txns/J8TLYrzG3rAXefjMKbYNXYQ49A6Hm1UPLx1XmtGUmiFN) |
| D3 | over the entry limit | `entry_limit_exceeded`; payee delta 0 | [9zD8NN3f5wpupWAMoMKLjepqE9hd923Ebf7Zpw9yTqm1](https://testnet.nearblocks.io/txns/9zD8NN3f5wpupWAMoMKLjepqE9hd923Ebf7Zpw9yTqm1) |
| D3b | after two refusals the next would freeze; wrapper read `blocks_in_a_row` 2 and `next_block_would_freeze` true and did not sign | `freeze_risk_not_sent`; `stop_next_block`; nothing sent | — |
| D4 | 0.5 NEAR, above the 0.3 NEAR review amount, 2026-11-14 08:07 KST; sent with confirm_freeze_risk: true (set by the test operator) | `tier2_escalate`; pending id 1; escrow 2.39 to 1.89 NEAR reserved; payee unchanged | [GfNfxdSRD5PHZTMBH82DbjE5GfG75yVSC241Udus8ogL](https://testnet.nearblocks.io/txns/GfNfxdSRD5PHZTMBH82DbjE5GfG75yVSC241Udus8ogL) |
| D5 | owner-signed `approve_pending` | `pending_approved`, `payout`, `payout_settled`; payee 10.01 to 10.51 NEAR | [DMiq47cCueqHd6ZUvjJeJoLhT8Ff8yPcdpj2Hphfnyoe](https://testnet.nearblocks.io/txns/DMiq47cCueqHd6ZUvjJeJoLhT8Ff8yPcdpj2Hphfnyoe) |
| D6 (transfer) | plain transfer with the agent key | `InvalidAccessKeyError.RequiresFullAccess`; no block | — |
| D6 (other account) | call to another account | `InvalidAccessKeyError.ReceiverMismatch`; no block | — |
| D7 | gate `withdraw_escrow` | `InvalidAccessKeyError.MethodNameMismatch`; no block | — |
| D8 | `authorize_and_pay_tiered` with 1 yoctoNEAR attached | `InvalidAccessKeyError.DepositWithFunctionCall`; no block | — |

D6-D8 entered no block. The agent key nonce stayed 277574295000003. Balances of the agent, the payee, the attacker and the gate stayed the same.

The D4 call cost the agent 0.00029 NEAR (0.998939 to 0.998647).

## Run E

Creating one gate on testnet locks 5.49566 NEAR in the new gate account. In Run E the owner account spent 5.50988 NEAR in total: 5.49566 NEAR locked in the gate and 0.01422 NEAR of gas.

Gate `g69d4c038440a403cc5ca.cg-u1f-fdf59d31.testnet`, code hash `8Qtk3jf4RLpfiB7PeXeuPGYcp4USV2yeN5Zn3d5NpAMj`.

Factory `cg-u1f-fdf59d31.testnet` (code hash `KmMxbye2PkLVWJ7dnjWGepVsccteC6pdJpnde9cCQGZ`) created the gate from the CLI: [6dn5bQFJUe1eLtNSixFmjcSuHu2QjN7KjkrRL3wTtDng](https://testnet.nearblocks.io/txns/6dn5bQFJUe1eLtNSixFmjcSuHu2QjN7KjkrRL3wTtDng), block 277598166, signer `cg-u1v-1f7640e2.testnet`; 0 access keys at block 277598236 and again at block 277616123; 5.49566 NEAR locked; 200 Tgas attached, 80.04 Tgas used.

## Run F

Run F repeats the owner and agent steps from a browser. Every owner transaction was approved in the Intear wallet popup by `cgw3-ll5tpm.testnet`; mandates, settings and approvals were signed with a stamp key made in the Console. The agent used the key file and the mandate JSON exactly as the Console gave them (only `chmod 600` was applied).

Run F requested the faucet twice without being refused, deposited 2 NEAR and funded two agent accounts: the first had 0.3 NEAR, which is not enough for the agent's calls (see [Limits of that key](../README.md#limits-of-that-key)), so a second was created with 1 NEAR.

| Step | What | Result | Transaction |
|---|---|---|---|
| F1 | Create gate from the Console (factory `create_gate`) | gate `g81c38e479450fbf416bd.cg-u1f-fdf59d31.testnet`, 0 access keys | [7fgSP1S9ZEQGnRqS18mnzhq5ESTYwVFKSENLbDPo8P1z](https://testnet.nearblocks.io/txns/7fgSP1S9ZEQGnRqS18mnzhq5ESTYwVFKSENLbDPo8P1z) |
| F2 | Deposit 2 NEAR | escrow 2 NEAR | [FvZ3FYnjetxz8D32ziGDrdwZ8jLDBNJjtuYXcJBEjvcq](https://testnet.nearblocks.io/txns/FvZ3FYnjetxz8D32ziGDrdwZ8jLDBNJjtuYXcJBEjvcq) |
| F3 | Spend rules saved: switched on, payee list empty (with an earlier Console build; the Console now refuses this, see F10) | `spend_rules_updated`, rules nonce 1 | [3JpGo4sBoV8mmhMFDifUSiTJtC1LpuB9N1SfTjy1HXFw](https://testnet.nearblocks.io/txns/3JpGo4sBoV8mmhMFDifUSiTJtC1LpuB9N1SfTjy1HXFw) |
| F4 | Review amount set to 0.3 NEAR | saved; the call logs no event, and History shows "Review settings were saved." | [HroVvgoX83hfYT3yhAz8W9jkCXPdWfrW866JGzhYDwvn](https://testnet.nearblocks.io/txns/HroVvgoX83hfYT3yhAz8W9jkCXPdWfrW866JGzhYDwvn) |
| F5 | Two `register` attempts from an earlier Console build | refused `invalid_signature`; then a failed call (the gate could not read the argument). Both were Console defects, fixed before F7 | [Bf5UNiScyWe8vFVioBzzty5ncVNDsGzLhLK4LuUp7ZJt](https://testnet.nearblocks.io/txns/Bf5UNiScyWe8vFVioBzzty5ncVNDsGzLhLK4LuUp7ZJt), [4HWN3nzYUKjPpmJLM7hhyy8iNMzmrkB88u4Mk8uTnK8Q](https://testnet.nearblocks.io/txns/4HWN3nzYUKjPpmJLM7hhyy8iNMzmrkB88u4Mk8uTnK8Q) |
| F6 | Agent account `f6d.cgw3-ll5tpm.testnet` created from the Console with 1 NEAR and one function-call key | account exists; the Console showed the key once | [BJoqecQFBfbxD8nJdXYnQpnRJ3CEuM6Zba4vDz8anE1C](https://testnet.nearblocks.io/txns/BJoqecQFBfbxD8nJdXYnQpnRJ3CEuM6Zba4vDz8anE1C) |
| F7 | Mandate registered: budget 1 NEAR | serial 1794637140734 | [9paVfErQa8oyy5Foz1caQzuETCmJUGem3Tkf8VzvQcr8](https://testnet.nearblocks.io/txns/9paVfErQa8oyy5Foz1caQzuETCmJUGem3Tkf8VzvQcr8) |
| F8 | Agent asks for 0.01 NEAR and 0.5 NEAR while the payee list is empty | refused twice, `tier2_deny` (`2b_payee_not_allowed`), paid 0; the budget went from 1 to 0.49 NEAR | [3bCCcBYnYgjY9Xsmh4YcWyPfvNkbQ4k7Nv6LD1UUaeWB](https://testnet.nearblocks.io/txns/3bCCcBYnYgjY9Xsmh4YcWyPfvNkbQ4k7Nv6LD1UUaeWB), [F3JaX4UfHJK2ziKzVzqcXTCuz6bwJKW4PmLWVgLLNYVr](https://testnet.nearblocks.io/txns/F3JaX4UfHJK2ziKzVzqcXTCuz6bwJKW4PmLWVgLLNYVr) |
| F9 | Agent sends an instruction the owner did not sign | refused, `unsigned_instruction`, paid 0 | [CY8x4yoDCrQnk6piEmJDh7XrZ4oZWNf7NHGUUSvpzAaV](https://testnet.nearblocks.io/txns/CY8x4yoDCrQnk6piEmJDh7XrZ4oZWNf7NHGUUSvpzAaV) |
| F10 | Console refuses to save rules switched on with an empty payee list; then payee `me` = `cgw3-ll5tpm.testnet` is added | first no wallet popup; then `spend_rules_updated`, rules nonce 2 | [5N31HAX2GYJMStip5ujogcGczvLFeVm63aYgnPuXaBMA](https://testnet.nearblocks.io/txns/5N31HAX2GYJMStip5ujogcGczvLFeVm63aYgnPuXaBMA) |
| F11 | A job for an account that is not on the payee list | the Console shows the reason and opens no wallet popup | — |
| F12 | New mandate registered: budget 1 NEAR, jobs of 0.01, 0.5 and 0.4 NEAR | serial 1794639429117 | [DG12XnsvkW8Bupp5eB7fViYQSd6wbA9sBXUA8aiPofSQ](https://testnet.nearblocks.io/txns/DG12XnsvkW8Bupp5eB7fViYQSd6wbA9sBXUA8aiPofSQ) |
| F13 | Agent (MCP server over stdio, default paths, from a clean copy of this repository) asks for 0.01 NEAR | `allowed`, `payout_settled`, paid 0.01 NEAR | [9yTqmx7VD7ieAAUgszC6PszL3zkBP9LvjQLWPtQynyvN](https://testnet.nearblocks.io/txns/9yTqmx7VD7ieAAUgszC6PszL3zkBP9LvjQLWPtQynyvN) |
| F14 | Agent asks for 0.5 NEAR, above the review amount | held, `tier2_escalate` | [GmVkqYNuKj54FXkP3GQSokSLZAZt6Q7tSnWryrJ2vGDp](https://testnet.nearblocks.io/txns/GmVkqYNuKj54FXkP3GQSokSLZAZt6Q7tSnWryrJ2vGDp) |
| F15 | Owner presses Approve in the Console | paid 0.5 NEAR | [EQMbwVAp3bK5LTtSzpVyjE1Kv1WCa7Q4pzqjZqeJrVcs](https://testnet.nearblocks.io/txns/EQMbwVAp3bK5LTtSzpVyjE1Kv1WCa7Q4pzqjZqeJrVcs) |
| F16 | Agent asks for 0.4 NEAR | held, `tier2_escalate` | [3XY2MyDpkFj1vJKG4YvungBgS8ZASSu14M7H4zg9ZGSC](https://testnet.nearblocks.io/txns/3XY2MyDpkFj1vJKG4YvungBgS8ZASSu14M7H4zg9ZGSC) |
| F17 | Owner presses Reject in the Console | not paid; no holds left | [GXgPRPU2Lf9j1n2j6rT6kvj1rCLmAEX4gDvs1Cznv9E7](https://testnet.nearblocks.io/txns/GXgPRPU2Lf9j1n2j6rT6kvj1rCLmAEX4gDvs1Cznv9E7) |
| F18 | Owner withdraws 0.1 NEAR from the Console (withdrawal number 1) | `withdraw_settled`; escrow 1.49 to 1.39 NEAR | [7Af7eYKmhneympFvPy69HgeGPWus267L4wpCdMbWcqpS](https://testnet.nearblocks.io/txns/7Af7eYKmhneympFvPy69HgeGPWus267L4wpCdMbWcqpS) |
| F19 | Owner withdraws 0.1 NEAR again (number 2, chosen on the first try) | `withdraw_settled`; escrow 1.39 to 1.29 NEAR | [Ch5evvME8oAjgLgCkcjDxVZnj96TtxzTude4mFRydXSN](https://testnet.nearblocks.io/txns/Ch5evvME8oAjgLgCkcjDxVZnj96TtxzTude4mFRydXSN) |
| F20 | Last pass after the final Console change: a new mandate registered, budget 1 NEAR, jobs of 0.01 and 0.5 NEAR | serial 1794645744295 | [23CNY852XRs4eG9QZPMethtPxe6DCyuvaDFv9yfPcxjF](https://testnet.nearblocks.io/txns/23CNY852XRs4eG9QZPMethtPxe6DCyuvaDFv9yfPcxjF) |
| F21 | Agent asks for 0.5 NEAR, above the review amount | held, `tier2_escalate` | [GMfep2aYxpdAnPfTHswvSJhqyKqGi5EQ2LGs8MdmpNxx](https://testnet.nearblocks.io/txns/GMfep2aYxpdAnPfTHswvSJhqyKqGi5EQ2LGs8MdmpNxx) |
| F22 | Owner presses Approve in the Console | paid 0.5 NEAR | [GV8XWtTRwA8fQZpokmnLhtMum4mXByeT7JAs1MaHmkyJ](https://testnet.nearblocks.io/txns/GV8XWtTRwA8fQZpokmnLhtMum4mXByeT7JAs1MaHmkyJ) |
| F23 | Owner withdraws 0.1 NEAR from the Console (withdrawal number 3) | `withdraw_settled`; escrow 0.79 to 0.69 NEAR | [AR1H4S8G41jDWY9UiJHPP2ZNia2GRCWEyypmegmKsbjr](https://testnet.nearblocks.io/txns/AR1H4S8G41jDWY9UiJHPP2ZNia2GRCWEyypmegmKsbjr) |
| F24 | Agent (MCP server over stdio) asks for 0.01 NEAR | `allowed`, `payout_settled`, paid 0.01 NEAR | [8V99HdJJhKzH9sFjfAm9afLT5U78h3oLvP6zXN5gjRNe](https://testnet.nearblocks.io/txns/8V99HdJJhKzH9sFjfAm9afLT5U78h3oLvP6zXN5gjRNe) |

Read back from the chain on 2026-11-14 18:01 KST: escrow 0.68 NEAR (2 - 0.01 - 0.5 - 0.1 - 0.1 - 0.5 - 0.1 - 0.01), no holds, 0 access keys.

## Gate account keys

| Run | Gate | Access keys | Deletion tx |
|---|---|---|---|
| A | `gater2.cg-tn1-a3r-e8a6d1a3.testnet` | 0 keys (block 277634647) | [6Eizzvh1yQL3nr9iZ7meGVYN1EPR6rvB2cdiwKUao5Vq](https://testnet.nearblocks.io/txns/6Eizzvh1yQL3nr9iZ7meGVYN1EPR6rvB2cdiwKUao5Vq) |
| B | `gatej2.cg-tn1-jev-9da8c302.testnet` | 0 keys (block 277634688) | [EXujPbLksQBNRPyec8wPyUjGRJ53nxYMSfBUQULEjVQi](https://testnet.nearblocks.io/txns/EXujPbLksQBNRPyec8wPyUjGRJ53nxYMSfBUQULEjVQi) |
| C | `gatec.chopgate-runc-cc790216.testnet` | 0 keys (block 277634713) | [6mPyNoBaU7jSgkbdPDE6CDrwhjK5nNNKtMsyxqMK9iQh](https://testnet.nearblocks.io/txns/6mPyNoBaU7jSgkbdPDE6CDrwhjK5nNNKtMsyxqMK9iQh) |
| D | `cg-u3g-b7f26e6c.testnet` | 0 keys (block 277576067) | [CzrQtunpUn13Fo8CUtGHaBk22cwtUQSsFE8gEkF1M7D8](https://testnet.nearblocks.io/txns/CzrQtunpUn13Fo8CUtGHaBk22cwtUQSsFE8gEkF1M7D8) |

All four gates above have 0 access keys, like the factory-created gates of runs E and F, so no key can deploy new code to them. Gate settings use the owner's signature, not an account key.

The factory account `cg-u1f-fdf59d31.testnet` has 0 access keys (block 277634766, deletion tx [AFMdL19wgibcVQTjcfNp52DyjTPMZe9dcnK7bnAD42jE](https://testnet.nearblocks.io/txns/AFMdL19wgibcVQTjcfNp52DyjTPMZe9dcnK7bnAD42jE)), so its code cannot be changed either. The factory source is in `factory/`: `bash factory/build.sh` writes `factory/out/chopgate_factory.wasm`, and the base58 form of that file's sha256 is the on-chain code hash `KmMxbye2PkLVWJ7dnjWGepVsccteC6pdJpnde9cCQGZ`. The file in this repository has that hash. Whether a build in another directory gives the same bytes is not proven (the wasm contains build-path strings).

## Signers

On 2026-11-14, `rpc.testnet.near.org` and `test.rpc.fastnear.com` returned `UNKNOWN_TRANSACTION`. Read the run transactions with RPC method `tx` on `https://archival-rpc.testnet.near.org`. Signers: Run A `agentr2.cg-tn1-a3r-e8a6d1a3.testnet` (scene 3 also `cg-tn1-attacker-0626733e.testnet`), Run B `agentj2.cg-tn1-jev-9da8c302.testnet`, Run C `cgw3-ll5tpm.testnet`, Run D `rund2.cg-u3o-b7f26e6c.testnet`, Run F `cgw3-ll5tpm.testnet` (owner steps) and `f6d.cgw3-ll5tpm.testnet` (agent steps).

## Open holds

These holds remain stored. They are past their deadline and can no longer be approved (the owner keys were also discarded), and their amounts return to escrow only if someone calls `expire_pending` (testnet NEAR only): 0.01 NEAR from the Run B scene 1 negative test on `gatej2.cg-tn1-jev-9da8c302.testnet`, and 0.01 NEAR and 0.08 NEAR (scene 5) on `gatej1.cg-tn1-jev-b81933d0.testnet`, the gate of an earlier, incomplete attempt at Run B.

## Run G

Testnet, 2026-11-14 KST. Gate `gb8c3037084b97f7e51ca.cg-u1f-fdf59d31.testnet`, made by the factory `cg-u1f-fdf59d31.testnet`. Code hash `8Qtk3jf4RLpfiB7PeXeuPGYcp4USV2yeN5Zn3d5NpAMj` (view_account on 2026-11-15; 0 access keys). Owner `cg-rto-7dac5aac.testnet`. Agent `rtagent.cg-rto-7dac5aac.testnet` with a function-call key. Review amount 0.3 NEAR.

| Step | What | Result | Transaction |
|---|---|---|---|
| G1 | agent asks for 0.5 NEAR (mandate job B) | held, reason `tier2_escalate`, hold id 1 | [P64sJW5t37jgsS8e3Coff8QQsMP8VZqpCtRRj6CCKDe](https://testnet.nearblocks.io/txns/P64sJW5t37jgsS8e3Coff8QQsMP8VZqpCtRRj6CCKDe) |
| G2 | `approve_pending` id 1 with a valid owner stamp signature over a different request hash (the same request with amount 0.01 NEAR) | transaction fails `invalid pending signature`; hold stays open; paid 0 | [B4VM1jQMKt3K1gnRzSnP72XqkB6RPadPRTU8YsMSqg3Q](https://testnet.nearblocks.io/txns/B4VM1jQMKt3K1gnRzSnP72XqkB6RPadPRTU8YsMSqg3Q) |
| G3 | `approve_pending` id 1 with the owner signature over the exact request hash `1164da76992570260f382f680ae64b921aef3afe622fad5be7da73b1d5a8942c` | `pending_approved`; payout 0.5 NEAR; `payout_settled`; escrow 2 to 1.5 NEAR | [3dH9dE3LfUm9xV9Q212dCfr3LipXtNEkCuLaXtqQcRxK](https://testnet.nearblocks.io/txns/3dH9dE3LfUm9xV9Q212dCfr3LipXtNEkCuLaXtqQcRxK) |
