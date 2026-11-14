# chopgate_factory

NEAR factory that creates one keyless ChopGate gate for the account that calls it. The contract is `chopgate_factory` (near-sdk 5.24.1, Rust 1.86.0). After `new`, the factory stores only `chain_id`. It keeps no gate index and no refund ledger.

The embedded gate is `res/chopgate.wasm`: 537066 bytes, sha256 `6e20ac13c62f77ecec9b6adbc48bf6cb52d818f9251ac797fc6581a0b18c1c1e`, code hash `8Qtk3jf4RLpfiB7PeXeuPGYcp4USV2yeN5Zn3d5NpAMj`. This factory build is `out/chopgate_factory.wasm`, 792018 bytes, sha256 `04ce9d363f08cca5983a5fb36ef04b21a5b5c75f1d0e568e7e64db8e9fb94fea`, code hash `KmMxbye2PkLVWJ7dnjWGepVsccteC6pdJpnde9cCQGZ` (`logs/codehash-mtime-factory-final.log`, base58 of the wasm sha256, computed on the build machine). It is built with no cargo features. `test-gate-double` and `test-force-retry` are test-only and off by default. Their wasms are `out-test/chopgate_factory_test_double.wasm` (254980 bytes, sha256 `10496da9e3be019a783e39d05613c49c06517cff0ad348a8be492ce492666025`) and `out-test/chopgate_factory_test_force_retry.wasm` (792035 bytes, sha256 `dd630c892be937a98132f15e7c5d373f9a78a2dd721a329b93a431e3380733ea`). The two out-test wasms were built at 09:16 KST (`logs/codehash-mtime-factory-final.log`), before a comment-only edit of `src/lib.rs` in the deployed build; s14 and s15 in `logs/test-factory-final.log` ran on these files. They were not rebuilt from the final source. `logs/double-check-factory-final.log` records `fixture_in_deploy=false` and `real_gate_in_deploy=true`. The testnet deployment record (factory account, code hash, transaction hashes) is in `DEPLOY.txt`, written after deployment.

Amounts and gas below are the sandbox run in `logs/test-factory-final.log` (15 passed, 0 failed, finished in 67.78s). Host checks are in `logs/unit-factory-final.log` (7 passed, 0 failed, 0.07s). `required_deposit` multiplies by `env::storage_byte_cost()`. On this sandbox that view returned `5495660000000000000000000` (`logs/test-factory-final.log`), which is `(537066 + 2500) * 10^19 + 0.1 NEAR`.

## What it does

`create_gate` is one payable call. The predecessor is the owner. Each owner has one gate. The gate account id is computed, not stored:

```text
"g" + first 20 lowercase hex chars of sha256(owner account name) + "." + factory account
```

Those 20 hex characters are 80 bits. A collision between two owner names is a birthday event at about 2^40 owners. The second create then fails the way an existing account fails, and the refund chain runs. A targeted preimage of another owner's name is not practical. Only the factory can create the `g<hex>.<factory>` account.

Example from s9 (`logs/test-factory-final.log`): owner `owner-a.test.near` on `factory.test.near` is `g54df36f2ed8c1ef68d9c.factory.test.near`. If that id is not a legal NEAR account id, the call panics with `gate account id rejected` before any promise. A 42-character factory id still fits (gate length 64). A 43-character factory id panics. That length check is host-proven.

Entry checks, before any promise:

- attached deposit >= `required_deposit`, or panic `insufficient deposit`
- prepaid gas >= 200 Tgas, or panic `prepaid gas below 200 Tgas`
- `owner_public_key` must be a 32-byte ed25519 key and not all zero, or panic `owner key must be a 32-byte ed25519 key and not all zero`

That key check is ed25519 type byte 0, a 32-byte payload, and a payload that is not all zeros. One message covers a wrong ed25519 type byte, a wrong length, and an all-zero payload. It does not check that the payload is a point on the ed25519 curve. s3 (secp256k1) panics with that message. The host test checks secp256k1 and 32 zero bytes.

Any yoctoNEAR above `required_deposit` is transferred back to the predecessor inside `create_gate`. The `surplus_sent` log (`owner`, `amount`) means that transfer was scheduled, not that it was delivered. The create itself is one batch on the computed gate:

