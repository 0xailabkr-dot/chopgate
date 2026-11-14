//! Sandbox tests for the p5 ChopGate factory. The wasm is `out/chopgate_factory.wasm`
//! from `build.sh` (no test features). s14 loads `out-test/chopgate_factory_test_double.wasm`.
//! s15 loads `out-test/chopgate_factory_test_force_retry.wasm`. Named tests s1–s15.
use anyhow::{anyhow, bail, Context, Result};
use chopgate::{
    authorization_bytes, signing_bytes, tier2_config_bytes, Mandate, PendingItem, Permission,
    Tier2Config,
};
use chopgate_factory::{
    CALLBACK_GAS_TGAS, CALLBACK_OWN_TGAS, GAS_MARGIN_TGAS, MIN_PREPAID_TGAS, NEW_GAS_TGAS,
    PARENT_BURN_BUDGET_TGAS, REFUND_ATTEMPTS, RETRY_HOP_TGAS, TEST_FORCE_SHORT_K,
};
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::json_types::U128;
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccountDetails, Gas, NearToken};
use near_workspaces::{Account, AccountId, ContractState, Worker};
use rand::rngs::OsRng;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const CODE_HASH: &str = "8Qtk3jf4RLpfiB7PeXeuPGYcp4USV2yeN5Zn3d5NpAMj";
const WASM_LEN: usize = 537_066;
const GATE_STATE_BYTES: u128 = 2_500;
/// 0.01 NEAR. Factory drift past a gas reward, and a refund whose gas is small.
const LOSS_MAX: u128 = NEAR / 100;
/// 0.05 NEAR. A full deploy burns ~80 Tgas; the signer's gas is above 0.01 NEAR
/// and far below the 5.5 NEAR deposit.
const GAS_PART_MAX: u128 = NEAR / 20;
/// 0.02 NEAR. A failed second create returns `required` and burns only gas.
const REFUND_LOSS_MAX: u128 = NEAR / 50;
/// 0.005 NEAR. Gate balance above `required_deposit` (gas reward only).
const GATE_DRIFT_MAX: u128 = NEAR / 200;
/// secp256k1 key from the near-sdk docs. Parses as PublicKey; the gate's `new`
/// rejects it because the type byte is not ed25519.
const SECP256K1_PK: &str = "secp256k1:5r22SrjrDvgY3wdQsnjgxkeAbU1VcM71FYvALEQWihjM3Xk4Be1CpETTqFccChQr4iJwDroSDVmgaWZv2AcXvYeL";

fn read_wasm(rel: &str) -> Result<Vec<u8>> {
    let path = format!("{}/{rel}", env!("CARGO_MANIFEST_DIR"));
    fs::read(&path).with_context(|| format!("read {path}; build it first"))
}

fn factory_wasm() -> Result<Vec<u8>> {
    read_wasm("out/chopgate_factory.wasm")
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// `RETRY_HOP_TGAS` rule: at least twice the measured max `retry_refund` burn,
/// rounded up to a whole Tgas.
fn min_retry_hop_tgas(max_hop_gas: u64) -> u64 {
    max_hop_gas.saturating_mul(2).div_ceil(1_000_000_000_000)
}

fn ed25519_pk() -> String {
    let key = SigningKey::generate(&mut OsRng);
    format!(
        "ed25519:{}",
        bs58::encode(key.verifying_key().to_bytes()).into_string()
    )
}

fn expected_gate(owner: &AccountId, factory: &AccountId) -> AccountId {
    let digest = Sha256::digest(owner.as_bytes());
    let hex: String = digest.iter().take(10).map(|b| format!("{b:02x}")).collect();
    format!("g{hex}.{factory}")
        .parse()
        .expect("expected gate id")
}

fn code_hash_of(details: &AccountDetails) -> String {
    match &details.contract_state {
        ContractState::LocalHash(hash) => hash.to_string(),
        other => format!("not-local:{other:?}"),
    }
}

fn event_json(result: &ExecutionFinalResult, name: &str) -> Option<Value> {
    for line in result.logs() {
        let Some(rest) = line.strip_prefix("EVENT_JSON:") else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(rest) else {
            continue;
        };
        if v.get("standard").and_then(|s| s.as_str()) == Some("chopgate-factory")
            && v.get("version").and_then(|s| s.as_str()) == Some("1.0.0")
            && v.get("event").and_then(|s| s.as_str()) == Some(name)
        {
            return Some(v);
        }
    }
    None
}

fn assert_pair_event(result: &ExecutionFinalResult, name: &str, owner: &str, gate: &str) {
    let v = event_json(result, name).unwrap_or_else(|| panic!("missing {name} in {:?}", result.logs()));
    let row = &v["data"][0];
    assert_eq!(row["owner"].as_str(), Some(owner), "{name} owner");
    assert_eq!(row["gate"].as_str(), Some(gate), "{name} gate");
}

fn has_event(result: &ExecutionFinalResult, name: &str) -> bool {
    event_json(result, name).is_some()
}

fn failure_text(result: &ExecutionFinalResult) -> String {
    format!("{result:?}")
}

fn loss_of(before: u128, after: u128) -> i128 {
    before as i128 - after as i128
}

fn gas_on(result: &ExecutionFinalResult, id: &AccountId) -> u64 {
    result
        .receipt_outcomes()
        .iter()
        .filter(|o| &o.executor_id == id)
        .map(|o| o.gas_burnt.as_gas())
        .sum()
}

fn gas_with_event(result: &ExecutionFinalResult, name: &str) -> Option<u64> {
    let needle = format!("\"event\":\"{name}\"");
    result
        .receipt_outcomes()
        .iter()
        .find(|o| o.logs.iter().any(|line| line.contains(&needle)))
        .map(|o| o.gas_burnt.as_gas())
}

/// Burn of every `retry_refund` receipt must sit under the gas attached to
/// that hop. The callback receipt is budgeted by `CALLBACK_GAS` instead.
fn assert_retry_budgets(id: &str, result: &ExecutionFinalResult) {
    for outcome in result.receipt_outcomes() {
        let is_callback = outcome.logs.iter().any(|line| {
            line.contains("\"event\":\"gate_created\"") || line.contains("\"event\":\"gate_create_failed\"")
        });
        if is_callback {
            continue;
        }
        for line in &outcome.logs {
            let Some(rest) = line.strip_prefix("EVENT_JSON:") else {
                continue;
            };
            let Ok(v) = serde_json::from_str::<Value>(rest) else {
                continue;
            };
            let event = v.get("event").and_then(|s| s.as_str()).unwrap_or("");
            if event != "refund_retry" && event != "refund_sent" && event != "refund_stuck" {
                continue;
            }
            // Attempt 1 is the callback, budgeted by `CALLBACK_GAS`. Later
            // attempts are attached `(REFUND_ATTEMPTS - attempt + 1) * RETRY_HOP`.
            let attempt: u64 = v["data"][0]["attempt"]
                .as_str()
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            if attempt <= 1 {
                continue;
            }
            let left = u64::from(REFUND_ATTEMPTS).saturating_sub(attempt).saturating_add(1);
            let burnt = outcome.gas_burnt.as_gas();
            let budget = Gas::from_tgas(RETRY_HOP_TGAS.saturating_mul(left)).as_gas();
            assert!(
                burnt < budget,
                "{id} {event} attempt {attempt} burnt {burnt} >= attached {budget}"
            );
        }
    }
}

struct Measured {
    total: u64,
    batch: u64,
    callback: u64,
}

fn measure(id: &str, result: &ExecutionFinalResult, gate: Option<&AccountId>) -> Measured {
    let total = result.total_gas_burnt.as_gas();
    let min = Gas::from_tgas(MIN_PREPAID_TGAS).as_gas();
    assert!(
        total < min,
        "{id} total gas {total} is not under MIN_PREPAID {min}"
    );
    let batch = gate.map(|id| gas_on(result, id)).unwrap_or(0);
    if batch > 0 {
        let budget = Gas::from_tgas(NEW_GAS_TGAS).as_gas();
        assert!(
            batch < budget,
            "{id} batch gas {batch} is not under NEW_GAS {budget}"
        );
    }
    let callback = gas_with_event(result, "gate_created")
        .or_else(|| gas_with_event(result, "gate_create_failed"))
        .unwrap_or(0);
    if callback > 0 {
        let budget = Gas::from_tgas(CALLBACK_GAS_TGAS).as_gas();
        assert!(
            callback < budget,
            "{id} callback gas {callback} is not under CALLBACK_GAS {budget}"
        );
    }
    assert_retry_budgets(id, result);
    Measured {
        total,
        batch,
        callback,
    }
}

fn paid_attempt(result: &ExecutionFinalResult) -> String {
    event_json(result, "refund_sent")
        .and_then(|v| v["data"][0]["attempt"].as_str().map(str::to_string))
        .unwrap_or_else(|| "none".into())
}

fn event_count(result: &ExecutionFinalResult, name: &str) -> usize {
    let needle = format!("\"event\":\"{name}\"");
    result.logs().iter().filter(|line| line.contains(&needle)).count()
}

/// Index of the callback receipt, and of the small factory receipt that is the
/// protocol's return of the failed batch transfer when it sits before the callback.
fn refund_receipt_order(result: &ExecutionFinalResult, factory: &AccountId) -> (Option<usize>, Option<usize>, String) {
    let outs = result.receipt_outcomes();
    let mut callback = None;
    let mut tagged = Vec::new();
    for (i, outcome) in outs.iter().enumerate() {
        let role = if outcome.logs.iter().any(|line| {
            line.contains("\"event\":\"gate_create_failed\"") || line.contains("\"event\":\"gate_created\"")
        }) {
            callback = Some(i);
            "callback"
        } else if outcome.logs.iter().any(|line| line.contains("\"event\":\"refund_sent\"")) {
            "refund_sent"
        } else if outcome.logs.iter().any(|line| line.contains("\"event\":\"surplus_sent\"")) {
            "surplus_sent"
        } else if !outcome.is_success() {
            "batch_fail"
        } else {
            "other"
        };
        tagged.push(format!(
            "{i}:{role}:{}:{}",
            outcome.executor_id,
            outcome.gas_burnt.as_gas()
        ));
    }
    let protocol = callback.and_then(|cb| {
        outs.iter().enumerate().take(cb).find(|(i, outcome)| {
            *i > 0
                && &outcome.executor_id == factory
                && outcome.is_success()
                && outcome.logs.is_empty()
                && outcome.gas_burnt.as_gas() < Gas::from_tgas(1).as_gas()
        }).map(|(i, _)| i)
    });
    (protocol, callback, tagged.join(","))
}

fn receipt_list(result: &ExecutionFinalResult) -> String {
    result
        .receipt_outcomes()
        .iter()
        .map(|o| {
            format!(
                "{}:{}:{}",
                o.executor_id,
                o.gas_burnt.as_gas(),
                if o.is_success() { "ok" } else { "fail" }
            )
        })
        .collect::<Vec<_>>()
        .join(",")
}

async fn sandbox() -> Result<(Worker<Sandbox>, Account)> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    Ok((worker, root))
}

