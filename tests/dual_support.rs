#![allow(dead_code)]
#[path="tier_support.rs"]
pub mod tier_support;
pub use tier_support::*;
use anyhow::Result;
use chopgate::{SpendRules, Payee, JudgeReport, spend_rules_bytes};
use chopgate::jev::{MockJev,build_report};
use near_sdk::json_types::U128;
use ed25519_dalek::Signer;
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
pub fn rules(f:&Fixture,nonce:u64,limit:u128)->SpendRules {
    SpendRules { rules_nonce:nonce, enabled:true, per_tx_limit:U128(limit), per_day_limit:U128(10*NEAR),
        payees:vec![Payee { alias:"구독".into(),account:f.recipient.id().to_string() }],
        allowed_categories:vec!["subscription".into(),"transfer".into()], jev_required:true, ..SpendRules::default() }
}
pub async fn set_rules(f:&Fixture,rules:SpendRules)->Result<()> {
    if rules.rules_nonce == 1 {
        let policy=chopgate::JudgePolicy { nonce:1, keys:vec![tier_support::escrow_support::pk(&f.key).parse()?] };
        let signature=hex::encode(fixture_sign(&f.key, &chopgate::judge_policy_bytes(&f.contract.id().as_str().parse()?, &policy), &f.deployment_id).to_bytes());
        f.owner.call(f.contract.id(),"set_judge_policy").args_json(json!({"policy":policy,"signature":signature})).transact().await?.into_result()?;
    }
    let signature=hex::encode(fixture_sign(&f.key, &spend_rules_bytes(&f.contract.id().as_str().parse()?,&rules), &f.deployment_id).to_bytes());
    f.owner.call(f.contract.id(),"set_spend_rules").args_json(json!({"rules":rules,"signature":signature})).transact().await?.into_result()?; Ok(())
}
pub fn report(f:&Fixture,name:&str)->Result<JudgeReport> {
    let mock=MockJev::from_file(format!("fixtures/jev/{name}.json")).map_err(anyhow::Error::msg)?;
    build_report(&mock,&f.instruction,"page read by agent",&hex::encode(Sha256::digest(f.instruction.as_bytes())),"mock").map_err(anyhow::Error::msg)
}
pub async fn dual(f:&Fixture,serial:u64,name:&str)->Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(f.agent.call(f.contract.id(),"authorize_and_pay_dual").args_json(json!({"serial":serial,"action":"transfer",
        "target":f.recipient.id(),"amount":NEAR.to_string(),"instruction":f.instruction,"source":"owner_chat",
        "judge_report":attest(f,serial,&f.instruction,NEAR,report(f,name)?)?,"judge_hint":null})).transact().await?)
}
pub fn decision(r:&near_workspaces::result::ExecutionFinalResult,expected:&str)->Result<()> {
    assert!(r.is_success(),"{r:?}"); let d:Value=r.clone().json()?; assert_eq!(d["reason_code"],expected); Ok(())
}
pub async fn no_payout(f:&Fixture,name:&str)->Result<()> {
    let before=f.balances().await?; let r=dual(f,1,name).await?; decision(&r,"tier2_deny")?;
    assert!(!r.logs().iter().any(|l|l.contains("\"event\":\"payout\"")));
    let after=f.balances().await?; assert_eq!(after.0,before.0);assert_eq!(after.2,before.2);Ok(())
}

// Offline fixture domain; production signers must query signature_domain.
fn fixture_sign(key: &ed25519_dalek::SigningKey, payload: &[u8], deployment_id: &str) -> ed25519_dalek::Signature {
    use ed25519_dalek::Signer;
    let owner: near_sdk::PublicKey = format!("ed25519:{}", bs58::encode(key.verifying_key().to_bytes()).into_string()).parse().unwrap();
    key.sign(&chopgate::authorization_bytes("local-test", deployment_id, &owner, payload))
}

// Mock signer is fixture-only. Model output never contains a production private key.
pub fn attest(f:&Fixture, serial:u64, text:&str, amount:u128, mut r:JudgeReport)->Result<JudgeReport> {
    let hash=hex::encode(Sha256::digest(text.as_bytes()));
    let caller:near_sdk::AccountId=f.agent.id().as_str().parse()?;
    let fields=near_sdk::borsh::to_vec(&(serial,"transfer",f.recipient.id().as_str(),U128(amount),&hash,"owner_chat",&caller))?;
    r.expires_at=u64::MAX; r.nonce=serial; r.key_generation=1;
    r.request_hash=hex::encode(Sha256::digest(fields));
    r.signer_public_key=Some(tier_support::escrow_support::pk(&f.key));
    r.signature=Some(hex::encode(fixture_sign(&f.key,&chopgate::judge_report_bytes(&f.contract.id().as_str().parse()?,&r), &f.deployment_id).to_bytes()));
    Ok(r)
}