1. `CreateAccount`
2. `Transfer` of exactly `required_deposit`
3. `DeployContract` of the embedded gate wasm
4. `FunctionCall` `new` with deposit 0 and 70 Tgas

`new` is called with `owner_public_key`, `chain_id`, and `deployment_id` `"chopgate-f5:<gate account id>"`. The gate stores that string plus `:` and the block timestamp. s1 read `chopgate-f5:g54df36f2ed8c1ef68d9c.factory.test.near:1794617112335157730` (`logs/test-factory-final.log`). An owner account id is at most 64 characters. The gate account id is at most 64. The gate keeps the string in its state. The batch then chains private `on_gate_created(owner, gate)` at a fixed 45 Tgas. No access key is added on the gate.

The batch is atomic. If it fails, the protocol returns the transferred `required_deposit` to the factory. The refund chain then sends that amount to the same predecessor, or retries while the return is still in flight.

Deploy the factory with private init `new` and a non-empty `chain_id` (`"chain_id required"` otherwise). Fund it so the free float after the factory's own storage stake is at least one `required_deposit` (about 6 NEAR). `bash deploy.sh <factory_fund_yocto>` checks that estimate and stops when the float is short. This wasm is 792018 bytes, about 7.92018 NEAR of code stake at 10^19 yoctoNEAR per byte, plus 0.001 NEAR of state slack in that estimate.

## Who pays what

A gate locks 5.49566 NEAR plus gas. A wallet holding 2.5 NEAR cannot create one. One docs.near.org faucet drop of 5 NEAR is also short of 5.49566 NEAR plus gas.

Sandbox `required_deposit` is `5495660000000000000000000` yoctoNEAR (5.49566 NEAR) (`logs/test-factory-final.log`). There is no factory record fee. The whole amount is the batch `Transfer` to the gate:

```text
required_deposit = (537066 + 2500) * storage_byte_cost + 0.1 NEAR
```

2500 is the priced allowance for the account record and initial state. 0.1 NEAR is a liquid reserve on the gate (10,000 bytes at this byte price). See Limitations for what that reserve holds.

s1 attached exactly that amount at 200 Tgas (`logs/test-factory-final.log`):

| Piece | YoctoNEAR | NEAR | Log |
| --- | ---: | ---: | --- |
| `required_deposit` locked on the gate | `5495660000000000000000000` | 5.49566 | `logs/test-factory-final.log` |
| Gate balance after create | `5495683075110951800000000` | 5.495683 | `logs/test-factory-final.log` |
| Gate gas reward | `23075110951800000000` | 0.000023 | `logs/test-factory-final.log` |
| Factory balance change | `1001673909096300000000` | 0.001002 | `logs/test-factory-final.log` |
| Owner spend (required plus gas) | `5514004300089342400000000` | 5.514004 | `logs/test-factory-final.log` |
| Owner gas portion | `18344300089342400000000` | 0.018344 | s1 `owner_delta_yocto` minus `required_yocto`, both in `logs/test-factory-final.log` |

The gate reward is under 0.005 NEAR. The factory change is under 0.01 NEAR. Factory `storage_usage` was the same before and after s1. The owner's gas portion is the burn of an ~80 Tgas create, measured after two follow-up calls so unused-gas refunds can post.

## Methods

| Method | Kind | Arguments | Returns |
| --- | --- | --- | --- |
| `new` | init, private | `chain_id: String` | state. Empty `chain_id` panics `chain_id required`. |
| `required_deposit` | view | none | `U128` yoctoNEAR string |
| `gate_account_for` | view | `owner: AccountId` | `AccountId` |
| `gate_code_hash` | view | none | base58 sha256 of the embedded wasm |
| `create_gate` | payable call | `owner_public_key: PublicKey` | promise; the transaction result is the callback `bool` |
| `on_gate_created` | private | `owner: AccountId`, `gate: AccountId` | `bool`, or a promise that resolves to `bool` |
| `retry_refund` | private | `owner: AccountId`, `attempt: u8` | `bool`, or a promise that resolves to `bool` |

`on_gate_created` and `retry_refund` reject every predecessor except the factory account (`Method on_gate_created is private`, `Method retry_refund is private`). s7: a direct call moved 0 yoctoNEAR from the named victim (`logs/test-factory-final.log`). The direct `retry_refund` burn was `2100051837163` gas (2.100 Tgas) (`logs/test-factory-final.log`).