async fn subaccount(parent: &Account, name: &str, yocto: u128) -> Result<Account> {
    parent
        .create_subaccount(name)
        .initial_balance(NearToken::from_yoctonear(yocto))
        .transact()
        .await?
        .into_result()
        .map_err(|e| anyhow!("create subaccount {name}: {e:?}"))
}

async fn deploy_factory(root: &Account, wasm: &[u8], yocto: u128) -> Result<Account> {
    let factory = subaccount(root, "factory", yocto).await?;
    factory
        .deploy(wasm)
        .await?
        .into_result()
        .map_err(|e| anyhow!("deploy factory: {e:?}"))?;
    let init = factory
        .call(factory.id(), "new")
        .args_json(serde_json::json!({"chain_id": "local-test"}))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?;
    if !init.is_success() {
        bail!("factory new failed: {:?}", init.logs());
    }
    Ok(factory)
}

async fn view_u128(account: &Account, contract: &AccountId, method: &str) -> Result<u128> {
    let v: U128 = account.view(contract, method).await?.json()?;
    Ok(v.0)
}

async fn balance(worker: &Worker<Sandbox>, id: &AccountId) -> Result<u128> {
    Ok(worker.view_account(id).await?.balance.as_yoctonear())
}

async fn view_gate_for(factory: &Account, owner: &AccountId) -> Result<AccountId> {
    Ok(factory
        .view(factory.id(), "gate_account_for")
        .args_json(serde_json::json!({"owner": owner}))
        .await?
        .json()?)
}

fn min_gas() -> Gas {
    Gas::from_tgas(MIN_PREPAID_TGAS)
}

async fn create(
    signer: &Account,
    factory: &AccountId,
    pk: &str,
    deposit: u128,
    gas: Gas,
) -> Result<ExecutionFinalResult> {
    Ok(signer
        .call(factory, "create_gate")
        .args_json(serde_json::json!({"owner_public_key": pk}))
        .deposit(NearToken::from_yoctonear(deposit))
        .gas(gas)
        .transact()
        .await?)
}

/// The sandbox posts the signer's unused-gas refund on a later transaction.
/// Two small calls land the previous refund and leave only the second call's
/// prepaid gas outstanding.
async fn settle(account: &Account, factory: &AccountId) -> Result<()> {
    for _ in 0..2 {
        let result = account
            .call(factory, "required_deposit")
            .gas(Gas::from_tgas(3))
            .transact()
            .await?;
        if !result.is_success() {
            bail!("settle required_deposit failed: {result:?}");
        }
    }
    Ok(())
}

fn byte_cost_from(required: u128) -> u128 {
    (required - NEAR / 10) / ((WASM_LEN as u128) + GATE_STATE_BYTES)
}

async fn free_yocto(worker: &Worker<Sandbox>, id: &AccountId, byte_cost: u128) -> Result<u128> {
    let details = worker.view_account(id).await?;
    let stake = (details.storage_usage as u128).saturating_mul(byte_cost);
    Ok(details.balance.as_yoctonear().saturating_sub(stake))
}

