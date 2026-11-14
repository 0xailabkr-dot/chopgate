use anyhow::Result;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::json_types::U128;
use near_workspaces::{Account, Contract};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use chopgate::{rule_approval_bytes, signing_bytes, Permission, Mandate};

const INSTRUCTION: &str = "Transfer under the signed entries";
fn instruction_hash(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

static WASM: tokio::sync::OnceCell<Vec<u8>> = tokio::sync::OnceCell::const_new();
struct Fixture {
    worker: near_workspaces::Worker<near_workspaces::network::Sandbox>,
    contract: Contract,
    agent: Account,
    attacker: Account,
    key: SigningKey,
    deployment_id: String,
}
impl Fixture {
    async fn new() -> Result<Self> {
        let wasm = WASM
            .get_or_try_init(|| async { near_workspaces::compile_project("./").await })
            .await?;
        let worker = near_workspaces::sandbox().await?;
        let contract = worker.dev_deploy(wasm).await?;
        let agent = worker.dev_create_account().await?;
        let attacker = worker.dev_create_account().await?;
        let key = SigningKey::generate(&mut rand::rngs::OsRng);
        contract
            .call("new")
            .args_json(json!({"owner_public_key":pk(&key),"chain_id":"local-test","deployment_id":"deployment-1"}))
            .transact()
            .await?
            .into_result()?;
        let (_,deployment_id,_):(String,String,near_sdk::PublicKey)=contract.view("signature_domain").await?.json()?;
        Ok(Self {
            worker,
            contract,
            agent,
            attacker,
            key, deployment_id,
        })
    }
    fn mandate(&self, serial: u64) -> Mandate {
        Mandate {
            serial,
            agent: self.agent.id().as_str().parse().unwrap(),
            entries: vec![Permission {
                action: "transfer".into(),
                target: "vault.test".into(),
                max_amount: U128(200),
                instruction_hash: instruction_hash(INSTRUCTION),
            }],
            budget: U128(100),
            expires_at: 4_000_000_000_000_000_000,
            parent_serial: None,
        }
    }
    async fn register(
        &self,
        w: &Mandate,
        key: &SigningKey,
        missing: bool,
        code: &str,
    ) -> Result<Value> {
        let bytes = signing_bytes(&self.contract.id().as_str().parse().unwrap(), w);
        let signature = if missing {
            None
        } else {
            Some(hex::encode(fixture_sign(&key, &bytes, &self.deployment_id).to_bytes()))
        };
        let result = self
            .agent
            .call(self.contract.id(), "register")
            .args_json(json!({"mandate":w,"signer_public_key":pk(key),"signature":signature}))
            .transact()
            .await?;
        check(result, code)
    }
    async fn auth(
        &self,
        caller: &Account,
        action: &str,
        target: &str,
        amount: u128,
        instruction: &str,
        code: &str,
    ) -> Result<Value> {
        let result = caller
            .call(self.contract.id(), "authorize")
            .args_json(json!({
                "serial": 1,
                "action": action,
                "target": target,
                "amount": amount.to_string(),
                "instruction": instruction
            }))
            .transact()
            .await?;
        let d = check(result, code)?;
        assert_eq!(d["instruction_hash"], instruction_hash(instruction));
        Ok(d)
    }
    async fn ready() -> Result<Self> {
        let f = Self::new().await?;
        f.register(&f.mandate(1), &f.key, false, "allowed").await?;
        Ok(f)
    }
}
fn pk(k: &SigningKey) -> String {
    format!(
        "ed25519:{}",
        bs58::encode(k.verifying_key().to_bytes()).into_string()
    )
}
fn check(result: near_workspaces::result::ExecutionFinalResult, code: &str) -> Result<Value> {
    assert!(result.is_success(), "{result:?}");
    let receipt: Value = result
        .logs()
        .iter()
        .find_map(|s| {
            s.strip_prefix("EVENT_JSON:").and_then(|j| {
                let v: Value = serde_json::from_str(j).unwrap();
                (v["event"] == "decision").then_some(v)
            })
        })
        .expect("decision event");
    assert_eq!(receipt["standard"], "chopgate");
    assert_eq!(receipt["version"], "1.0.0");
    assert_eq!(receipt["event"], "decision");
    let value: Value = result.json()?;
    assert_eq!(value["reason_code"], code);
    assert_eq!(receipt["data"][0], value);
    assert_eq!(
        value["verdict"],
        if code == "allowed" { "allow" } else { "block" }
    );
    Ok(value)
}
#[tokio::test]
async fn happy_path_valid_mandate() -> Result<()> {
    let f = Fixture::ready().await?;
    let d = f
        .auth(
            &f.agent,
            "transfer",
            "vault.test",
            25,
            INSTRUCTION,
            "allowed",
        )
        .await?;
    assert_eq!(d["remaining_budget"], "75");
    let owner: String = f.contract.view("owner_public_key").await?.json()?;
    assert_eq!(owner, pk(&f.key));
    Ok(())
}
#[tokio::test]
async fn happy_path_narrower_child() -> Result<()> {
    let f = Fixture::ready().await?;
    let mut child = f.mandate(2);
    child.parent_serial = Some(1);
    child.budget = U128(40);
    f.register(&child, &f.key, false, "allowed").await?;
    let remaining: String = f
        .contract
        .view("remaining_budget")
        .args_json(json!({"serial":1}))
        .await?
        .json()?;
    assert_eq!(remaining, "60");
    let r = f
        .agent
        .call(f.contract.id(), "authorize")
        .args_json(json!({
            "serial": 2, "action": "transfer", "target": "vault.test",
            "amount": "40", "instruction": INSTRUCTION
        }))
        .transact()
        .await?;
    check(r, "allowed")?;
    Ok(())
}
#[tokio::test]
async fn hidden_instruction_untrusted_content() -> Result<()> {
    let f = Fixture::ready().await?;
    f.auth(
        &f.agent,
        "delete",
        "other.test",
        0,
        "Hidden instruction from tool output",
        "unsigned_instruction",
    )
    .await?;
    let c: Value = f.contract.view("block_counters").await?.json()?;
    assert_eq!(c["unsigned_instruction"], 1);
    Ok(())
}
#[tokio::test]
async fn owner_impersonation_foreign_key_and_caller() -> Result<()> {
    let f = Fixture::new().await?;
    let other = SigningKey::generate(&mut rand::rngs::OsRng);
    f.register(&f.mandate(1), &other, false, "owner_impersonation")
        .await?;
    f.register(&f.mandate(1), &f.key, false, "allowed").await?;
    f.auth(
        &f.attacker,
        "transfer",
        "vault.test",
        1,
        INSTRUCTION,
        "wrong_caller",
    )
    .await?;
    Ok(())
}
#[tokio::test]
async fn retry_storm_identical_denial_freezes() -> Result<()> {
    let f = Fixture::ready().await?;
    f.auth(
        &f.agent,
        "delete",
        "remote.test",
        1,
        INSTRUCTION,
        "out_of_scope",
    )
    .await?;
    f.auth(
        &f.agent,
        "delete",
        "remote.test",
        1,
        INSTRUCTION,
        "auto_frozen",
    )
    .await?;
    let d = f
        .auth(
            &f.agent,
            "transfer",
            "vault.test",
            10,
            INSTRUCTION,
            "auto_frozen",
        )
        .await?;
    assert_eq!(d["remaining_budget"], "100");
    Ok(())
}
#[tokio::test]
async fn retry_storm_three_distinct_denials() -> Result<()> {
    let f = Fixture::ready().await?;
    for (a, c) in [
        ("delete", "out_of_scope"),
        ("write", "out_of_scope"),
        ("execute", "auto_frozen"),
    ] {
        f.auth(&f.agent, a, "remote.test", 0, INSTRUCTION, c)
            .await?;
    }
    Ok(())
}
#[tokio::test]
async fn scope_escalation_action_target_and_child() -> Result<()> {
    let f = Fixture::ready().await?;
    f.auth(
        &f.agent,
        "delete",
        "vault.test",
        0,
        INSTRUCTION,
        "out_of_scope",
    )
    .await?;
    f.auth(
        &f.agent,
        "transfer",
        "remote.test",
        0,
        INSTRUCTION,
        "out_of_scope",
    )
    .await?;
    let mut c = f.mandate(2);
    c.parent_serial = Some(1);
    c.entries[0].target = "remote.test".into();
    f.register(&c, &f.key, false, "child_wider").await?;
    c.entries = f.mandate(1).entries;
    c.budget = U128(101);
    f.register(&c, &f.key, false, "child_wider").await?;
    c.budget = U128(40);
    c.entries[0].instruction_hash = instruction_hash("extra unsigned instruction");
    f.register(&c, &f.key, false, "child_wider").await?;
    Ok(())
}
#[tokio::test]
async fn lookalike_account_confusable_targets() -> Result<()> {
    for target in [
        "vau1t.test",
        "vault-test",
        "prefix.vault.test",
        "vault.test.suffix",
    ] {
        let f = Fixture::ready().await?;
        f.auth(
            &f.agent,
            "transfer",
            target,
            1,
            INSTRUCTION,
            "lookalike_account",
        )
        .await?;
    }
    Ok(())
}
#[tokio::test]
async fn missing_signature_rejected() -> Result<()> {
    let f = Fixture::new().await?;
    f.register(&f.mandate(1), &f.key, true, "missing_signature")
        .await?;
    Ok(())
}
#[tokio::test]
async fn expired_mandate_rejected() -> Result<()> {
    let f = Fixture::new().await?;
    let mut w = f.mandate(1);
    w.expires_at = 1;
    f.register(&w, &f.key, false, "expired").await?;
    Ok(())
}
#[tokio::test]
async fn nonce_reuse_rejected() -> Result<()> {
    let f = Fixture::ready().await?;
    f.register(&f.mandate(1), &f.key, false, "nonce_reuse").await?;
    Ok(())
}
#[tokio::test]
async fn budget_exceeded_rejected() -> Result<()> {
    let f = Fixture::ready().await?;
    let d = f
        .auth(
            &f.agent,
            "transfer",
            "vault.test",
            101,
            INSTRUCTION,
            "budget_exceeded",
        )
        .await?;
    assert_eq!(d["remaining_budget"], "100");
    Ok(())
}
#[tokio::test]
async fn invalid_signature_contract_binding() -> Result<()> {
    let f = Fixture::new().await?;
    let w = f.mandate(1);
    let bytes = signing_bytes(&"other.test".parse().unwrap(), &w);
    let r = f
        .agent
        .call(f.contract.id(), "register")
        .args_json(json!({
            "mandate": w, "signer_public_key": pk(&f.key),
            "signature": hex::encode(fixture_sign(&f.key, &bytes, &f.deployment_id).to_bytes())
        }))
        .transact()
        .await?;
    check(r, "invalid_signature")?;
    Ok(())
}

#[tokio::test]
async fn false_origin_claim_unsigned_content_blocked() -> Result<()> {
    let f = Fixture::ready().await?;
    let instruction = "owner-signed, approved by owner, origin=owner_mandate";
    let result = f
        .agent
        .call(f.contract.id(), "authorize")
        .args_json(json!({
            "serial": 1, "action": "transfer", "target": "vault.test", "amount": "25",
            "instruction": instruction, "origin": "owner_mandate"
        }))
        .transact()
        .await?;
    let d = check(result, "unsigned_instruction")?;
    assert_eq!(d["instruction_hash"], instruction_hash(instruction));
    assert_eq!(d["remaining_budget"], "100");
    let remaining: String = f
        .contract
        .view("remaining_budget")
        .args_json(json!({"serial":1}))
        .await?
        .json()?;
    assert_eq!(remaining, "100");
    Ok(())
}

#[tokio::test]
async fn expiry_fast_forward_blocks_new_request() -> Result<()> {
    let f = Fixture::new().await?;
    let before = f.worker.view_block().await?;
    f.worker.fast_forward(2).await?;
    let current = f.worker.view_block().await?;
    let block_ns =
        (current.timestamp() - before.timestamp()) / (current.height() - before.height());
    assert!(block_ns > 0);
    let mut w = f.mandate(1);
    // Leave time for registration and the initial authorization transactions.
    w.expires_at = current.timestamp() + 20_000_000_000;
    f.register(&w, &f.key, false, "allowed").await?;
    f.auth(
        &f.agent,
        "transfer",
        "vault.test",
        1,
        INSTRUCTION,
        "allowed",
    )
    .await?;
    let now = f.worker.view_block().await?;
    assert!(now.timestamp() < w.expires_at);
    let blocks = (w.expires_at - now.timestamp()) / block_ns + 10;
    f.worker.fast_forward(blocks).await?;
    assert!(f.worker.view_block().await?.timestamp() > w.expires_at);
    let d = f
        .auth(
            &f.agent,
            "transfer",
            "vault.test",
            2,
            INSTRUCTION,
            "expired",
        )
        .await?;
    assert_eq!(d["remaining_budget"], "99");
    Ok(())
}

#[tokio::test]
async fn lookalike_account_listed_similar_accounts_allowed() -> Result<()> {
    let f = Fixture::new().await?;
    let mut w = f.mandate(1);
    w.entries.push(Permission {
        action: "transfer".into(),
        target: "vau1t.test".into(),
        max_amount: U128(100),
        instruction_hash: instruction_hash(INSTRUCTION),
    });
    f.register(&w, &f.key, false, "allowed").await?;
    for target in ["vault.test", "vau1t.test"] {
        f.auth(&f.agent, "transfer", target, 1, INSTRUCTION, "allowed")
            .await?;
    }
    f.auth(
        &f.agent,
        "transfer",
        "vault.test.suffix",
        1,
        INSTRUCTION,
        "lookalike_account",
    )
    .await?;
    Ok(())
}

#[tokio::test]
async fn entry_second_execution_blocked() -> Result<()> {
    let f = Fixture::ready().await?;
    f.auth(
        &f.agent,
        "transfer",
        "vault.test",
        10,
        INSTRUCTION,
        "allowed",
    )
    .await?;
    let d = f
        .auth(
            &f.agent,
            "transfer",
            "vault.test",
            10,
            INSTRUCTION,
            "instruction_reused",
        )
        .await?;
    assert_eq!(d["remaining_budget"], "90");
    Ok(())
}
#[tokio::test]
async fn entry_hash_other_action_or_target_blocked() -> Result<()> {
    let f = Fixture::new().await?;
    let mut w = f.mandate(1);
    let mut e = w.entries[0].clone();
    e.action = "write".into();
    e.instruction_hash = instruction_hash("write only");
    w.entries.push(e.clone());
    e.action = "transfer".into();
    e.target = "remote.test".into();
    w.entries.push(e);
    f.register(&w, &f.key, false, "allowed").await?;
    f.auth(
        &f.agent,
        "write",
        "vault.test",
        1,
        INSTRUCTION,
        "instruction_binding_mismatch",
    )
    .await?;
    f.auth(
        &f.agent,
        "transfer",
        "remote.test",
        1,
        INSTRUCTION,
        "instruction_binding_mismatch",
    )
    .await?;
    Ok(())
}
#[tokio::test]
async fn entry_amount_over_limit_blocked() -> Result<()> {
    let f = Fixture::new().await?;
    let mut w = f.mandate(1);
    w.entries[0].max_amount = U128(20);
    f.register(&w, &f.key, false, "allowed").await?;
    f.auth(
        &f.agent,
        "transfer",
        "vault.test",
        21,
        INSTRUCTION,
        "entry_limit_exceeded",
    )
    .await?;
    f.auth(
        &f.agent,
        "transfer",
        "vault.test",
        20,
        INSTRUCTION,
        "allowed",
    )
    .await?;
    Ok(())
}
#[tokio::test]
async fn delegated_entry_cannot_run_in_parent() -> Result<()> {
    let f = Fixture::ready().await?;
    let mut w = f.mandate(2);
    w.parent_serial = Some(1);
    w.budget = U128(40);
    f.register(&w, &f.key, false, "allowed").await?;
    let d = f
        .auth(
            &f.agent,
            "transfer",
            "vault.test",
            1,
            INSTRUCTION,
            "instruction_reused",
        )
        .await?;
    assert_eq!(d["remaining_budget"], "60");
    Ok(())
}
async fn proposal_fixture() -> Result<Fixture> {
    let f = Fixture::ready().await?;
    for (amount, code) in [(1, "out_of_scope"), (2, "out_of_scope"), (3, "auto_frozen")] {
        f.auth(&f.agent, "delete", "remote.test", amount, INSTRUCTION, code)
            .await?;
    }
    Ok(f)
}
async fn approve(
    f: &Fixture,
    key: &SigningKey,
    signature: Option<String>,
    code: &str,
) -> Result<Value> {
    let r = f
        .agent
        .call(f.contract.id(), "approve_rule")
        .args_json(json!({"proposal_id":1,"signer_public_key":pk(key),"signature":signature}))
        .transact()
        .await?;
    let logs: Vec<Value> = r
        .logs()
        .iter()
        .filter_map(|s| s.strip_prefix("EVENT_JSON:"))
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    assert!(logs.iter().any(|v| v["event"]
        == if code == "allowed" {
            "policy_update"
        } else {
            "policy_update_rejected"
        }));
    check(r, code)
}
fn approval_signature(f: &Fixture, key: &SigningKey) -> String {
    hex::encode(
        fixture_sign(&key, &rule_approval_bytes(
            &f.contract.id().as_str().parse().unwrap(),
            1,
            1,
            "delete",
            "remote.test",
        ), &f.deployment_id)
        .to_bytes(),
    )
}
#[tokio::test]
async fn learning_three_same_blocks_emit_rule_proposal() -> Result<()> {
    let f = Fixture::ready().await?;
    let mut proposals = Vec::new();
    for amount in 1..=4 {
        let r = f.agent.call(f.contract.id(),"authorize").args_json(json!({"serial":1,"action":"delete","target":"remote.test","amount":amount.to_string(),"instruction":INSTRUCTION})).transact().await?;
        for log in r.logs() {
            if let Some(j) = log.strip_prefix("EVENT_JSON:") {
                let v: Value = serde_json::from_str(j)?;
                if v["event"] == "rule_proposal" {
                    proposals.push(v);
                }
            }
        }
    }
    assert_eq!(proposals.len(), 1);
    assert_eq!(proposals[0]["data"][0]["count"], 3);
    assert_eq!(proposals[0]["data"][0]["reason_code"], "out_of_scope");
    assert_eq!(f.contract.view("policy_version").await?.json::<u64>()?, 1);
    let rules: Value = f.contract.view("rules").await?.json()?;
    assert_eq!(rules[0]["approved"], false);
    Ok(())
}
#[tokio::test]
async fn learning_unsigned_or_forged_approval_keeps_version() -> Result<()> {
    let f = proposal_fixture().await?;
    let foreign = SigningKey::generate(&mut rand::rngs::OsRng);
    approve(&f, &f.key, None, "missing_signature").await?;
    approve(
        &f,
        &foreign,
        Some(approval_signature(&f, &foreign)),
        "owner_impersonation",
    )
    .await?;
    let mut sig = approval_signature(&f, &f.key);
    sig.replace_range(0..2, if &sig[0..2] == "00" { "01" } else { "00" });
    approve(&f, &f.key, Some(sig), "invalid_signature").await?;
    assert_eq!(f.contract.view("policy_version").await?.json::<u64>()?, 1);
    let rules: Value = f.contract.view("rules").await?.json()?;
    assert_eq!(rules[0]["approved"], false);
    Ok(())
}
#[tokio::test]
async fn learning_owner_signed_approval_bumps_version_and_applies_rule() -> Result<()> {
    let f = proposal_fixture().await?;
    let sig = approval_signature(&f, &f.key);
    approve(&f, &f.key, Some(sig.clone()), "allowed").await?;
    assert_eq!(f.contract.view("policy_version").await?.json::<u64>()?, 2);
    approve(&f, &f.key, Some(sig), "already_approved").await?;
    let mut w = f.mandate(2);
    w.entries[0].action = "delete".into();
    w.entries[0].target = "remote.test".into();
    f.register(&w, &f.key, false, "allowed").await?;
    let r = f.agent.call(f.contract.id(),"authorize").args_json(json!({"serial":2,"action":"delete","target":"remote.test","amount":"1","instruction":INSTRUCTION})).transact().await?;
    check(r, "policy_rule_denied")?;
    Ok(())
}

async fn active_fixture() -> Result<Fixture> {
    let f = proposal_fixture().await?;
    approve(&f, &f.key, Some(approval_signature(&f, &f.key)), "allowed").await?;
    Ok(f)
}
fn revocation_signature(f: &Fixture, key: &SigningKey, version: u64) -> String {
    hex::encode(
        fixture_sign(&key, &chopgate::rule_revocation_bytes(
            &f.contract.id().as_str().parse().unwrap(),
            1,
            version,
            "delete",
            "remote.test",
        ), &f.deployment_id)
        .to_bytes(),
    )
}
async fn revoke(
    f: &Fixture,
    key: &SigningKey,
    signature: Option<String>,
    code: &str,
) -> Result<()> {
    let r = f
        .agent
        .call(f.contract.id(), "revoke_rule")
        .args_json(json!({"proposal_id":1,"signer_public_key":pk(key),"signature":signature}))
        .transact()
        .await?;
    let events: Vec<Value> = r
        .logs()
        .iter()
        .filter_map(|s| s.strip_prefix("EVENT_JSON:"))
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    if code == "allowed" {
        assert!(events.iter().any(|e| e["event"] == "policy_update" && e["data"][0] == json!({"proposal_id":1,"old_version":2,"new_version":3,"rule":{"action":"delete","target":"remote.test","effect":"deny"},"change":"revoked"})));
    } else {
        assert!(
            events
                .iter()
                .any(|e| e["event"] == "policy_update_rejected"
                    && e["data"][0]["reason_code"] == code)
        );
    }
    check(r, code)?;
    Ok(())
}
async fn rule_request(f: &Fixture, serial: u64, code: &str) -> Result<()> {
    let mut w = f.mandate(serial);
    w.entries[0].action = "delete".into();
    w.entries[0].target = "remote.test".into();
    f.register(&w, &f.key, false, "allowed").await?;
    let r = f.agent.call(f.contract.id(), "authorize")
        .args_json(json!({"serial":serial,"action":"delete","target":"remote.test","amount":"1","instruction":INSTRUCTION}))
        .transact().await?;
    check(r, code)?;
    Ok(())
}
#[tokio::test]
async fn revoke_owner_signed_succeeds_and_unblocks() -> Result<()> {
    let f = active_fixture().await?;
    rule_request(&f, 2, "policy_rule_denied").await?;
    revoke(
        &f,
        &f.key,
        Some(revocation_signature(&f, &f.key, 2)),
        "allowed",
    )
    .await?;
    assert_eq!(f.contract.view("policy_version").await?.json::<u64>()?, 3);
    rule_request(&f, 3, "allowed").await?;
    // Same cause has already emitted its sole proposal, even after revocation.
    for serial in 4..=6 {
        f.register(&f.mandate(serial), &f.key, false, "allowed")
            .await?;
        let r = f.agent.call(f.contract.id(), "authorize").args_json(json!({"serial":serial,"action":"delete","target":"remote.test","amount":"1","instruction":INSTRUCTION})).transact().await?;
        check(r, "out_of_scope")?;
    }
    assert_eq!(
        f.contract.view("rules").await?.json::<Vec<Value>>()?.len(),
        1
    );
    // A current signature for an inactive rule receives the activity reason.
    revoke(
        &f,
        &f.key,
        Some(revocation_signature(&f, &f.key, 3)),
        "rule_not_active",
    )
    .await?;
    Ok(())
}
#[tokio::test]
async fn revoke_unsigned_or_forged_keeps_rule_and_version() -> Result<()> {
    let f = active_fixture().await?;
    let foreign = SigningKey::generate(&mut rand::rngs::OsRng);
    let mut corrupted = revocation_signature(&f, &f.key, 2);
    corrupted.replace_range(0..2, if &corrupted[0..2] == "00" { "01" } else { "00" });
    for (i, (key, sig, code)) in [
        (&f.key, None, "missing_signature"),
        (
            &foreign,
            Some(revocation_signature(&f, &foreign, 2)),
            "owner_impersonation",
        ),
        (&f.key, Some(corrupted), "invalid_signature"),
    ]
    .into_iter()
    .enumerate()
    {
        revoke(&f, key, sig, code).await?;
        assert_eq!(f.contract.view("policy_version").await?.json::<u64>()?, 2);
        assert_eq!(
            f.contract.view("rules").await?.json::<Value>()?[0]["approved"],
            true
        );
        rule_request(&f, i as u64 + 2, "policy_rule_denied").await?;
    }
    Ok(())
}
#[tokio::test]
async fn revoke_reused_signature_rejected() -> Result<()> {
    let f = active_fixture().await?;
    revoke(
        &f,
        &f.key,
        Some(approval_signature(&f, &f.key)),
        "invalid_signature",
    )
    .await?;
    let sig = revocation_signature(&f, &f.key, 2);
    revoke(&f, &f.key, Some(sig.clone()), "allowed").await?;
    revoke(&f, &f.key, Some(sig), "invalid_signature").await?;
    assert_eq!(f.contract.view("policy_version").await?.json::<u64>()?, 3);
    Ok(())
}

#[tokio::test]
async fn learning_proposal_emitted_only_on_third_block() -> Result<()> {
    let f = Fixture::ready().await?;
    for amount in 1..=4 {
        let r = f.agent.call(f.contract.id(), "authorize")
            .args_json(json!({"serial":1,"action":"delete","target":"remote.test","amount":amount.to_string(),"instruction":INSTRUCTION}))
            .transact().await?;
        let events: Vec<Value> = r
            .logs()
            .iter()
            .filter_map(|line| line.strip_prefix("EVENT_JSON:"))
            .map(serde_json::from_str)
            .collect::<std::result::Result<_, _>>()?;
        let proposals: Vec<_> = events
            .iter()
            .filter(|e| e["event"] == "rule_proposal")
            .collect();
        assert_eq!(proposals.len(), usize::from(amount == 3));
        if amount == 3 {
            assert_eq!(proposals[0]["data"][0]["count"], 3);
        }
    }
    Ok(())
}

// Offline fixture domain; production signers must query signature_domain.
fn fixture_sign(key: &ed25519_dalek::SigningKey, payload: &[u8], deployment_id: &str) -> ed25519_dalek::Signature {
    use ed25519_dalek::Signer;
    let owner: near_sdk::PublicKey = format!("ed25519:{}", bs58::encode(key.verifying_key().to_bytes()).into_string()).parse().unwrap();
    key.sign(&chopgate::authorization_bytes("local-test", deployment_id, &owner, payload))
}