Events are one NEP-297 line, standard `chopgate-factory`, version `1.0.0`, `data` a one-element array:

| `event` | When | `data` fields |
| --- | --- | --- |
| `gate_created` | batch succeeded | `owner`, `gate`. On a create with no surplus this is the only event. |
| `surplus_sent` | a surplus transfer was scheduled | `owner`, `amount` (string). Logged on the `create_gate` receipt when the transfer is scheduled. It does not mean the transfer was delivered. |
| `gate_create_failed` | batch failed | `owner`, `gate` |
| `refund_sent` | `required_deposit` transferred to the owner | `owner`, `amount` (string), `attempt` (string, `"1"` when the callback paid) |
| `refund_retry` | liquidity was short and the next attempt was scheduled | `owner`, `attempt`, `next`, `free` (strings) |
| `refund_stuck` | attempt 6 was still short | `owner`, `amount`, `attempt` (`"6"`), `free` |

## Gas

`logs/test-factory-final.log` prints:

```text
gas_budget min_prepaid_tgas=200 new_gas_tgas=70 callback_gas_tgas=45 callback_own_tgas=20 retry_hop_tgas=5 refund_attempts=6 parent_burn_budget_tgas=45 margin_tgas=40 max_tgas=300
```

| Constant | Tgas | Role | Log |
| --- | ---: | --- | --- |
| `MIN_PREPAID_TGAS` | 200 | Minimum `prepaid_gas` on `create_gate`. `45 + 70 + 45 + 40`. s12 attached exactly this with a 0.1 NEAR surplus and succeeded. | `logs/test-factory-final.log` |
| `NEW_GAS_TGAS` | 70 | Gas attached to the gate's `new` FunctionCall only. Batch action fees (create, transfer, deploy) are prepaid from the `create_gate` receipt. | `logs/test-factory-final.log` |
| `CALLBACK_OWN_TGAS` | 20 | Budget for the callback body. | `logs/test-factory-final.log` |
| `RETRY_HOP_TGAS` | 5 | Own gas of one `retry_refund` attempt, including what it forwards. `ceil(2 * 2457666493594 / 10^12)` from s15. | `logs/test-factory-final.log` |
| `CALLBACK_GAS_TGAS` | 45 | `20 + 5 * 5`. Static gas on `on_gate_created`. Unused-gas weight is 0. | `logs/test-factory-final.log` |
| `REFUND_ATTEMPTS` | 6 | Attempt 1 is `on_gate_created`. Attempts 2 through 6 are `retry_refund`. | `logs/test-factory-final.log` |
| `PARENT_BURN_BUDGET_TGAS` | 45 | Ceiling used for the `create_gate` receipt's own burn. | `logs/test-factory-final.log` |
| `GAS_MARGIN_TGAS` | 40 | Extra prepaid gas. 200 is at most 300. | `logs/test-factory-final.log` |

`gas_for_attempt(2)` is 25 Tgas, equal to `CALLBACK_GAS - CALLBACK_OWN`. The host test `gas_budget_covers_six_attempts_under_300` asserts that.

Measured `gas_burnt` (gas units) on the deploy wasm (`logs/test-factory-final.log`):

| Path | Total | Batch receipt | Callback receipt | Log |
| --- | ---: | ---: | ---: | --- |
| s1 success | `79761610960400` | `43837436000513` | `2098164725689` | `logs/test-factory-final.log` |
| s1 parent `create_gate` receipt | `33067484809708` |  |  | `logs/test-factory-final.log` |
| s2 second call, account exists | `44284336396363` | `7308059500000` | `2476385232565` | `logs/test-factory-final.log` |
| s8 second owner | `79738671091880` | `43837379230349` | `2084484725689` | `logs/test-factory-final.log` |
| s12 success at exactly 200 Tgas with 0.1 NEAR surplus | `80571657285023` | `43837349611133` | `2098164725689` | `logs/test-factory-final.log` |
| s3 secp256k1 rejected at entry | `2707742513725` |  |  | `logs/test-factory-final.log` |
| s4 deposit short by 1 yocto | `2658085336444` |  |  | `logs/test-factory-final.log` |
| s6 199 Tgas | `2662428580495` |  |  | `logs/test-factory-final.log` |
| s7 direct `retry_refund` (private reject) | `2100051837163` |  |  | `logs/test-factory-final.log` |

