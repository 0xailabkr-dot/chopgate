#![allow(dead_code)]
#[path = "escrow_support.rs"]
pub mod escrow_support;
pub use self::escrow_support::{Fixture, NEAR};
use anyhow::Result;
use ed25519_dalek::Signer;
use near_sdk::json_types::U128;
use serde_json::{json, Value};
use chopgate::{Tier2Config, tier2_config_bytes, pending_decision_v2_bytes, pending_request_hash, PendingItem, Mandate, Permission, signing_bytes};
use sha2::{Digest, Sha256};
pub async fn config(f: &Fixture, nonce: u64, threshold: u128, ttl: u64) -> Result<()> {
    let config=Tier2Config { config_nonce:nonce, amount_threshold:U128(threshold), pending_ttl_ns:ttl,
        new_payee_check:false, trusted_sources:vec![], known_payees:vec![], denied_targets:vec![] };
    let signature=hex::encode(fixture_sign(&f.key, &tier2_config_bytes(&f.contract.id().as_str().parse()?, &config), &f.deployment_id).to_bytes());
    f.owner.call(f.contract.id(),"set_tier2_config").args_json(json!({"config":config,"signature":signature})).transact().await?.into_result()?;
    Ok(())
}
pub async fn register(f: &Fixture, serial: u64) -> Result<()> {
    let mandate=Mandate { serial, agent:f.agent.id().as_str().parse()?, entries:vec![Permission {
        action:"transfer".into(), target:f.recipient.id().to_string(), max_amount:U128(NEAR),
        instruction_hash:hex::encode(Sha256::digest(f.instruction.as_bytes())) }], budget:U128(5*NEAR),
        expires_at:4_000_000_000_000_000_000, parent_serial:None };
    let signature=hex::encode(fixture_sign(&f.key, &signing_bytes(&f.contract.id().as_str().parse()?, &mandate), &f.deployment_id).to_bytes());
    let d:Value=f.agent.call(f.contract.id(),"register").args_json(json!({"mandate":mandate,
        "signer_public_key":escrow_support::pk(&f.key),"signature":signature})).transact().await?.json()?;
    assert_eq!(d["reason_code"],"allowed"); Ok(())
}
pub async fn act(f: &Fixture, serial: u64, text: &str, amount: u128, hint: &str) -> Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(f.agent.call(f.contract.id(),"authorize_and_pay_tiered").args_json(json!({"serial":serial,
        "action":"transfer","target":f.recipient.id(),"amount":amount.to_string(),
        "instruction":text,"source":"owner_chat","judge_hint":hint})).transact().await?)
}
pub async fn signature(f: &Fixture, id: u64, approve: bool) -> Result<String> {
    let pending=items(f).await?;
    let item=pending.as_array().unwrap().iter().find(|p|p["id"].as_u64()==Some(id));
    // A resolved id has no signable request; duplicates still reach the contract.
    if let Some(item)=item {
        let item:PendingItem=serde_json::from_value(item.clone())?;
        Ok(hex::encode(fixture_sign(&f.key, &pending_decision_v2_bytes(
            &f.contract.id().as_str().parse()?,id,approve,&pending_request_hash(&item)), &f.deployment_id).to_bytes()))
    } else { Ok("00".repeat(64)) }
}
pub async fn resolve(f: &Fixture, id: u64, approve: bool) -> Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(f.agent.call(f.contract.id(),if approve {"approve_pending"} else {"reject_pending"})
        .args_json(json!({"id":id,"signature":signature(f,id,approve).await?})).transact().await?)
}
pub fn event(r: &near_workspaces::result::ExecutionFinalResult, name: &str) {
    assert!(r.is_success(),"{r:?}");
    assert!(r.logs().iter().any(|l| l.contains(&format!("\"event\":\"{name}\""))),"missing {name}");
}
pub async fn items(f: &Fixture) -> Result<Value> { Ok(f.contract.view("pending_items").await?.json()?) }
pub async fn escalate(f: &Fixture, serial: u64) -> Result<()> {
    let before=f.balances().await?;
    let r=act(f,serial,&f.instruction,NEAR,"pass").await?;
    event(&r,"pending_created"); event(&r,"tier2_decision");
    let d:Value=r.json()?; assert_eq!(d["reason_code"],"tier2_escalate");
    let after=f.balances().await?;
    assert_eq!(after.0,before.0); assert_eq!(after.2,before.2-NEAR as i128);
    let budget:U128=f.contract.view("remaining_budget").args_json(json!({"serial":serial})).await?.json()?;
    assert_eq!(budget.0,4*NEAR);
    let retry=act(f,serial,&f.instruction,NEAR,"pass").await?;
    let d:Value=retry.json()?; assert_eq!(d["reason_code"],"instruction_reused");
    println!("TIER-2 ESCALATE serial={serial} recipient_delta={} escrow_delta={}",after.0-before.0,after.2-before.2); Ok(())
}
pub async fn past_deadline(f: &Fixture) -> Result<()> {
    let pending=items(f).await?;
    let deadline=pending.as_array().unwrap().iter().map(|p| p["deadline"].as_u64().unwrap()).max().unwrap();
    let before=f.worker.view_block().await?; f.worker.fast_forward(2).await?;
    let now=f.worker.view_block().await?;
    let ns=(now.timestamp()-before.timestamp())/(now.height()-before.height());
    f.worker.fast_forward(deadline.saturating_sub(now.timestamp())/ns.max(1)+10).await?; Ok(())
}

// Offline fixture domain; production signers must query signature_domain.
fn fixture_sign(key: &ed25519_dalek::SigningKey, payload: &[u8], deployment_id: &str) -> ed25519_dalek::Signature {
    use ed25519_dalek::Signer;
    let owner: near_sdk::PublicKey = format!("ed25519:{}", bs58::encode(key.verifying_key().to_bytes()).into_string()).parse().unwrap();
    key.sign(&chopgate::authorization_bytes("local-test", deployment_id, &owner, payload))
}