#[tokio::test]
async fn s1_success() -> Result<()> {
    let wasm = factory_wasm()?;
    let (worker, root) = sandbox().await?;
    let factory = deploy_factory(&root, &wasm, 30 * NEAR).await?;
    let owner = subaccount(&root, "owner-a", 30 * NEAR).await?;
    let pk = ed25519_pk();
    let required = view_u128(&factory, factory.id(), "required_deposit").await?;
    let cost = byte_cost_from(required);
    assert_eq!(
        (WASM_LEN as u128 + GATE_STATE_BYTES) * cost + NEAR / 10,
        required,
        "required_deposit is (wasm + 2500) * byte_cost + 0.1 NEAR"
    );
    let hash: String = factory.view(factory.id(), "gate_code_hash").await?.json()?;
    assert_eq!(hash, CODE_HASH, "gate_code_hash view");
    let gate = view_gate_for(&factory, owner.id()).await?;
    assert_eq!(gate, expected_gate(owner.id(), factory.id()));

    let owner_before = balance(&worker, owner.id()).await?;
    let factory_before = balance(&worker, factory.id()).await?;
    let storage_before = worker.view_account(factory.id()).await?.storage_usage;

    let result = create(&owner, factory.id(), &pk, required, min_gas()).await?;
    assert!(result.is_success(), "s1 create failed: {result:?}");
    let returned: bool = result.clone().json().context("s1 return")?;
    assert!(returned, "s1 callback returns true");
    assert_pair_event(&result, "gate_created", owner.id().as_str(), gate.as_str());
    assert!(
        result.logs().iter().filter(|l| l.contains("EVENT_JSON:")).count() == 1,
        "s1 success logs exactly one event line: {:?}",
        result.logs()
    );

    let details = worker.view_account(&gate).await?;
    assert_eq!(code_hash_of(&details), CODE_HASH);
    assert_eq!(code_hash_of(&details), hash);
    let (chain_id, deployment_id, _owner): (String, String, near_sdk::PublicKey) = owner
        .view(&gate, "signature_domain")
        .await?
        .json()?;
    let prefix = format!("chopgate-f5:{gate}:");
    assert_eq!(chain_id, "local-test", "s1 chain id");
    assert!(
        deployment_id.starts_with(&prefix),
        "s1 deployment_id {deployment_id} does not start with {prefix}"
    );
    println!(
        "gas_budget min_prepaid_tgas={MIN_PREPAID_TGAS} new_gas_tgas={NEW_GAS_TGAS} callback_gas_tgas={CALLBACK_GAS_TGAS} callback_own_tgas={CALLBACK_OWN_TGAS} retry_hop_tgas={RETRY_HOP_TGAS} refund_attempts={REFUND_ATTEMPTS} parent_burn_budget_tgas={PARENT_BURN_BUDGET_TGAS} margin_tgas={GAS_MARGIN_TGAS} max_tgas=300"
    );
    assert!(MIN_PREPAID_TGAS <= 300, "MIN_PREPAID above 300");
    let gate_balance = details.balance.as_yoctonear();
    assert!(gate_balance >= required, "gate balance {gate_balance} < required {required}");
    assert!(
        gate_balance - required < GATE_DRIFT_MAX,
        "gate reward {} >= 0.005 NEAR",
        gate_balance - required
    );

    let factory_after = balance(&worker, factory.id()).await?;
    let storage_after = worker.view_account(factory.id()).await?.storage_usage;
    assert_eq!(storage_before, storage_after, "s1 factory storage is unchanged");
    let factory_delta = factory_after as i128 - factory_before as i128;
    assert!(
        factory_delta.unsigned_abs() < LOSS_MAX,
        "s1 factory delta {factory_delta} is not only a gas reward"
    );

    settle(&owner, factory.id()).await?;
    let owner_after = balance(&worker, owner.id()).await?;
    let owner_delta = loss_of(owner_before, owner_after);
    assert!(owner_delta > required as i128, "s1 owner paid less than required: {owner_delta}");
    let gas_part = owner_delta - (required as i128);
    assert!(
        gas_part < GAS_PART_MAX as i128,
        "s1 owner gas {gas_part} is not a gas-sized amount"
    );

    let measured = measure("s1_success", &result, Some(&gate));
    assert!(measured.batch > 0, "s1 missing batch receipt. {}", receipt_list(&result));
    assert!(measured.callback > 0, "s1 missing callback receipt");
    println!(
        "s1_success required_yocto={required} owner_delta_yocto={owner_delta} factory_delta_yocto={factory_delta} gate_balance_yocto={gate_balance} gate_reward_yocto={} deployment_id={deployment_id} total_gas={} batch_gas={} callback_gas={} tx_gas={} new_gas_tgas={NEW_GAS_TGAS} callback_gas_tgas={CALLBACK_GAS_TGAS} min_prepaid_tgas={MIN_PREPAID_TGAS} receipts={}",
        gate_balance - required,
        measured.total,
        measured.batch,
        measured.callback,
        result.outcome().gas_burnt.as_gas(),
        receipt_list(&result)
    );
    Ok(())
}

#[tokio::test]
async fn s2_second_call_same_owner_refunded() -> Result<()> {
    let wasm = factory_wasm()?;
    let (worker, root) = sandbox().await?;
    let factory = deploy_factory(&root, &wasm, 30 * NEAR).await?;
    let owner = subaccount(&root, "owner-a", 30 * NEAR).await?;
    let pk = ed25519_pk();
    let required = view_u128(&factory, factory.id(), "required_deposit").await?;
    let gate = view_gate_for(&factory, owner.id()).await?;

    let first = create(&owner, factory.id(), &pk, required, min_gas()).await?;
    assert!(first.is_success(), "s2 setup create: {}", failure_text(&first));
    assert!(first.json::<bool>()?, "s2 setup callback was false");
    assert!(worker.view_account(&gate).await.is_ok(), "s2 gate exists");
    settle(&owner, factory.id()).await?;

    let owner_before = balance(&worker, owner.id()).await?;
    let factory_before = balance(&worker, factory.id()).await?;
    let second = create(&owner, factory.id(), &pk, required, min_gas()).await?;
    assert!(second.is_success(), "s2 outer call should succeed: {second:?}");
    let returned: bool = second.clone().json().context("s2 return")?;
    assert!(!returned, "s2 callback returns false");
    assert_pair_event(&second, "gate_create_failed", owner.id().as_str(), gate.as_str());
    assert!(!has_event(&second, "gate_created"), "s2 no gate_created");
    assert!(has_event(&second, "refund_sent"), "s2 immediate refund log");

    let factory_after = balance(&worker, factory.id()).await?;
    let factory_delta = factory_after as i128 - factory_before as i128;
    assert!(
        factory_delta.unsigned_abs() < LOSS_MAX,
        "s2 factory not back within 0.01 NEAR, delta={factory_delta}"
    );
    settle(&owner, factory.id()).await?;
    let owner_loss = loss_of(owner_before, balance(&worker, owner.id()).await?);
    assert!(owner_loss < LOSS_MAX as i128, "s2 owner loss {owner_loss} >= 0.01 NEAR");
    assert!(owner_loss > -(NEAR as i128) / 2, "s2 refund paid twice, loss={owner_loss}");

    let measured = measure("s2_second_call_same_owner_refunded", &second, Some(&gate));
    println!(
        "s2_second_call_same_owner_refunded required_yocto={required} owner_loss_yocto={owner_loss} factory_delta_yocto={factory_delta} returned=false total_gas={} batch_gas={} callback_gas={} min_prepaid_tgas={MIN_PREPAID_TGAS} receipts={}",
        measured.total,
        measured.batch,
        measured.callback,
        receipt_list(&second)
    );
    Ok(())
}

#[tokio::test]
async fn s3_non_ed25519_key_rejected_at_entry() -> Result<()> {
    let wasm = factory_wasm()?;
    let (worker, root) = sandbox().await?;
    let factory = deploy_factory(&root, &wasm, 30 * NEAR).await?;
    let owner = subaccount(&root, "owner-a", 30 * NEAR).await?;
    let required = view_u128(&factory, factory.id(), "required_deposit").await?;
    let gate = view_gate_for(&factory, owner.id()).await?;
    let owner_before = balance(&worker, owner.id()).await?;
    let factory_before = balance(&worker, factory.id()).await?;

    let result = create(&owner, factory.id(), SECP256K1_PK, required, min_gas()).await?;
    assert!(!result.is_success(), "s3 must panic at entry");
    let text = failure_text(&result);
    let key_panic = "owner key must be a 32-byte ed25519 key and not all zero";
    assert!(text.contains(key_panic), "s3 panic text: {text}");
    assert!(!has_event(&result, "gate_created") && !has_event(&result, "gate_create_failed"));
    assert!(worker.view_account(&gate).await.is_err(), "s3 no gate");

    let factory_delta = balance(&worker, factory.id()).await? as i128 - factory_before as i128;
    settle(&owner, factory.id()).await?;
    let owner_loss = loss_of(owner_before, balance(&worker, owner.id()).await?);
    assert!(owner_loss < LOSS_MAX as i128, "s3 owner loss {owner_loss}");
    assert!(owner_loss > -(NEAR as i128) / 2, "s3 deposit not back, loss={owner_loss}");

    let measured = measure("s3_non_ed25519_key_rejected_at_entry", &result, None);
    println!(
        "s3_non_ed25519_key_rejected_at_entry required_yocto={required} owner_loss_yocto={owner_loss} factory_delta_yocto={factory_delta} total_gas={} min_prepaid_tgas={MIN_PREPAID_TGAS} panic={key_panic}",
        measured.total
    );
    Ok(())
}

#[tokio::test]
async fn s4_insufficient_deposit_rejected() -> Result<()> {
    let wasm = factory_wasm()?;
    let (worker, root) = sandbox().await?;
    let factory = deploy_factory(&root, &wasm, 30 * NEAR).await?;
    let owner = subaccount(&root, "owner-a", 30 * NEAR).await?;
    let pk = ed25519_pk();
    let required = view_u128(&factory, factory.id(), "required_deposit").await?;
    let gate = view_gate_for(&factory, owner.id()).await?;
    let short = required - 1;
    let owner_before = balance(&worker, owner.id()).await?;
    let factory_before = balance(&worker, factory.id()).await?;

    let result = create(&owner, factory.id(), &pk, short, min_gas()).await?;
    assert!(!result.is_success(), "s4 must panic");
    let text = failure_text(&result);
    assert!(text.contains("insufficient deposit"), "s4 panic text: {text}");
    assert!(!has_event(&result, "gate_created") && !has_event(&result, "gate_create_failed"));
    assert!(worker.view_account(&gate).await.is_err(), "s4 no gate");

    let factory_delta = balance(&worker, factory.id()).await? as i128 - factory_before as i128;
    settle(&owner, factory.id()).await?;
    let owner_loss = loss_of(owner_before, balance(&worker, owner.id()).await?);
    assert!(owner_loss < LOSS_MAX as i128, "s4 owner loss {owner_loss}");
    assert!(owner_loss > -(NEAR as i128) / 2, "s4 deposit not fully back, loss={owner_loss}");

    let measured = measure("s4_insufficient_deposit_rejected", &result, None);
    println!(
        "s4_insufficient_deposit_rejected required_yocto={required} attached_yocto={short} owner_loss_yocto={owner_loss} factory_delta_yocto={factory_delta} total_gas={} min_prepaid_tgas={MIN_PREPAID_TGAS}",
        measured.total
    );
    Ok(())
}