s12 attached exactly 200 Tgas (`logs/test-factory-final.log`). The `create_gate` receipt then has `(200 - 70 - 45) = 85` Tgas for its own burn and the batch execution fees. s1 measured that burn at `33067484809708` (`logs/derived-factory-final.txt`; s12 does not list the parent receipt). Fee-table batch fees are `43068263399518` (43-char base58 key, 171 bytes with the method name) or `43068265635452` (44-char, 172 bytes); these two fee-table figures are a fee calculation, not in the test log. Unused (`logs/derived-factory-final.txt`): `85000000000000 - 33067484809708 - 43068263399518 = 8864251790774` gas, or `8864249554840` gas (8.864 Tgas). An earlier build (not the final wasm) was measured with 225 Tgas attached: (225 - 70 - 70) = 85 Tgas was left for the parent call, and 8.865 Tgas of it was unused. That log is not in this repository.

The highest batch burn on the deploy wasm is `43837436000513` (43.837 Tgas) (`logs/derived-factory-final.txt`). That burn is the prepaid execution fees of the batch actions plus the `new` execution. It is not a total the 70 Tgas covers. The highest callback burn on the deploy wasm is s2 and s10 at `2476385232565` (2.476 Tgas) (`logs/derived-factory-final.txt`), under the 20 Tgas own budget. Attach 200 Tgas.

s15, on the `test-force-retry` wasm only, burned `2457666493594` gas on the attempt-2 `retry_refund` receipt (`refund_retry`) and `2341275743570` gas on the attempt-3 receipt (`refund_sent`) (`logs/test-factory-final.log`). The rule for `RETRY_HOP_TGAS` is at least twice that maximum, rounded up to a whole Tgas: `ceil(2 * 2457666493594 / 10^12) = 5` (`logs/test-factory-final.log`). The host test walks all six attempts with a short balance and logs `refund_stuck` only on attempt 6 (`logs/unit-factory-final-nocapture.log`). s10 and s11, on the deploy wasm, paid on attempt 1 and logged no `refund_retry` (`logs/test-factory-final.log`).

## Refund ordering and conservation

Each failed create's batch `Transfer(required)` returns to the factory as a protocol refund receipt. Each create has exactly one refund chain, and that chain pays `required` at most once: `on_gate_created` is attempt 1 and either pays or hands off to `retry_refund`; each later attempt either pays and stops or hands off; attempt 6 logs `refund_stuck` and does not pay. Nothing else in the contract transfers a refund. So the yoctoNEAR paid out on that chain equals the yoctoNEAR the protocol returned for that create. The free-balance check is a liquidity check only. It can move `required` from liquid tokens before the protocol receipt is visible, and that receipt refills the same balance. The factory does not pay a second `required` for the same create.

In this sandbox the protocol refund receipt is before the callback. s10 (free float `754499181250000000000` yoctoNEAR, under 0.01 NEAR, before a failing second create) printed `protocol_refund_idx=Some(2)` and `callback_idx=Some(4)`, `attempt=1`, `retry_observed=false` (`logs/test-factory-final.log`). s11 (free float `999754499181250000000000`, under `required_deposit`, two overlapping failures) printed the same index pair for both owners, `attempt_a=1`, `attempt_b=1`, both losses under 0.02 NEAR, factory delta `2226348874167300000000` (0.002226 NEAR, under 0.01) (`logs/test-factory-final.log`). s2's receipt list has the same shape: the small factory receipt at index 2 (`223182562500` gas) and the callback at index 4 (`2476385232565` gas) (`logs/test-factory-final.log`). That order is what this sandbox did. It is not a protocol guarantee.

s14 is the same shape for a `new` trap, on the test-only gate double: `protocol_refund_idx=Some(2)`, `callback_idx=Some(4)`, `attempt=1`, `returned=false`, `gate_exists=false`, owner loss `5462056618092600000000` (0.005462 NEAR, gas only, under 0.02), factory delta `95263527556600000000` (0.000095 NEAR, under 0.01) (`logs/test-factory-final.log`). The failed receipt trapped on `unreachable`. The double's `required_deposit` was `125340000000000000000000` because that wasm embeds a 34-byte module, not `res/chopgate.wasm` (`logs/test-factory-final.log`).

