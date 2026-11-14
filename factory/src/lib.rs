//! ChopGate factory, p5. One call creates one keyless gate account and deploys
//! the embedded ChopGate contract. The factory keeps no ledger: after `new`
//! nothing writes state, and the contract does not custody a refund balance
//! of its own. A failed create is refunded from free balance, or retried a
//! few times while the protocol's transfer refund is still in flight.
use near_sdk::json_types::U128;
use near_sdk::{
    env, near, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue, PromiseResult,
    PublicKey,
};

#[cfg(all(feature = "test-gate-double", feature = "test-force-retry"))]
compile_error!("test-gate-double and test-force-retry are separate wasm builds");

/// Embedded ChopGate gate, byte-for-byte `res/chopgate.wasm`.
/// `test-gate-double` swaps in the test fixture. That feature is off in the deploy wasm.
#[cfg(not(feature = "test-gate-double"))]
const GATE_WASM: &[u8] = include_bytes!("../res/chopgate.wasm");

/// Test-only gate. Exported `new` is `unreachable`. Sandbox-only; not in the deploy wasm.
#[cfg(feature = "test-gate-double")]
const GATE_WASM: &[u8] = include_bytes!("../tests/fixtures/gate_new_unreachable.wasm");

const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
/// Extra bytes priced into the gate for the account record and initial state.
const GATE_STATE_BYTES: u128 = 2_500;
/// Liquid reserve left on the new gate. There is no factory record fee.
const STATE_RESERVE: u128 = ONE_NEAR / 10;

/// Gas attached to the gate's `new` FunctionCall only. Not the create-batch budget.
/// s1 batch `gas_burnt` `43837379230349` (measured) = batch action execution fees
/// (computed) + `new` execution. Fees: action receipt `108059500000` + create account
/// `7200000000000` + transfer `115123062500` + deploy `184765750000 + 64572944*537066`
/// + function call `780000000000 + 2235934` per byte of the 3-byte method name `new`
/// and the JSON args. s1's key was not logged. The JSON is 168 bytes when that
/// ed25519 base58 key is 43 chars and 169 when it is 44 (`ed25519:` + base58,
/// `chain_id` `local-test`, deployment id
/// `chopgate-f5:g54df36f2ed8c1ef68d9c.factory.test.near`). With the method name
/// that is 171 or 172 bytes, so the fees are `43068263399518` or `43068265635452`.
/// `new` execution is then `769115830831` or `769113594897`. s2's failed batch
/// `7308059500000` = `108059500000 + 7200000000000` (create account failed; no deploy fee).
pub const NEW_GAS_TGAS: u64 = 70;
/// Own gas for one `retry_refund` receipt, including the gas that receipt
/// forwards to the next attempt.
///
/// s15 measured a maximum `retry_refund` burn of `2457666493594` gas.
/// The rule is `ceil(2 * max_hop_burn_gas / 10^12)`, which is 5.
/// A direct private-reject call is a different path and is not this number.
pub const RETRY_HOP_TGAS: u64 = 5;
/// `test-force-retry` only. Attempts `1..=TEST_FORCE_SHORT_K` report a short
/// balance so `retry_refund` runs in the sandbox. The deploy wasm does not
/// enable that feature, and this constant is not read when the feature is off.
pub const TEST_FORCE_SHORT_K: u8 = 2;
/// Total refund attempts. Attempt 1 is `on_gate_created`. Attempts 2 through
/// 6 are `retry_refund` receipts. `refund_stuck` is logged only on attempt 6.
pub const REFUND_ATTEMPTS: u8 = 6;
/// Gas reserved for the `on_gate_created` body. The failure callback burns
/// about 2.5 Tgas; 20 Tgas is that burn with margin.
pub const CALLBACK_OWN_TGAS: u64 = 20;
/// Static gas on `on_gate_created`. Own budget plus five retry hops.
/// Unused gas weight is 0, so this is the whole budget attached to the call.
/// s1 callback `gas_burnt` `2098164725689` (measured) is that receipt's burn.
pub const CALLBACK_GAS_TGAS: u64 =
    CALLBACK_OWN_TGAS + (REFUND_ATTEMPTS as u64 - 1) * RETRY_HOP_TGAS;