#[tokio::test]
async fn s5_surplus_refunded() -> Result<()> {
    let wasm = factory_wasm()?;
    let (worker, root) = sandbox().await?;
    let factory = deploy_factory(&root, &wasm, 30 * NEAR).await?;
    let owner = subaccount(&root, "owner-a", 30 * NEAR).await?;
    let pk = ed25519_pk();
    let required = view_u128(&factory, factory.id(), "required_deposit").await?;
    let extra = NEAR / 4;
    let attached = required + extra;
    let gate = view_gate_for(&factory, owner.id()).await?;
    let owner_before = balance(&worker, owner.id()).await?;
    let factory_before = balance(&worker, factory.id()).await?;

    let result = create(&owner, factory.id(), &pk, attached, min_gas()).await?;
    assert!(result.is_success(), "s5 create failed: {result:?}");
    let returned: bool = result.clone().json().context("s5 return")?;
    assert!(returned, "s5 callback returns true");
    assert_pair_event(&result, "gate_created", owner.id().as_str(), gate.as_str());
    assert_eq!(event_count(&result, "gate_created"), 1, "s5 one gate_created");
    assert!(!has_event(&result, "gate_create_failed"), "s5 no failure event");
    let surplus = event_json(&result, "surplus_sent").expect("s5 surplus_sent");
    assert_eq!(surplus["data"][0]["owner"].as_str(), Some(owner.id().as_str()));
    assert_eq!(surplus["data"][0]["amount"].as_str(), Some(extra.to_string().as_str()));
    let owner_receipts = result
        .receipt_outcomes()
        .iter()
        .filter(|outcome| &outcome.executor_id == owner.id() && outcome.is_success())
        .count();
    assert!(owner_receipts >= 1, "s5 transfer receipt to the owner");

    let gate_balance = worker.view_account(&gate).await?.balance.as_yoctonear();
    assert!(gate_balance >= required);
    assert!(
        gate_balance - required < GATE_DRIFT_MAX,
        "s5 surplus landed on the gate: reward {}",
        gate_balance - required
    );
    let factory_delta = balance(&worker, factory.id()).await? as i128 - factory_before as i128;
    assert!(factory_delta.unsigned_abs() < LOSS_MAX, "s5 factory delta {factory_delta}");

    settle(&owner, factory.id()).await?;
    let owner_delta = loss_of(owner_before, balance(&worker, owner.id()).await?);
    assert!(owner_delta > required as i128, "s5 owner delta {owner_delta} required {required}");
    let gas_part = owner_delta - (required as i128);
    assert!(
        gas_part < GAS_PART_MAX as i128,
        "s5 surplus not back, gas_part={gas_part}"
    );

    let measured = measure("s5_surplus_refunded", &result, Some(&gate));
    println!(
        "s5_surplus_refunded required_yocto={required} attached_yocto={attached} surplus_yocto={extra} owner_delta_yocto={owner_delta} factory_delta_yocto={factory_delta} gate_balance_yocto={gate_balance} total_gas={} batch_gas={} callback_gas={} min_prepaid_tgas={MIN_PREPAID_TGAS}",
        measured.total, measured.batch, measured.callback
    );
    Ok(())
}

#[tokio::test]
async fn s6_low_gas_rejected_at_entry() -> Result<()> {
    let wasm = factory_wasm()?;
    let (worker, root) = sandbox().await?;
    let factory = deploy_factory(&root, &wasm, 30 * NEAR).await?;
    let owner = subaccount(&root, "owner-a", 30 * NEAR).await?;
    let pk = ed25519_pk();
    let required = view_u128(&factory, factory.id(), "required_deposit").await?;
    let gate = view_gate_for(&factory, owner.id()).await?;
    let gas = Gas::from_tgas(MIN_PREPAID_TGAS - 1);
    let owner_before = balance(&worker, owner.id()).await?;
    let factory_before = balance(&worker, factory.id()).await?;

    let result = create(&owner, factory.id(), &pk, required, gas).await?;
    assert!(!result.is_success(), "s6 must panic at entry");
    let text = failure_text(&result);
    assert!(
        text.contains(&format!("prepaid gas below {MIN_PREPAID_TGAS} Tgas")),
        "s6 panic text: {text}"
    );
    assert!(!has_event(&result, "gate_created") && !has_event(&result, "gate_create_failed"));
    assert!(worker.view_account(&gate).await.is_err(), "s6 no gate");

    let factory_delta = balance(&worker, factory.id()).await? as i128 - factory_before as i128;
    settle(&owner, factory.id()).await?;
    let owner_loss = loss_of(owner_before, balance(&worker, owner.id()).await?);
    assert!(owner_loss < LOSS_MAX as i128, "s6 owner loss {owner_loss}");
    assert!(owner_loss > -(NEAR as i128) / 2, "s6 deposit not back, loss={owner_loss}");

    let measured = measure("s6_low_gas_rejected_at_entry", &result, None);
    println!(
        "s6_low_gas_rejected_at_entry required_yocto={required} prepaid_tgas={} owner_loss_yocto={owner_loss} factory_delta_yocto={factory_delta} total_gas={} min_prepaid_tgas={MIN_PREPAID_TGAS}",
        MIN_PREPAID_TGAS - 1,
        measured.total
    );
    Ok(())
}

#[tokio::test]
async fn s7_callback_not_callable_by_others() -> Result<()> {
    let wasm = factory_wasm()?;
    let (worker, root) = sandbox().await?;
    let factory = deploy_factory(&root, &wasm, 30 * NEAR).await?;
    let intruder = subaccount(&root, "intruder", 10 * NEAR).await?;
    let victim = subaccount(&root, "victim", 10 * NEAR).await?;
    let gate = view_gate_for(&factory, victim.id()).await?;
    let factory_before = balance(&worker, factory.id()).await?;
    let victim_before = balance(&worker, victim.id()).await?;
    let intruder_before = balance(&worker, intruder.id()).await?;

    let callback = intruder
        .call(factory.id(), "on_gate_created")
        .args_json(serde_json::json!({"owner": victim.id(), "gate": gate}))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?;
    assert!(!callback.is_success(), "s7 on_gate_created must fail");
    let callback_text = failure_text(&callback);
    assert!(
        callback_text.contains("Method on_gate_created is private"),
        "s7 callback text: {callback_text}"
    );

    let retry = intruder
        .call(factory.id(), "retry_refund")
        .args_json(serde_json::json!({"owner": victim.id(), "attempt": 2}))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?;
    assert!(!retry.is_success(), "s7 retry_refund must fail");
    let retry_text = failure_text(&retry);
    assert!(
        retry_text.contains("Method retry_refund is private"),
        "s7 retry text: {retry_text}"
    );

    let victim_delta = balance(&worker, victim.id()).await? as i128 - victim_before as i128;
    assert_eq!(victim_delta, 0, "s7 victim balance changed by {victim_delta}");
    let factory_delta = balance(&worker, factory.id()).await? as i128 - factory_before as i128;
    assert!(
        factory_delta.unsigned_abs() < LOSS_MAX,
        "s7 factory moved {factory_delta}"
    );
    settle(&intruder, factory.id()).await?;
    let intruder_loss = loss_of(intruder_before, balance(&worker, intruder.id()).await?);
    let callback_gas = callback.total_gas_burnt.as_gas();
    let retry_gas = retry.total_gas_burnt.as_gas();
    println!(
        "s7_callback_not_callable_by_others victim_delta_yocto={victim_delta} factory_delta_yocto={factory_delta} intruder_loss_yocto={intruder_loss} callback_total_gas={callback_gas} retry_total_gas={retry_gas} refund_attempts={REFUND_ATTEMPTS}"
    );
    Ok(())
}