If the credit lags, attempts 2 through 6 recheck liquidity. Deploy with free float of at least one `required_deposit` (about 6 NEAR) so a normal failure can still pay from that float in the same block and the protocol receipt refills it. `deploy.sh` checks the funding figure. s15 forced attempts 1 and 2 to report short (`test-force-retry`, K=2) even though the balance could pay. Attempt 3 paid. One `refund_sent`. Owner loss `5258301737272300000000` (0.005258 NEAR, under 0.02) (`logs/test-factory-final.log`). Factory delta `1107322289856500000000` (0.001107 NEAR, under 0.01) (`logs/test-factory-final.log`). That wasm is not the deploy wasm.

## Limitations

A refund that is still short of `required_deposit` after 6 attempts logs `refund_stuck` (owner, amount, attempt `"6"`, free balance) and returns false. That amount stays in the factory. It is unrecoverable by design: there is no claim and no withdraw method. An operator sees the `refund_stuck` event. s10 and s11 did not hit it (`logs/test-factory-final.log`). The host test drives all six attempts with a short balance and logs `refund_stuck` only on attempt 6 (`logs/unit-factory-final-nocapture.log`). s15 stopped at attempt 3 (`logs/test-factory-final.log`).

The surplus transfer and the refund transfer both go to the predecessor of that same `create_gate` call. `surplus_sent` means the surplus transfer was scheduled. If that account deletes itself before the transfer lands, the amount stays in the factory and nobody can withdraw it. Only that account can cause this.

Deploy the factory with free float of at least one `required_deposit` (about 6 NEAR). `bash deploy.sh <factory_fund_yocto>` checks the estimate and exits 1 when the float is below that.

The factory does not check that the key is a point on the ed25519 curve. A gate made with such a key can never be signed for by anyone. The console sends only a public key it derived in the browser from a seed made with `crypto.getRandomValues` (`site/assets/js/keys.mjs:25-48`) or re-derived from an imported backup seed (`keys.mjs:50-58`); `create_gate` is sent with that key (`console.mjs:528-531`, from `currentStamp` at line 508).

The 0.1 NEAR reserve is 10,000 bytes at 10^19 yoctoNEAR per byte. s13 measured one `register` at 330 bytes (about 30 in that reserve), one refused `authorize_and_pay_tiered` at 239 bytes (about 41), one pending hold at 66 bytes (about 151), and one paid tiered call at 28 bytes (about 357); those counts share one reserve (`logs/test-factory-final.log`).

A call that would push the gate's storage stake above its balance fails with `LackBalanceForState` and reverts, so further registers, tiered authorizations, and pending holds stop. Escrow NEAR sits in that same balance and backs the stake. A payout or `withdraw_escrow` that would leave the balance below the stake fails, and the gate restores the escrow (`payout_refunded` / `withdraw_refunded`), so the payment does not leave.

The factory account still has its deploy key (full access) on testnet until Run E and the console create test pass; it will then be deleted.

`test-gate-double` and `test-force-retry` are test-only cargo features. Both are off by default. `bash build.sh` does not pass them. The deploy wasm does not contain the 34-byte test double (`logs/double-check-factory-final.log`, `fixture_in_deploy=false`). s1 and the host test `deploy_wasm_excludes_test_double` both read gate code hash `8Qtk3jf4RLpfiB7PeXeuPGYcp4USV2yeN5Zn3d5NpAMj` from the deploy wasm's embedded gate (`logs/unit-factory-final-nocapture.log`).

## What is not proven