/// Ceiling for the `create_gate` receipt's own `gas_burnt`.
/// s1 measured `33067349054968`. Batch execution fees are prepaid out of this
/// receipt and burnt on the batch outcome, so they are not part of this burn.
/// The callback data-receipt base execution fee `36486732312` is burnt here
/// when that receipt is created, not in the batch fee. s2 shows the batch fee
/// has no data-receipt term. s1 owner refund receipts `223182562500` (measured)
/// = action-receipt exec `108059500000` + transfer exec `115123062500`.
pub const PARENT_BURN_BUDGET_TGAS: u64 = 45;
/// Prepaid gas above the parent-burn budget, `NEW_GAS`, and `CALLBACK_GAS`.
/// At 200 Tgas the receipt has `200 - 70 - 45 = 85` Tgas for its own burn and
/// the batch execution fees. After s1's measured burn and those computed fees,
/// `8864387545514` gas (43-char key) or `8864385309580` gas (44-char) of that
/// 85 Tgas is unused by those two.
pub const GAS_MARGIN_TGAS: u64 = 40;
/// `create_gate` panics before any promise when prepaid gas is below this.
/// `PARENT_BURN_BUDGET + NEW_GAS + CALLBACK_GAS + GAS_MARGIN`, and at most 300.
/// s12 attached exactly 200. The same 85 Tgas pool at the p5c boundary is
/// `225 - 70 - 70`. p5c s1 parent burn `33066946492370` (measured) leaves
/// `8864790108112` or `8864787872178` gas after the same computed batch fees.
pub const MIN_PREPAID_TGAS: u64 =
    PARENT_BURN_BUDGET_TGAS + NEW_GAS_TGAS + CALLBACK_GAS_TGAS + GAS_MARGIN_TGAS;

const NEW_GAS: Gas = Gas::from_tgas(NEW_GAS_TGAS);
const CALLBACK_GAS: Gas = Gas::from_tgas(CALLBACK_GAS_TGAS);
const MIN_PREPAID: Gas = Gas::from_tgas(MIN_PREPAID_TGAS);

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Factory {
    chain_id: String,
}

fn byte_cost() -> u128 {
    env::storage_byte_cost().as_yoctonear()
}

/// Liquidity check only: `account_balance - storage_usage * storage_byte_cost`.
/// This does not identify which create's deposit is in the balance. Each
/// failed create has one refund chain, and that chain pays `required` at most
/// once. The protocol returns that create's batch `Transfer(required)` to the
/// factory, so what is paid out is what came back (other liquid tokens cover
/// the gap only until that return lands).
fn free_yocto() -> u128 {
    let balance = env::account_balance().as_yoctonear();
    let stake = u128::from(env::storage_usage()).saturating_mul(byte_cost());
    balance.saturating_sub(stake)
}

fn required_deposit_yocto() -> u128 {
    let bytes = (GATE_WASM.len() as u128).saturating_add(GATE_STATE_BYTES);
    byte_cost().saturating_mul(bytes).saturating_add(STATE_RESERVE)
}

/// `g` + first 20 lowercase hex chars of `sha256(owner)` + `.` + factory.
/// Panics with "gate account id rejected" when that id is not a NEAR account
/// id (the factory account itself is too long).
fn compute_gate_account(owner: &AccountId) -> AccountId {
    let digest = env::sha256(owner.as_bytes());
    let mut hex = String::with_capacity(20);
    for byte in digest.iter().take(10) {
        hex.push_str(&format!("{byte:02x}"));
    }
    format!("g{hex}.{}", env::current_account_id())
        .parse()
        .unwrap_or_else(|_| env::panic_str("gate account id rejected"))
}

fn log_event(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        near_sdk::serde_json::json!({
            "standard": "chopgate-factory",
            "version": "1.0.0",
            "event": event,
            "data": [data],
        })
    ));
}

/// Gas attached to refund attempt `attempt` (2..=[`REFUND_ATTEMPTS`]).
/// Includes this attempt's own `RETRY_HOP_TGAS` and every later attempt.
fn gas_for_attempt(attempt: u8) -> Gas {
    let left = u64::from(REFUND_ATTEMPTS.saturating_sub(attempt).saturating_add(1));
    Gas::from_tgas(RETRY_HOP_TGAS.saturating_mul(left))
}