#[tokio::test]
async fn s8_two_owners_same_block() -> Result<()> {
    let wasm = factory_wasm()?;
    let (worker, root) = sandbox().await?;
    let factory = deploy_factory(&root, &wasm, 40 * NEAR).await?;
    let alice = subaccount(&root, "owner-a", 30 * NEAR).await?;
    let bob = subaccount(&root, "owner-b", 30 * NEAR).await?;
    let pk_a = ed25519_pk();
    let pk_b = ed25519_pk();
    let required = view_u128(&factory, factory.id(), "required_deposit").await?;
    let gate_a = view_gate_for(&factory, alice.id()).await?;
    let gate_b = view_gate_for(&factory, bob.id()).await?;
    assert_ne!(gate_a, gate_b);

    let gas = min_gas();
    let status_a = alice
        .call(factory.id(), "create_gate")
        .args_json(serde_json::json!({"owner_public_key": pk_a}))
        .deposit(NearToken::from_yoctonear(required))
        .gas(gas)
        .transact_async()
        .await?;
    let status_b = bob
        .call(factory.id(), "create_gate")
        .args_json(serde_json::json!({"owner_public_key": pk_b}))
        .deposit(NearToken::from_yoctonear(required))
        .gas(gas)
        .transact_async()
        .await?;
    let result_a = status_a.await?;
    let result_b = status_b.await?;
    assert!(result_a.is_success(), "s8 alice failed: {}", failure_text(&result_a));
    assert!(result_a.clone().json::<bool>()?, "s8 alice callback was false");
    assert!(result_b.is_success(), "s8 bob failed: {}", failure_text(&result_b));
    assert!(result_b.clone().json::<bool>()?, "s8 bob callback was false");
    assert_pair_event(&result_a, "gate_created", alice.id().as_str(), gate_a.as_str());
    assert_pair_event(&result_b, "gate_created", bob.id().as_str(), gate_b.as_str());
    assert_eq!(code_hash_of(&worker.view_account(&gate_a).await?), CODE_HASH);
    assert_eq!(code_hash_of(&worker.view_account(&gate_b).await?), CODE_HASH);

    let height_a = worker.view_block().block_hash(result_a.outcome().block_hash).await?.height();
    let height_b = worker.view_block().block_hash(result_b.outcome().block_hash).await?.height();
    let same = height_a == height_b;
    let measured_a = measure("s8_two_owners_same_block", &result_a, Some(&gate_a));
    let measured_b = measure("s8_two_owners_same_block", &result_b, Some(&gate_b));
    println!(
        "s8_two_owners_same_block required_yocto={required} height_a={height_a} height_b={height_b} same_block={same} total_gas_a={} total_gas_b={} batch_gas_a={} batch_gas_b={} callback_gas_a={} callback_gas_b={}",
        measured_a.total,
        measured_b.total,
        measured_a.batch,
        measured_b.batch,
        measured_a.callback,
        measured_b.callback
    );
    Ok(())
}

#[tokio::test]
async fn s9_gate_has_zero_access_keys() -> Result<()> {
    let wasm = factory_wasm()?;
    let (worker, root) = sandbox().await?;
    let factory = deploy_factory(&root, &wasm, 30 * NEAR).await?;
    let owner = subaccount(&root, "owner-a", 30 * NEAR).await?;
    let pk = ed25519_pk();
    let required = view_u128(&factory, factory.id(), "required_deposit").await?;
    let gate = view_gate_for(&factory, owner.id()).await?;
    let result = create(&owner, factory.id(), &pk, required, min_gas()).await?;
    assert!(result.is_success(), "s9 create failed: {}", failure_text(&result));
    assert!(result.clone().json::<bool>()?, "s9 callback was false");
    let keys = worker.view_access_keys(&gate).await?;
    assert!(keys.is_empty(), "s9 gate access keys: {keys:?}");
    let measured = measure("s9_gate_has_zero_access_keys", &result, Some(&gate));
    println!(
        "s9_gate_has_zero_access_keys required_yocto={required} access_key_count=0 gate={} total_gas={} batch_gas={} callback_gas={}",
        gate,
        measured.total,
        measured.batch,
        measured.callback
    );
    Ok(())
}

async fn drain_free(
    factory: &Account,
    root: &Account,
    worker: &Worker<Sandbox>,
    cost: u128,
    keep: u128,
) -> Result<u128> {
    let before = free_yocto(worker, factory.id(), cost).await?;
    assert!(before > keep, "drain free {before} is not above keep {keep}");
    let drained = factory
        .transfer_near(root.id(), NearToken::from_yoctonear(before - keep))
        .await?;
    assert!(drained.is_success(), "drain failed: {drained:?}");
    Ok(free_yocto(worker, factory.id(), cost).await?)
}

fn sign_domain(
    key: &SigningKey,
    chain_id: &str,
    deployment_id: &str,
    owner: &near_sdk::PublicKey,
    payload: &[u8],
) -> String {
    hex::encode(key.sign(&authorization_bytes(chain_id, deployment_id, owner, payload)).to_bytes())
}