- A protocol refund that arrives after the callback, on testnet or in this sandbox, without `test-force-retry`. Every failing sandbox create in this run (s2, s10, s11, s14, s15) had `protocol_refund_idx=Some(2)` and `callback_idx=Some(4)` (`logs/test-factory-final.log`). s15 forces the short report. It does not delay the credit. The deploy wasm never took the short branch here.
- `refund_stuck` and attempts 4 through 6 in the sandbox. The host test logs `refund_stuck` only on attempt 6 (`logs/unit-factory-final-nocapture.log`). s15 paid on attempt 3 (`logs/test-factory-final.log`).
- Retry-hop gas on the deploy wasm while the balance is actually short. s15's burns are from the `test-force-retry` wasm. Attempts 1 and 2 take a branch the deploy wasm does not have. The rest of the hop (read free balance, log, transfer or schedule) is the same code.
- A `new` panic inside the real ChopGate wasm. Real `new` rejects an empty signature domain or a non-ed25519 type byte. The factory already rejects a non-ed25519 key and always sends a non-empty domain. s14's trap is the test double's `unreachable`, and that module is not in the deploy wasm.
- An ed25519 payload that is not a curve point. The factory accepts it. The real gate's `new` accepts it. The create succeeds, and nobody can sign for that gate. It is not a refund.
- The predecessor deleting itself before a scheduled surplus or refund transfer lands.
- `LackBalanceForState` from filling the 0.1 NEAR reserve. s13's gate storage after the flow was 538209 (`logs/test-factory-final.log`), 1143 bytes above the wasm, inside the 2500 bytes priced into `required_deposit`.
- A real 80-bit name collision, and deletion of the factory's full-access key after Run E.

## Gate has zero access keys: nobody can change its code

s9 listed the gate's access keys after a successful create and the list was empty (`access_key_count=0`, `logs/test-factory-final.log`).

## Use it (do X, see Y)

A gate locks about 5.5 NEAR, measured `required_deposit` `5495660000000000000000000` yoctoNEAR (5.49566 NEAR), plus gas (`logs/test-factory-final.log`).

`FACTORY_ID` is the deployed factory account. `TX` is the transaction id the CLI prints for the create. `<name>` is the new testnet account. Prepaid gas is `200 Tgas`. The attached deposit is the yocto string from the `required_deposit` view.

Human path:

1. Create an Intear testnet wallet. See a new testnet account in the wallet.
2. Request the faucet at `https://docs.near.org` once. See 5 testnet NEAR arrive.
3. Open the NEAR console and call `FACTORY_ID` `create_gate` with `{"owner_public_key":"ed25519:..."}`, prepaid gas `200 Tgas`, and attached deposit `5495660000000000000000000` yoctoNEAR (`logs/test-factory-final.log`). With only the 5 NEAR faucet drop the wallet is short of 5.49566 NEAR plus gas, so the deposit cannot be attached. After the wallet holds at least that deposit plus gas, see transaction `TX` succeed, one `gate_created` log, and the new gate account.

Judge path:

4. Do `near account create-account sponsor-by-faucet-service <name>.testnet autogenerate-new-keypair ... create`. See a new account `<name>.testnet` with 10 testnet NEAR.
5. Do `near contract call-function as-read-only FACTORY_ID required_deposit json-args {}`. See the yocto string `5495660000000000000000000` when storage byte cost is 10^19 (`logs/test-factory-final.log`).
6. Do `near contract call-function as-transaction FACTORY_ID create_gate json-args '{"owner_public_key":"ed25519:..."}' prepaid-gas '200 Tgas' attached-deposit '5495660000000000000000000 yoctoNEAR' sign-as <name>.testnet ...`. See transaction `TX` succeed, one `gate_created` log with `owner` `<name>.testnet`, and the gate account.
7. Do `near contract call-function as-read-only FACTORY_ID gate_account_for json-args '{"owner":"<name>.testnet"}'` and `near contract call-function as-read-only FACTORY_ID gate_code_hash json-args {}`, and view that gate account. See code hash `8Qtk3jf4RLpfiB7PeXeuPGYcp4USV2yeN5Zn3d5NpAMj` from the view and from the account. The gate's `signature_domain` deployment id starts with `chopgate-f5:<that gate id>:`.

## Other deployment designs (not used)

These figures are from the design note. They are not this factory's `required_deposit`.

A global-contract gate is about 0.015 NEAR per gate (`../U0-DESIGN_r2.md:181`). Adding the 0.1 NEAR margin gives 0.115 NEAR (`../U0-DESIGN_r2.md:185`, 0.015 + 0.1). This factory deploys a full gate wasm into a new account, so the lock is the 5.49566 NEAR measured above.