/// Fixed-gas private self call for the next attempt. Weight 0 so the receipt
/// gets this gas and no share of whatever the caller has left.
fn schedule_retry(owner: AccountId, attempt: u8) -> Promise {
    Factory::ext(env::current_account_id())
        .with_static_gas(gas_for_attempt(attempt))
        .with_unused_gas_weight(0)
        .retry_refund(owner, attempt)
}

fn send_required(owner: AccountId, attempt: u8) {
    let amount = required_deposit_yocto();
    // Detached so this receipt can return `false` while the transfer runs.
    // The `refund_sent` log is the observable record of the one payment.
    Promise::new(owner.clone())
        .transfer(NearToken::from_yoctonear(amount))
        .detach();
    log_event(
        "refund_sent",
        near_sdk::serde_json::json!({
            "owner": owner,
            "amount": amount.to_string(),
            "attempt": attempt.to_string(),
        }),
    );
}

/// Liquidity check only (`free_yocto` < `amount`). See `free_yocto`.
/// With `test-force-retry`, attempts 1..=[`TEST_FORCE_SHORT_K`] report short
/// even when the balance would cover `amount`. Every other attempt, and every
/// attempt in the deploy wasm, uses only the balance check.
fn liquidity_short(attempt: u8, amount: u128) -> bool {
    #[cfg(feature = "test-force-retry")]
    if (1..=TEST_FORCE_SHORT_K).contains(&attempt) {
        return true;
    }
    let _ = attempt;
    free_yocto() < amount
}

/// One step of the single refund chain. `attempt` is 1-based: 1 is
/// `on_gate_created`, 2..=[`REFUND_ATTEMPTS`] are `retry_refund`. Pays
/// `required` at most once. A short liquidity check before the last attempt
/// hands off; the last attempt logs `refund_stuck` and returns false. It
/// does not panic and it does not schedule another hop.
fn refund_or_next(owner: AccountId, attempt: u8) -> PromiseOrValue<bool> {
    let amount = required_deposit_yocto();
    if !liquidity_short(attempt, amount) {
        send_required(owner, attempt);
        return PromiseOrValue::Value(false);
    }
    if attempt < REFUND_ATTEMPTS {
        log_event(
            "refund_retry",
            near_sdk::serde_json::json!({
                "owner": owner,
                "attempt": attempt.to_string(),
                "next": (attempt + 1).to_string(),
                "free": free_yocto().to_string(),
            }),
        );
        return PromiseOrValue::Promise(schedule_retry(owner, attempt + 1));
    }
    log_event(
        "refund_stuck",
        near_sdk::serde_json::json!({
            "owner": owner,
            "amount": amount.to_string(),
            "attempt": attempt.to_string(),
            "free": free_yocto().to_string(),
        }),
    );
    PromiseOrValue::Value(false)
}

/// Type byte 0, 32-byte payload, payload not all zeros. This does not check
/// that the payload is a point on the ed25519 curve. Panics before any promise.
fn assert_ed25519_key(key: &PublicKey) {
    let bytes = key.as_bytes();
    let payload = bytes.get(1..).unwrap_or(&[]);
    let ed25519_32 = bytes.first().copied() == Some(0) && payload.len() == 32;
    let not_all_zero = payload.iter().any(|byte| *byte != 0);
    if !ed25519_32 || !not_all_zero {
        env::panic_str("owner key must be a 32-byte ed25519 key and not all zero");
    }
}

#[near]
impl Factory {
    /// `chain_id` is stored once. It must be non-empty. No later method writes state.
    #[init]
    #[private]
    pub fn new(chain_id: String) -> Self {
        assert!(!chain_id.is_empty(), "chain_id required");
        Self { chain_id }
    }

    /// YoctoNEAR the create batch transfers to the new gate.
    /// `(wasm_len + 2500) * storage_byte_cost + 0.1 NEAR`.
    pub fn required_deposit(&self) -> U128 {
        U128(required_deposit_yocto())
    }