fn instruction_hash(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

fn reason_of(result: &ExecutionFinalResult) -> String {
    match result.clone().json::<Value>() {
        Ok(v) => v.get("reason_code").and_then(|c| c.as_str()).unwrap_or("?").to_string(),
        Err(_) => format!("<failed> {}", failure_text(result)),
    }
}

fn pk_of(key: &SigningKey) -> String {
    format!("ed25519:{}", bs58::encode(key.verifying_key().to_bytes()).into_string())
}

/// Second create by the same owner, after the factory's free float was drained
/// to about 0. The failing batch is "account exists".
#[tokio::test]
async fn s10_zero_float_failed_create_refunded() -> Result<()> {
    let wasm = factory_wasm()?;
    let (worker, root) = sandbox().await?;
    let factory = deploy_factory(&root, &wasm, 30 * NEAR).await?;
    let owner = subaccount(&root, "owner-a", 30 * NEAR).await?;
    let pk = ed25519_pk();
    let required = view_u128(&factory, factory.id(), "required_deposit").await?;
    let cost = byte_cost_from(required);
    let gate = view_gate_for(&factory, owner.id()).await?;

    let first = create(&owner, factory.id(), &pk, required, min_gas()).await?;
    assert!(first.is_success() && first.json::<bool>()?, "s10 setup create");
    settle(&owner, factory.id()).await?;
    let free = drain_free(&factory, &root, &worker, cost, NEAR / 1000).await?;
    assert!(free < NEAR / 100, "s10 free {free} is not under 0.01 NEAR");

    let owner_before = balance(&worker, owner.id()).await?;
    let factory_before = balance(&worker, factory.id()).await?;
    let result = create(&owner, factory.id(), &pk, required, min_gas()).await?;
    assert!(result.is_success(), "s10 outer call: {result:?}");
    let returned: bool = result.clone().json().context("s10 return")?;
    assert!(!returned, "s10 callback result is not false");
    assert_eq!(event_count(&result, "refund_sent"), 1, "s10 one refund_sent: {:?}", result.logs());
    assert_eq!(event_count(&result, "refund_stuck"), 0, "s10 stuck: {:?}", result.logs());
    assert!(worker.view_account(&gate).await.is_ok(), "s10 the first gate remains");
    let attempt = paid_attempt(&result);
    let retry_observed = has_event(&result, "refund_retry");
    let factory_delta = balance(&worker, factory.id()).await? as i128 - factory_before as i128;
    settle(&owner, factory.id()).await?;
    let owner_loss = loss_of(owner_before, balance(&worker, owner.id()).await?);
    assert!(owner_loss < REFUND_LOSS_MAX as i128, "s10 owner loss {owner_loss}");
    assert!(owner_loss > -(NEAR as i128) / 2, "s10 paid twice, loss={owner_loss}");
    let (protocol_idx, callback_idx, order) = refund_receipt_order(&result, factory.id());
    let measured = measure("s10_zero_float_failed_create_refunded", &result, Some(&gate));
    println!(
        "s10_zero_float_failed_create_refunded required_yocto={required} free_before_yocto={free} owner_loss_yocto={owner_loss} factory_delta_yocto={factory_delta} returned=false attempt={attempt} retry_observed={retry_observed} protocol_refund_idx={protocol_idx:?} callback_idx={callback_idx:?} total_gas={} batch_gas={} callback_gas={} order={order}",
        measured.total, measured.batch, measured.callback
    );
    Ok(())
}

/// Two owners who already have gates fail a second create back to back on a
/// factory whose free float is below `required_deposit`.
#[tokio::test]
async fn s11_two_overlapping_failures_both_refunded() -> Result<()> {
    let wasm = factory_wasm()?;
    let (worker, root) = sandbox().await?;
    let factory = deploy_factory(&root, &wasm, 40 * NEAR).await?;
    let alice = subaccount(&root, "owner-a", 30 * NEAR).await?;
    let bob = subaccount(&root, "owner-b", 30 * NEAR).await?;
    let pk_a = ed25519_pk();
    let pk_b = ed25519_pk();
    let required = view_u128(&factory, factory.id(), "required_deposit").await?;
    let cost = byte_cost_from(required);
    let gate_a = view_gate_for(&factory, alice.id()).await?;
    let gate_b = view_gate_for(&factory, bob.id()).await?;
    for (owner, pk) in [(&alice, &pk_a), (&bob, &pk_b)] {
        let created = create(owner, factory.id(), pk, required, min_gas()).await?;
        assert!(created.is_success() && created.json::<bool>()?, "s11 setup {}", owner.id());
        settle(owner, factory.id()).await?;
    }
    let free = drain_free(&factory, &root, &worker, cost, NEAR).await?;
    assert!(free < required, "s11 free {free} is not below required {required}");

    let alice_before = balance(&worker, alice.id()).await?;
    let bob_before = balance(&worker, bob.id()).await?;
    let factory_before = balance(&worker, factory.id()).await?;
    let gas = min_gas();
    let status_a = alice
        .call(factory.id(), "create_gate")
        .args_json(serde_json::json!({"owner_public_key": pk_a}))
        .deposit(NearToken::from_yoctonear(required))
        .gas(gas)
        .transact_async()
        .await?;
    let status_b = bob
        .call(factory.id(), "create_gate")
        .args_json(serde_json::json!({"owner_public_key": pk_b}))
        .deposit(NearToken::from_yoctonear(required))
        .gas(gas)
        .transact_async()
        .await?;
    let result_a = status_a.await?;
    let result_b = status_b.await?;
    for (label, result, owner) in [("a", &result_a, &alice), ("b", &result_b, &bob)] {
        assert!(result.is_success(), "s11 {label} outer: {}", failure_text(result));
        assert!(!result.clone().json::<bool>()?, "s11 {label} callback was true");
        assert_eq!(event_count(result, "refund_sent"), 1, "s11 {label} refund_sent {:?}", result.logs());
        assert_eq!(event_count(result, "refund_stuck"), 0, "s11 {label} stuck {:?}", result.logs());
        let _ = owner;
    }
    let factory_delta = balance(&worker, factory.id()).await? as i128 - factory_before as i128;
    assert!(
        factory_delta.unsigned_abs() < LOSS_MAX,
        "s11 factory delta {factory_delta}"
    );
    settle(&alice, factory.id()).await?;
    settle(&bob, factory.id()).await?;
    let loss_a = loss_of(alice_before, balance(&worker, alice.id()).await?);
    let loss_b = loss_of(bob_before, balance(&worker, bob.id()).await?);
    assert!(loss_a < REFUND_LOSS_MAX as i128 && loss_a > -(NEAR as i128) / 2, "s11 alice {loss_a}");
    assert!(loss_b < REFUND_LOSS_MAX as i128 && loss_b > -(NEAR as i128) / 2, "s11 bob {loss_b}");
    let height_a = worker.view_block().block_hash(result_a.outcome().block_hash).await?.height();
    let height_b = worker.view_block().block_hash(result_b.outcome().block_hash).await?.height();
    let (proto_a, cb_a, order_a) = refund_receipt_order(&result_a, factory.id());
    let (proto_b, cb_b, order_b) = refund_receipt_order(&result_b, factory.id());
    println!(
        "s11_two_overlapping_failures_both_refunded required_yocto={required} free_before_yocto={free} loss_a_yocto={loss_a} loss_b_yocto={loss_b} factory_delta_yocto={factory_delta} attempt_a={} attempt_b={} height_a={height_a} height_b={height_b} same_block={} protocol_a={proto_a:?} callback_a={cb_a:?} protocol_b={proto_b:?} callback_b={cb_b:?} retry_a={} retry_b={} order_a={order_a} order_b={order_b}",
        paid_attempt(&result_a),
        paid_attempt(&result_b),
        height_a == height_b,
        has_event(&result_a, "refund_retry"),
        has_event(&result_b, "refund_retry")
    );
    let _ = (gate_a, gate_b);
    Ok(())
}

#[tokio::test]
async fn s12_exact_min_gas_with_surplus() -> Result<()> {
    let wasm = factory_wasm()?;
    let (worker, root) = sandbox().await?;
    let factory = deploy_factory(&root, &wasm, 30 * NEAR).await?;
    let owner = subaccount(&root, "owner-a", 30 * NEAR).await?;
    let pk = ed25519_pk();
    let required = view_u128(&factory, factory.id(), "required_deposit").await?;
    let extra = NEAR / 10;
    let attached = required + extra;
    let gate = view_gate_for(&factory, owner.id()).await?;
    let owner_before = balance(&worker, owner.id()).await?;
    let gas = min_gas();
    assert_eq!(gas.as_gas(), Gas::from_tgas(MIN_PREPAID_TGAS).as_gas());

    let result = create(&owner, factory.id(), &pk, attached, gas).await?;
    assert!(result.is_success(), "s12 create failed: {result:?}");
    assert!(result.clone().json::<bool>()?, "s12 callback was false");
    assert!(worker.view_account(&gate).await.is_ok(), "s12 gate exists");
    assert_eq!(code_hash_of(&worker.view_account(&gate).await?), CODE_HASH);
    let surplus = event_json(&result, "surplus_sent").expect("s12 surplus_sent");
    assert_eq!(surplus["data"][0]["amount"].as_str(), Some(extra.to_string().as_str()));
    let owner_receipts = result
        .receipt_outcomes()
        .iter()
        .filter(|outcome| &outcome.executor_id == owner.id() && outcome.is_success())
        .count();
    assert!(owner_receipts >= 1, "s12 transfer receipt to the owner");
    let gate_balance = worker.view_account(&gate).await?.balance.as_yoctonear();
    assert!(gate_balance - required < GATE_DRIFT_MAX, "s12 surplus stayed on the gate");
    settle(&owner, factory.id()).await?;
    let owner_delta = loss_of(owner_before, balance(&worker, owner.id()).await?);
    let gas_part = owner_delta - (required as i128);
    assert!(owner_delta > required as i128 && gas_part < GAS_PART_MAX as i128, "s12 gas_part={gas_part}");
    let measured = measure("s12_exact_min_gas_with_surplus", &result, Some(&gate));
    println!(
        "s12_exact_min_gas_with_surplus required_yocto={required} attached_yocto={attached} surplus_yocto={extra} prepaid_tgas={MIN_PREPAID_TGAS} owner_delta_yocto={owner_delta} gas_part_yocto={gas_part} gate_balance_yocto={gate_balance} total_gas={} batch_gas={} callback_gas={}",
        measured.total, measured.batch, measured.callback
    );
    Ok(())
}

/// Bytes of one register, one paid tiered record, one refused record, and one
/// pending hold. 0.1 NEAR prices 10_000 bytes at 10^19 yoctoNEAR per byte.
#[tokio::test]
async fn s13_gate_reserve_capacity() -> Result<()> {
    let wasm = factory_wasm()?;
    let (worker, root) = sandbox().await?;
    let factory = deploy_factory(&root, &wasm, 30 * NEAR).await?;
    let owner = subaccount(&root, "owner-a", 30 * NEAR).await?;
    let agent = subaccount(&owner, "agent", NEAR).await?;
    let payee = subaccount(&root, "payee", 5 * NEAR).await?;
    let attacker = subaccount(&root, "attacker", NEAR).await?;
    let key = SigningKey::generate(&mut OsRng);
    let pk = pk_of(&key);
    let required = view_u128(&factory, factory.id(), "required_deposit").await?;
    let created = create(&owner, factory.id(), &pk, required, min_gas()).await?;
    assert!(
        created.is_success() && created.clone().json::<bool>()?,
        "s13 create: {}",
        failure_text(&created)
    );
    let gate = view_gate_for(&factory, owner.id()).await?;
    let (chain_id, deployment_id, owner_pk): (String, String, near_sdk::PublicKey) =
        owner.view(&gate, "signature_domain").await?.json()?;
    let deposit = owner
        .call(&gate, "deposit")
        .deposit(NearToken::from_near(3))
        .gas(Gas::from_tgas(50))
        .transact()
        .await?;
    assert!(deposit.is_success(), "s13 deposit: {:?}", deposit.logs());

    let config = Tier2Config {
        config_nonce: 1,
        amount_threshold: U128(NEAR / 2),
        pending_ttl_ns: 3_600_000_000_000,
        new_payee_check: false,
        trusted_sources: vec![],
        known_payees: vec![],
        denied_targets: vec![],
    };
    let config_sig = sign_domain(
        &key,
        &chain_id,
        &deployment_id,
        &owner_pk,
        &tier2_config_bytes(&gate, &config),
    );
    let set = owner
        .call(&gate, "set_tier2_config")
        .args_json(serde_json::json!({"config": config, "signature": config_sig}))
        .gas(Gas::from_tgas(80))
        .transact()
        .await?;
    assert!(set.is_success(), "s13 set_tier2_config: {:?}", set.logs());

    let text_a = "pay 0.1 NEAR to P for invoice 1";
    let text_b = "pay 1 NEAR to P for invoice 2";
    let mandate = Mandate {
        serial: 1,
        agent: agent.id().clone(),
        entries: vec![
            Permission {
                action: "transfer".into(),
                target: payee.id().to_string(),
                max_amount: U128(NEAR / 10),
                instruction_hash: instruction_hash(text_a),
            },
            Permission {
                action: "transfer".into(),
                target: payee.id().to_string(),
                max_amount: U128(2 * NEAR),
                instruction_hash: instruction_hash(text_b),
            },
        ],
        budget: U128(3 * NEAR),
        expires_at: 4_000_000_000_000_000_000,
        parent_serial: None,
    };
    let reg_sig = sign_domain(
        &key,
        &chain_id,
        &deployment_id,
        &owner_pk,
        &signing_bytes(&gate, &mandate),
    );
    let before_reg = worker.view_account(&gate).await?.storage_usage;
    let registered = agent
        .call(&gate, "register")
        .args_json(serde_json::json!({
            "mandate": mandate,
            "signer_public_key": pk,
            "signature": reg_sig,
        }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert!(registered.is_success(), "s13 register: {:?}", registered.logs());
    assert_eq!(reason_of(&registered), "allowed", "s13 register reason");
    let after_reg = worker.view_account(&gate).await?.storage_usage;
    let register_bytes = after_reg - before_reg;

    async fn act(
        agent: &Account,
        gate: &AccountId,
        target: &AccountId,
        text: &str,
        amount: u128,
    ) -> Result<ExecutionFinalResult> {
        Ok(agent
            .call(gate, "authorize_and_pay_tiered")
            .args_json(serde_json::json!({
                "serial": 1u64,
                "action": "transfer",
                "target": target,
                "amount": amount.to_string(),
                "instruction": text,
                "source": "owner_chat",
                "judge_hint": null,
            }))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?)
    }

    let before_paid = worker.view_account(&gate).await?.storage_usage;
    let paid = act(&agent, &gate, payee.id(), text_a, NEAR / 10).await?;
    assert!(paid.is_success(), "s13 paid: {:?}", paid.logs());
    assert_eq!(reason_of(&paid), "allowed", "s13 paid reason");
    let paid_bytes = worker.view_account(&gate).await?.storage_usage - before_paid;

    let before_refused = worker.view_account(&gate).await?.storage_usage;
    let refused = act(&agent, &gate, attacker.id(), text_a, NEAR / 10).await?;
    assert!(refused.is_success(), "s13 refused: {:?}", refused.logs());
    assert_eq!(reason_of(&refused), "out_of_scope", "s13 refused reason");
    let refused_bytes = worker.view_account(&gate).await?.storage_usage - before_refused;

    let before_pending = worker.view_account(&gate).await?.storage_usage;
    let escalated = act(&agent, &gate, payee.id(), text_b, NEAR).await?;
    assert!(escalated.is_success(), "s13 pending: {:?}", escalated.logs());
    assert_eq!(reason_of(&escalated), "tier2_escalate", "s13 pending reason");
    let pending: Vec<PendingItem> = owner.view(&gate, "pending_items").await?.json()?;
    assert_eq!(pending.len(), 1, "s13 one pending item");
    let pending_bytes = worker.view_account(&gate).await?.storage_usage - before_pending;

    let fit = |bytes: u64| if bytes == 0 { "na".to_string() } else { (10_000u64 / bytes).to_string() };
    println!(
        "s13_gate_reserve_capacity reserve_yocto={} reserve_bytes=10000 register_bytes={register_bytes} paid_bytes={paid_bytes} refused_bytes={refused_bytes} pending_bytes={pending_bytes} register_fit={} paid_fit={} refused_fit={} pending_fit={} gate_storage_after={}",
        NEAR / 10,
        fit(register_bytes),
        fit(paid_bytes),
        fit(refused_bytes),
        fit(pending_bytes),
        worker.view_account(&gate).await?.storage_usage
    );
    Ok(())
}

/// `(attempt, event, gas_burnt)` for each `retry_refund` receipt (attempt >= 2).
fn retry_hop_rows(result: &ExecutionFinalResult) -> Vec<(u64, String, u64)> {
    let mut rows = Vec::new();
    for outcome in result.receipt_outcomes() {
        for line in &outcome.logs {
            let Some(rest) = line.strip_prefix("EVENT_JSON:") else {
                continue;
            };
            let Ok(v) = serde_json::from_str::<Value>(rest) else {
                continue;
            };
            let event = v.get("event").and_then(|s| s.as_str()).unwrap_or("");
            if event != "refund_retry" && event != "refund_sent" && event != "refund_stuck" {
                continue;
            }
            let attempt: u64 = v["data"][0]["attempt"]
                .as_str()
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            if attempt >= 2 {
                rows.push((attempt, event.to_string(), outcome.gas_burnt.as_gas()));
            }
        }
    }
    rows
}

fn event_attempts(result: &ExecutionFinalResult, event: &str) -> Vec<u64> {
    let mut attempts = Vec::new();
    let needle = format!("\"event\":\"{event}\"");
    for line in result.logs() {
        if !line.contains(&needle) {
            continue;
        }
        let Some(rest) = line.strip_prefix("EVENT_JSON:") else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(rest) else {
            continue;
        };
        if v.get("event").and_then(|s| s.as_str()) != Some(event) {
            continue;
        }
        if let Some(attempt) = v["data"][0]["attempt"].as_str().and_then(|s| s.parse().ok()) {
            attempts.push(attempt);
        }
    }
    attempts
}

/// First create with the test-only gate. `new` is `unreachable`, the batch
/// reverts, and the owner is refunded the full `required_deposit`.
#[tokio::test]
async fn s14_new_panics_inside_batch_full_refund() -> Result<()> {
    let wasm = read_wasm("out-test/chopgate_factory_test_double.wasm")?;
    let deploy = factory_wasm()?;
    let fixture = read_wasm("tests/fixtures/gate_new_unreachable.wasm")?;
    assert!(
        !deploy.windows(fixture.len()).any(|window| window == fixture.as_slice()),
        "s14 deploy wasm contains the test double"
    );
    let (worker, root) = sandbox().await?;
    let factory = deploy_factory(&root, &wasm, 30 * NEAR).await?;
    let owner = subaccount(&root, "owner-a", 30 * NEAR).await?;
    let pk = ed25519_pk();
    let required = view_u128(&factory, factory.id(), "required_deposit").await?;
    let hash: String = factory.view(factory.id(), "gate_code_hash").await?.json()?;
    let fixture_hash = bs58::encode(Sha256::digest(&fixture)).into_string();
    assert_eq!(hash, fixture_hash, "s14 factory must embed the test double");
    assert_ne!(hash, CODE_HASH, "s14 must not embed the real gate");
    let gate = view_gate_for(&factory, owner.id()).await?;
    assert!(worker.view_account(&gate).await.is_err(), "s14 gate must not exist yet");

    let owner_before = balance(&worker, owner.id()).await?;
    let factory_before = balance(&worker, factory.id()).await?;
    let result = create(&owner, factory.id(), &pk, required, min_gas()).await?;
    assert!(result.is_success(), "s14 outer call should succeed: {result:?}");
    let returned: bool = result.clone().json().context("s14 return")?;
    assert!(!returned, "s14 callback returns false");
    assert_pair_event(&result, "gate_create_failed", owner.id().as_str(), gate.as_str());
    assert!(!has_event(&result, "gate_created"), "s14 no gate_created");
    assert_eq!(event_count(&result, "refund_sent"), 1, "s14 one refund_sent: {:?}", result.logs());
    assert_eq!(event_count(&result, "refund_stuck"), 0, "s14 stuck: {:?}", result.logs());
    let trap = result
        .receipt_outcomes()
        .iter()
        .find(|outcome| !outcome.is_success())
        .map(|outcome| format!("{outcome:?}"))
        .unwrap_or_default();
    assert!(
        trap.contains("unreachable"),
        "s14 batch failure is not the test double's new trap: {trap}"
    );
    assert!(worker.view_account(&gate).await.is_err(), "s14 gate account must not exist");

    let factory_after = balance(&worker, factory.id()).await?;
    let factory_delta = factory_after as i128 - factory_before as i128;
    assert!(
        factory_delta.unsigned_abs() < LOSS_MAX,
        "s14 factory not back within 0.01 NEAR, delta={factory_delta}"
    );
    settle(&owner, factory.id()).await?;
    let owner_loss = loss_of(owner_before, balance(&worker, owner.id()).await?);
    assert!(owner_loss > 0, "s14 owner did not pay gas, loss={owner_loss}");
    assert!(
        owner_loss < REFUND_LOSS_MAX as i128,
        "s14 owner loss {owner_loss} is not gas-only (< 0.02 NEAR)"
    );
    let (protocol_idx, callback_idx, order) = refund_receipt_order(&result, factory.id());
    let measured = measure("s14_new_panics_inside_batch_full_refund", &result, Some(&gate));
    println!(
        "s14_new_panics_inside_batch_full_refund required_yocto={required} owner_loss_yocto={owner_loss} factory_delta_yocto={factory_delta} returned=false gate_exists=false attempt={} refund_sent_count=1 protocol_refund_idx={protocol_idx:?} callback_idx={callback_idx:?} total_gas={} batch_gas={} callback_gas={} deploy_wasm_sha256={} test_double_wasm_sha256={} fixture_sha256={} fixture_in_deploy=false order={order}",
        paid_attempt(&result),
        measured.total,
        measured.batch,
        measured.callback,
        sha256_hex(&deploy),
        sha256_hex(&wasm),
        sha256_hex(&fixture),
    );
    Ok(())
}

/// Same-owner second create on the `test-force-retry` wasm. Attempts 1..=K
/// report short, so `retry_refund` runs, and attempt K+1 pays.
#[tokio::test]
async fn s15_retry_hops_run_and_measured() -> Result<()> {
    let wasm = read_wasm("out-test/chopgate_factory_test_force_retry.wasm")?;
    let (worker, root) = sandbox().await?;
    let factory = deploy_factory(&root, &wasm, 30 * NEAR).await?;
    let owner = subaccount(&root, "owner-a", 30 * NEAR).await?;
    let pk = ed25519_pk();
    let required = view_u128(&factory, factory.id(), "required_deposit").await?;
    let hash: String = factory.view(factory.id(), "gate_code_hash").await?.json()?;
    assert_eq!(hash, CODE_HASH, "s15 keeps the real gate wasm");
    let gate = view_gate_for(&factory, owner.id()).await?;

    let first = create(&owner, factory.id(), &pk, required, min_gas()).await?;
    assert!(first.is_success(), "s15 setup create: {}", failure_text(&first));
    assert!(first.json::<bool>()?, "s15 setup callback was false");
    assert!(worker.view_account(&gate).await.is_ok(), "s15 gate exists");
    settle(&owner, factory.id()).await?;

    let owner_before = balance(&worker, owner.id()).await?;
    let factory_before = balance(&worker, factory.id()).await?;
    let second = create(&owner, factory.id(), &pk, required, min_gas()).await?;
    assert!(second.is_success(), "s15 outer call should succeed: {second:?}");
    let returned: bool = second.clone().json().context("s15 return")?;
    assert!(!returned, "s15 callback returns false");
    assert_pair_event(&second, "gate_create_failed", owner.id().as_str(), gate.as_str());
    assert_eq!(event_count(&second, "refund_sent"), 1, "s15 one refund_sent: {:?}", second.logs());
    assert_eq!(event_count(&second, "refund_stuck"), 0, "s15 stuck: {:?}", second.logs());

    let k = u64::from(TEST_FORCE_SHORT_K);
    let retries = event_attempts(&second, "refund_retry");
    for attempt in 1..=k {
        assert!(
            retries.contains(&attempt),
            "s15 missing refund_retry attempt {attempt}: {retries:?}"
        );
    }
    let hops = retry_hop_rows(&second);
    for attempt in 2..=k + 1 {
        assert!(
            hops.iter().any(|(got, _, _)| *got == attempt),
            "s15 retry receipt attempt {attempt} did not run: {hops:?}"
        );
    }
    assert_eq!(paid_attempt(&second), (k + 1).to_string(), "s15 paid on attempt {}", k + 1);
    let hop_text = hops
        .iter()
        .map(|(attempt, event, gas)| format!("{attempt}:{event}:{gas}"))
        .collect::<Vec<_>>()
        .join(",");
    for (attempt, event, gas) in &hops {
        println!("s15_hop attempt={attempt} event={event} gas_burnt={gas}");
    }
    let max_hop = hops.iter().map(|(_, _, gas)| *gas).max().expect("s15 hops");
    let floor = min_retry_hop_tgas(max_hop);
    assert!(
        RETRY_HOP_TGAS >= floor,
        "RETRY_HOP_TGAS {RETRY_HOP_TGAS} < ceil(2x measured {max_hop} gas) = {floor}"
    );

    let factory_delta = balance(&worker, factory.id()).await? as i128 - factory_before as i128;
    assert!(
        factory_delta.unsigned_abs() < LOSS_MAX,
        "s15 factory not back within 0.01 NEAR, delta={factory_delta}"
    );
    settle(&owner, factory.id()).await?;
    let owner_loss = loss_of(owner_before, balance(&worker, owner.id()).await?);
    assert!(owner_loss > 0, "s15 owner did not pay gas, loss={owner_loss}");
    assert!(
        owner_loss < REFUND_LOSS_MAX as i128,
        "s15 owner loss {owner_loss} >= 0.02 NEAR"
    );
    let (protocol_idx, callback_idx, order) = refund_receipt_order(&second, factory.id());
    let measured = measure("s15_retry_hops_run_and_measured", &second, Some(&gate));
    println!(
        "s15_retry_hops_run_and_measured required_yocto={required} owner_loss_yocto={owner_loss} factory_delta_yocto={factory_delta} returned=false refund_sent_count=1 attempt={} k={TEST_FORCE_SHORT_K} retry_attempts=2..={} hop_gas={hop_text} max_hop_gas={max_hop} hop_floor_tgas={floor} retry_hop_tgas={RETRY_HOP_TGAS} rule=RETRY_HOP_TGAS>=ceil(2*max_hop_gas/1e12) protocol_refund_idx={protocol_idx:?} callback_idx={callback_idx:?} total_gas={} batch_gas={} callback_gas={} test_force_retry_wasm_sha256={} order={order}",
        paid_attempt(&second),
        k + 1,
        measured.total,
        measured.batch,
        measured.callback,
        sha256_hex(&wasm),
    );
    Ok(())
}