    /// Pure function of `owner` and this factory's account id. No storage read
    /// beyond the account id the runtime already has.
    pub fn gate_account_for(&self, owner: AccountId) -> AccountId {
        compute_gate_account(&owner)
    }

    /// Base58 `sha256` of the embedded gate wasm. NEAR code hash.
    pub fn gate_code_hash(&self) -> String {
        near_sdk::bs58::encode(env::sha256(GATE_WASM)).into_string()
    }

    /// Create the caller's one gate. `owner` is the predecessor.
    ///
    /// Panics before any promise when the deposit or prepaid gas is short, or
    /// when the computed gate id is not a legal account id. Surplus above
    /// `required_deposit` is a separate transfer back to the predecessor, not
    /// part of the create batch. The batch is create + transfer(required) +
    /// deploy + `new`, then `on_gate_created` at a fixed gas. No access key is
    /// added.
    ///
    /// `&mut self` is how near-sdk exports a payable call (`&self` is a view).
    /// No field is assigned. The SDK rewrites the same `chain_id` bytes at the
    /// end of the call; the account's storage does not grow.
    #[payable]
    pub fn create_gate(&mut self, owner_public_key: PublicKey) -> Promise {
        let owner = env::predecessor_account_id();
        let required = required_deposit_yocto();
        let attached = env::attached_deposit().as_yoctonear();
        assert!(attached >= required, "insufficient deposit");
        assert!(
            env::prepaid_gas() >= MIN_PREPAID,
            "prepaid gas below {} Tgas",
            MIN_PREPAID_TGAS
        );
        // Key, id, then promises. A panic here returns the whole deposit.
        assert_ed25519_key(&owner_public_key);
        let gate = compute_gate_account(&owner);

        let surplus = attached - required;
        if surplus > 0 {
            log_event(
                "surplus_sent",
                near_sdk::serde_json::json!({
                    "owner": &owner,
                    "amount": surplus.to_string(),
                }),
            );
            // Same predecessor that signed this call. Independent of the batch.
            Promise::new(owner.clone())
                .transfer(NearToken::from_yoctonear(surplus))
                .detach();
        }

        let args = near_sdk::serde_json::json!({
            "owner_public_key": owner_public_key,
            "chain_id": &self.chain_id,
            "deployment_id": format!("chopgate-f5:{gate}"),
        })
        .to_string()
        .into_bytes();

        Promise::new(gate.clone())
            .create_account()
            .transfer(NearToken::from_yoctonear(required))
            .deploy_contract(GATE_WASM.to_vec())
            .function_call("new", args, NearToken::from_yoctonear(0), NEW_GAS)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .with_unused_gas_weight(0)
                    .on_gate_created(owner, gate),
            )
    }

    /// Settle the create batch. Success logs one `gate_created` line and
    /// returns true. Failure logs `gate_create_failed`, refunds
    /// `required_deposit` to `owner` (now, or via `retry_refund`), and the
    /// observable result is false. Writes nothing.
    #[private]
    pub fn on_gate_created(
        &mut self,
        owner: AccountId,
        gate: AccountId,
    ) -> PromiseOrValue<bool> {
        #[allow(deprecated)]
        let succeeded = matches!(env::promise_result(0), PromiseResult::Successful(_));
        if succeeded {
            log_event(
                "gate_created",
                near_sdk::serde_json::json!({
                    "owner": owner,
                    "gate": gate,
                }),
            );
            return PromiseOrValue::Value(true);
        }
        log_event(
            "gate_create_failed",
            near_sdk::serde_json::json!({
                "owner": owner,
                "gate": gate,
            }),
        );
        // Attempt 1 of `REFUND_ATTEMPTS`. Liquidity check only; see `free_yocto`.
        refund_or_next(owner, 1)
    }

    /// Attempts 2..=[`REFUND_ATTEMPTS`] of a failed-create refund. `attempt`
    /// is this execution. The last attempt logs `refund_stuck` and returns
    /// false without panicking when liquidity is still short.
    #[private]
    pub fn retry_refund(&mut self, owner: AccountId, attempt: u8) -> PromiseOrValue<bool> {
        refund_or_next(owner, attempt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::NearToken;
    use sha2::{Digest, Sha256};
    use std::panic::AssertUnwindSafe;

    fn panic_message(err: Box<dyn std::any::Any + Send>) -> String {
        if let Some(message) = err.downcast_ref::<String>() {
            message.clone()
        } else if let Some(message) = err.downcast_ref::<&str>() {
            (*message).to_string()
        } else {
            format!("{err:?}")
        }
    }

    fn set_factory(factory: &str) {
        let ctx = VMContextBuilder::new()
            .current_account_id(factory.parse().unwrap())
            .predecessor_account_id("alice.test.near".parse().unwrap())
            .build();
        near_sdk::testing_env!(ctx);
    }

    #[test]
    fn gate_account_for_format_and_length() {
        let factory_id = "factory.test.near";
        set_factory(factory_id);
        let factory = Factory::new("local-test".into());
        let owner: AccountId = "alice.test.near".parse().unwrap();
        let gate = factory.gate_account_for(owner.clone());
        let text = gate.as_str();
        assert_eq!(text.len(), 1 + 20 + 1 + factory_id.len());
        assert!(text.starts_with('g'));
        assert!(text.ends_with(&format!(".{factory_id}")));
        let hex = &text[1..21];
        assert!(
            hex.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')),
            "hex label {hex}"
        );
        let digest = Sha256::digest(owner.as_bytes());
        let expect: String = digest.iter().take(10).map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, expect);
        assert_eq!(factory.gate_account_for(owner.clone()), gate);

        // 42-char factory: 22 + 42 = 64, the protocol maximum. Still accepted.
        let fit = "b".repeat(42);
        set_factory(&fit);
        let factory = Factory::new("local-test".into());
        let gate = factory.gate_account_for(owner);
        assert_eq!(gate.as_str().len(), 64);
    }

    #[test]
    fn gate_account_for_rejects_overlong_id() {
        let factory_id = "a".repeat(43);
        set_factory(&factory_id);
        let factory = Factory::new("local-test".into());
        let owner: AccountId = "bob.test.near".parse().unwrap();
        let caught = std::panic::catch_unwind(AssertUnwindSafe(|| {
            factory.gate_account_for(owner);
        }));
        let message = panic_message(caught.expect_err("overlong id must panic"));
        assert!(
            message.contains("gate account id rejected"),
            "got {message}"
        );
    }

    #[test]
    fn views_match_formula_and_code_hash() {
        set_factory("factory.test.near");
        let factory = Factory::new("local-test".into());
        let cost = env::storage_byte_cost().as_yoctonear();
        let expected = (GATE_WASM.len() as u128 + GATE_STATE_BYTES) * cost + STATE_RESERVE;
        assert_eq!(factory.required_deposit().0, expected);
        assert_eq!(
            factory.gate_code_hash(),
            "8Qtk3jf4RLpfiB7PeXeuPGYcp4USV2yeN5Zn3d5NpAMj"
        );
        let empty = std::panic::catch_unwind(|| Factory::new(String::new()));
        assert!(empty.is_err(), "empty chain_id must panic");
        let message = panic_message(empty.err().unwrap());
        assert!(message.contains("chain_id required"), "got {message}");
    }

    #[test]
    fn gas_budget_covers_six_attempts_under_300() {
        assert_eq!(REFUND_ATTEMPTS, 6);
        assert!(
            CALLBACK_GAS_TGAS
                >= CALLBACK_OWN_TGAS + u64::from(REFUND_ATTEMPTS - 1) * RETRY_HOP_TGAS
        );
        assert_eq!(
            CALLBACK_GAS_TGAS,
            CALLBACK_OWN_TGAS + u64::from(REFUND_ATTEMPTS - 1) * RETRY_HOP_TGAS
        );
        assert!(MIN_PREPAID_TGAS <= 300);
        assert_eq!(
            MIN_PREPAID_TGAS,
            PARENT_BURN_BUDGET_TGAS + NEW_GAS_TGAS + CALLBACK_GAS_TGAS + GAS_MARGIN_TGAS
        );
        // First retry is attempt 2. Its attached gas is the whole retry reserve,
        // which is CALLBACK_GAS minus the callback's own budget.
        assert_eq!(
            gas_for_attempt(2).as_gas(),
            CALLBACK_GAS.as_gas() - Gas::from_tgas(CALLBACK_OWN_TGAS).as_gas(),
            "gas_for_attempt(2) == CALLBACK_GAS - CALLBACK_OWN"
        );
    }

    /// The sandbox credits a failed batch's transfer before `on_gate_created`,
    /// so this branch is not reached there. Drive all 6 attempts on the host.
    /// `refund_stuck` is allowed only on attempt 6. Nothing pays.
    #[test]
    fn short_balance_schedules_exactly_six_attempts() {
        let factory_id: AccountId = "factory.test.near".parse().unwrap();
        let alice: AccountId = "alice.test.near".parse().unwrap();
        let mut ctx = VMContextBuilder::new()
            .current_account_id(factory_id.clone())
            .predecessor_account_id(factory_id.clone())
            .account_balance(NearToken::from_yoctonear(1))
            .storage_usage(0)
            .build();
        near_sdk::testing_env!(ctx.clone());
        let mut factory = Factory::new("local-test".into());
        let required = factory.required_deposit().0;
        let gate: AccountId = "g00000000000000000000.factory.test.near".parse().unwrap();

        ctx.account_balance = NearToken::from_yoctonear(required / 10);
        #[allow(deprecated)]
        near_sdk::test_utils::testing_env_with_promise_results(
            ctx.clone(),
            PromiseResult::Failed,
        );
        let scheduled = factory.on_gate_created(alice.clone(), gate.clone());
        assert!(
            matches!(scheduled, PromiseOrValue::Promise(_)),
            "attempt 1 must hand off"
        );
        let logs = near_sdk::test_utils::get_logs();
        assert!(logs.iter().any(|line| line.contains("\"event\":\"gate_create_failed\"")));
        assert!(logs.iter().any(|line| line.contains("\"attempt\":\"1\"") && line.contains("refund_retry")));
        assert!(logs.iter().all(|line| !line.contains("refund_stuck") && !line.contains("refund_sent")));

        for attempt in 2..REFUND_ATTEMPTS {
            #[allow(deprecated)]
            near_sdk::test_utils::testing_env_with_promise_results(ctx.clone(), PromiseResult::Failed);
            let step = factory.retry_refund(alice.clone(), attempt);
            assert!(
                matches!(step, PromiseOrValue::Promise(_)),
                "attempt {attempt} must hand off"
            );
            let logs = near_sdk::test_utils::get_logs();
            let marker = format!("\"attempt\":\"{attempt}\"");
            assert!(
                logs.iter().any(|line| line.contains("refund_retry") && line.contains(&marker)),
                "attempt {attempt} logs={logs:?}"
            );
            assert!(
                logs.iter().all(|line| !line.contains("refund_stuck") && !line.contains("refund_sent")),
                "attempt {attempt} paid or stuck early: {logs:?}"
            );
        }

        #[allow(deprecated)]
        near_sdk::test_utils::testing_env_with_promise_results(ctx, PromiseResult::Failed);
        let stuck = factory.retry_refund(alice, REFUND_ATTEMPTS);
        match stuck {
            PromiseOrValue::Value(false) => {}
            PromiseOrValue::Value(true) => panic!("attempt 6 returned true"),
            PromiseOrValue::Promise(_) => panic!("attempt 6 chained another retry"),
        }
        let logs = near_sdk::test_utils::get_logs();
        assert!(
            logs.iter().any(|line| line.contains("refund_stuck") && line.contains("\"attempt\":\"6\"")),
            "logs={logs:?}"
        );
        assert!(logs.iter().all(|line| !line.contains("refund_sent") && !line.contains("refund_retry")));
    }

    #[test]
    fn entry_checks_panic_before_promises() {
        set_factory("factory.test.near");
        let mut factory = Factory::new("local-test".into());
        let required = factory.required_deposit().0;
        let pk: PublicKey = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp"
            .parse()
            .unwrap();

        let mut ctx = VMContextBuilder::new()
            .current_account_id("factory.test.near".parse().unwrap())
            .predecessor_account_id("alice.test.near".parse().unwrap())
            .prepaid_gas(Gas::from_tgas(MIN_PREPAID_TGAS))
            .attached_deposit(NearToken::from_yoctonear(required - 1))
            .build();
        near_sdk::testing_env!(ctx.clone());
        let short = std::panic::catch_unwind(AssertUnwindSafe(|| {
            let _ = factory.create_gate(pk.clone());
        }));
        let message = panic_message(short.expect_err("short deposit"));
        assert!(message.contains("insufficient deposit"), "got {message}");

        ctx.attached_deposit = NearToken::from_yoctonear(required);
        ctx.prepaid_gas = Gas::from_tgas(MIN_PREPAID_TGAS - 1);
        near_sdk::testing_env!(ctx.clone());
        let low = std::panic::catch_unwind(AssertUnwindSafe(|| {
            let _ = factory.create_gate(pk);
        }));
        let message = panic_message(low.expect_err("low gas"));
        assert!(
            message.contains(&format!("prepaid gas below {MIN_PREPAID_TGAS} Tgas")),
            "got {message}"
        );

        ctx.prepaid_gas = Gas::from_tgas(MIN_PREPAID_TGAS);
        near_sdk::testing_env!(ctx.clone());
        let secp: PublicKey = "secp256k1:5r22SrjrDvgY3wdQsnjgxkeAbU1VcM71FYvALEQWihjM3Xk4Be1CpETTqFccChQr4iJwDroSDVmgaWZv2AcXvYeL"
            .parse()
            .unwrap();
        let bad = std::panic::catch_unwind(AssertUnwindSafe(|| {
            let _ = factory.create_gate(secp);
        }));
        let message = panic_message(bad.expect_err("secp256k1"));
        assert!(
            message.contains("owner key must be a 32-byte ed25519 key and not all zero"),
            "got {message}"
        );

        let zero: PublicKey = format!(
            "ed25519:{}",
            bs58::encode([0u8; 32]).into_string()
        )
        .parse()
        .unwrap();
        near_sdk::testing_env!(ctx);
        let rejected = std::panic::catch_unwind(AssertUnwindSafe(|| {
            let _ = factory.create_gate(zero);
        }));
        let message = panic_message(rejected.expect_err("all-zero payload"));
        assert!(
            message.contains("owner key must be a 32-byte ed25519 key and not all zero"),
            "got {message}"
        );
    }

    /// The deploy wasm is the no-feature build: it still embeds `res/chopgate.wasm`
    /// and does not contain the test-only gate double.
    #[test]
    fn deploy_wasm_excludes_test_double() {
        let root = env!("CARGO_MANIFEST_DIR");
        let deploy_path = format!("{root}/out/chopgate_factory.wasm");
        let deploy = std::fs::read(&deploy_path).unwrap_or_else(|err| panic!("read {deploy_path}: {err}"));
        let fixture = include_bytes!("../tests/fixtures/gate_new_unreachable.wasm");
        let expected: &[u8] = &[
            0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
            0x03, 0x02, 0x01, 0x00, 0x07, 0x07, 0x01, 0x03, b'n', b'e', b'w', 0x00, 0x00, 0x0a,
            0x05, 0x01, 0x03, 0x00, 0x00, 0x0b,
        ];
        assert_eq!(fixture, expected, "fixture bytes drifted from the hand encoding");
        let found = deploy.windows(fixture.len()).any(|window| window == fixture.as_slice());
        let deploy_sha = hex::encode(Sha256::digest(&deploy));
        let fixture_sha = hex::encode(Sha256::digest(fixture.as_slice()));
        set_factory("factory.test.near");
        let hash = Factory::new("local-test".into()).gate_code_hash();
        println!(
            "deploy_wasm bytes={} sha256={deploy_sha} fixture_bytes={} fixture_sha256={fixture_sha} fixture_in_deploy={found} gate_code_hash={hash}",
            deploy.len(),
            fixture.len()
        );
        assert!(!found, "test double bytes are inside out/chopgate_factory.wasm");
        assert_eq!(hash, "8Qtk3jf4RLpfiB7PeXeuPGYcp4USV2yeN5Zn3d5NpAMj");
    }
}
