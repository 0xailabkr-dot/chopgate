#![allow(dead_code)]
#[path="dual_support.rs"]
pub mod dual_support;
pub use dual_support::*;
use anyhow::Result;
use chopgate::{Mandate, Permission, JudgeReport, PendingItem, signing_bytes, spend_rules_bytes,
    pending_request_hash, pending_decision_v2_bytes};
use near_sdk::json_types::U128;
use ed25519_dalek::Signer;
use serde_json::{json,Value};
use sha2::{Digest,Sha256};

pub async fn submit(f:&Fixture,serial:u64,text:&str,amount:u128,p:Option<JudgeReport>)->Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(f.agent.call(f.contract.id(),"authorize_and_pay_dual").args_json(json!({"serial":serial,
        "action":"transfer","target":f.recipient.id(),"amount":amount.to_string(),"instruction":text,
        "source":"owner_chat","judge_report":p.map(|r|attest(f,serial,text,amount,r)).transpose()?,"judge_hint":null})).transact().await?)
}
#[derive(Debug, Default)]
pub struct DemoMetrics {
    pub attacks: usize,
    pub blocked: usize,
    pub normal: usize,
    pub false_blocks: usize,
    pub human_approvals: usize,
}
impl DemoMetrics {
    pub fn record_attack(&mut self, blocked: bool) {
        self.attacks += 1;
        self.blocked += usize::from(blocked);
    }
    pub fn record_normal(&mut self, denied: bool) {
        self.normal += 1;
        self.false_blocks += usize::from(denied);
    }
    pub fn record_normal_approval(&mut self) { self.human_approvals += 1; }
    pub fn passes(&self) -> bool {
        self.blocked == self.attacks && self.false_blocks == 0 && self.human_approvals == 1
    }
}
pub fn has_event(r: &near_workspaces::result::ExecutionFinalResult, name: &str) -> bool {
    r.logs().iter().any(|l| l.contains(&format!("\"event\":\"{name}\"")))
}
pub fn no_transfer(r: &near_workspaces::result::ExecutionFinalResult) -> bool {
    !has_event(r, "payout") && !has_event(r, "payout_settled")
}
pub fn observed_reason(r: &near_workspaces::result::ExecutionFinalResult, expected: &str) -> bool {
    r.is_success() && r.clone().json::<Value>().ok()
        .and_then(|d| d["reason_code"].as_str().map(|s| s == expected)).unwrap_or(false)
}
// Registration is a prerequisite, but an unexpected on-chain decision is an
// observed failure of this case rather than an assertion that aborts metrics.
async fn register_observed(f: &Fixture, serial: u64) -> Result<bool> {
    let mandate=Mandate { serial, agent:f.agent.id().as_str().parse()?, entries:vec![Permission {
        action:"transfer".into(), target:f.recipient.id().to_string(), max_amount:U128(NEAR),
        instruction_hash:hex::encode(Sha256::digest(f.instruction.as_bytes())) }], budget:U128(5*NEAR),
        expires_at:4_000_000_000_000_000_000, parent_serial:None };
    let signature=hex::encode(fixture_sign(&f.key, &signing_bytes(&f.contract.id().as_str().parse()?, &mandate), &f.deployment_id).to_bytes());
    let r=f.agent.call(f.contract.id(),"register").args_json(json!({"mandate":mandate,
        "signer_public_key":dual_support::tier_support::escrow_support::pk(&f.key),"signature":signature})).transact().await?;
    Ok(observed_reason(&r,"allowed"))
}
pub async fn budget_attack(f:&Fixture)->Result<bool> {
    let mut blocked = true;
    let c:Value=f.contract.view("tier2_config").await?.json()?;
    config(f,c["config_nonce"].as_u64().unwrap()+1,u128::MAX,120_000_000_000).await?;
    fresh_rules(f).await?;
    let texts:Vec<String>=(0..6).map(|i|format!("API invoice {i}")).collect();
    let mandate=Mandate {serial:100,agent:f.agent.id().as_str().parse()?,entries:texts.iter().map(|text|Permission {
        action:"transfer".into(),target:f.recipient.id().to_string(),max_amount:U128(NEAR),
        instruction_hash:hex::encode(Sha256::digest(text.as_bytes()))}).collect(),budget:U128(2*NEAR),
        expires_at:4_000_000_000_000_000_000,parent_serial:None};
    let sig=hex::encode(fixture_sign(&f.key, &signing_bytes(&f.contract.id().as_str().parse()?,&mandate), &f.deployment_id).to_bytes());
    blocked &= observed_reason(&f.agent.call(f.contract.id(),"register").args_json(json!({"mandate":mandate,
        "signer_public_key":dual_support::tier_support::escrow_support::pk(&f.key),"signature":sig})).transact().await?,"allowed");
    let mut reports=Vec::new();
    for text in &texts {let mut p=report(f,"owner_signed_confident")?;p.instruction_hash=hex::encode(Sha256::digest(text.as_bytes()));reports.push(p);}
    let before=f.balances().await?;
    // Tokio is an existing dependency. Each future includes its transact call.
    let (a,b,c)=tokio::join!(submit(f,100,&texts[0],NEAR,Some(reports[0].clone())),
        submit(f,100,&texts[1],NEAR,Some(reports[1].clone())),submit(f,100,&texts[2],NEAR,Some(reports[2].clone())));
    let mut results=vec![a?,b?,c?];
    for i in 3..6 {results.push(submit(f,100,&texts[i],NEAR,Some(reports[i].clone())).await?);}
    let mut paid=0;
    let mut rejected=0;
    for r in results {
        let d=r.clone().json::<Value>().unwrap_or(Value::Null);
        blocked &= r.is_success();
        if d["reason_code"]=="allowed" {
            paid+=NEAR;
            blocked &= has_event(&r,"payout_settled");
        } else {
            rejected+=1;
            blocked &= d["verdict"]=="block"
                && matches!(d["reason_code"].as_str(),Some("budget_exceeded" | "auto_frozen"))
                && no_transfer(&r);
        }
        blocked &= paid<=2*NEAR;
        blocked &= d["remaining_budget"].as_str().and_then(|s|s.parse::<u128>().ok())
            .map(|n|n<=2*NEAR).unwrap_or(false);
    }
    let after=f.balances().await?;
    blocked &= paid==2*NEAR && rejected>0;
    blocked &= after.0-before.0==(2*NEAR) as i128 && before.2-after.2==(2*NEAR) as i128;
    let remaining:U128=f.contract.view("remaining_budget").args_json(json!({"serial":100})).await?.json()?;
    blocked &= remaining.0==0;
    Ok(blocked)
}
pub async fn replay_attack(f:&Fixture)->Result<bool> {
    let mut blocked = true;
    blocked &= register_observed(f,200).await?;
    let before=f.balances().await?;blocked &= observed_reason(&dual(f,200,"owner_signed_confident").await?,"allowed");
    let r=dual(f,200,"owner_signed_confident").await?;blocked &= observed_reason(&r,"instruction_reused") && no_transfer(&r);
    // Reconstruct the same owner-signed mandate bytes and serial.
    let m=Mandate {serial:200,agent:f.agent.id().as_str().parse()?,entries:vec![Permission {
        action:"transfer".into(),target:f.recipient.id().to_string(),max_amount:U128(NEAR),
        instruction_hash:hex::encode(Sha256::digest(f.instruction.as_bytes()))}],budget:U128(5*NEAR),
        expires_at:4_000_000_000_000_000_000,parent_serial:None};
    let signature=hex::encode(fixture_sign(&f.key, &signing_bytes(&f.contract.id().as_str().parse()?,&m), &f.deployment_id).to_bytes());
    let r=f.agent.call(f.contract.id(),"register").args_json(json!({"mandate":m,"signer_public_key":dual_support::tier_support::escrow_support::pk(&f.key),"signature":signature})).transact().await?;
    blocked &= r.is_success() && r.clone().json::<Value>().ok().map(|d|d["reason_code"].as_str().map(|s|s!="allowed").unwrap_or(false)).unwrap_or(false) && no_transfer(&r);
    let r=fresh_rules(f).await?;
    let signature=hex::encode(fixture_sign(&f.key, &spend_rules_bytes(&f.contract.id().as_str().parse()?,&r), &f.deployment_id).to_bytes());
    let replay=f.owner.call(f.contract.id(),"set_spend_rules").args_json(json!({"rules":r,"signature":signature})).transact().await?;
    blocked &= !replay.is_success() && no_transfer(&replay);
    let after=f.balances().await?;blocked &= after.0-before.0==NEAR as i128;Ok(blocked)
}
pub async fn binding_attack(f:&Fixture)->Result<bool> {
    let mut blocked = true;
    blocked &= register_observed(f,300).await?;blocked &= observed_reason(&dual(f,300,"uncertain_062").await?,"tier2_escalate");
    let pending=items(f).await?;let Some(value)=pending.as_array().and_then(|ps|ps.iter().find(|p|p["serial"]==300)) else { return Ok(false); };
    let Ok(item)=serde_json::from_value::<PendingItem>(value.clone()) else { return Ok(false); };let before=f.balances().await?;
    let legacy=hex::encode(fixture_sign(&f.key, &chopgate::pending_decision_bytes(&f.contract.id().as_str().parse()?,item.id,true), &f.deployment_id).to_bytes());
    let legacy_result=f.agent.call(f.contract.id(),"approve_pending").args_json(json!({"id":item.id,"signature":legacy})).transact().await?;
    blocked &= !legacy_result.is_success() && no_transfer(&legacy_result);
    blocked &= f.balances().await?.0==before.0;
    for change_amount in [true,false] {
        let mut altered=item.clone();if change_amount {altered.amount=U128(NEAR+1);} else {altered.target=f.owner.id().to_string();}
        let signature=hex::encode(fixture_sign(&f.key, &pending_decision_v2_bytes(&f.contract.id().as_str().parse()?,item.id,true,&pending_request_hash(&altered)), &f.deployment_id).to_bytes());
        let r=f.agent.call(f.contract.id(),"approve_pending").args_json(json!({"id":item.id,"signature":signature})).transact().await?;
        blocked &= !r.is_success() && no_transfer(&r);blocked &= f.balances().await?.0==before.0;
    }
    let signature=dual_support::tier_support::signature(f,item.id,true).await?;
    let approved=f.agent.call(f.contract.id(),"approve_pending").args_json(json!({"id":item.id,"signature":signature.clone()})).transact().await?;
    blocked &= approved.is_success() && has_event(&approved,"payout_settled");
    let replay=f.agent.call(f.contract.id(),"approve_pending").args_json(json!({"id":item.id,"signature":signature})).transact().await?;
    blocked &= !replay.is_success() && no_transfer(&replay);
    let after=f.balances().await?;blocked &= after.0-before.0==NEAR as i128 && after.2==before.2;blocked &= items(f).await?.as_array().map(|ps|ps.iter().all(|p|p["id"]!=item.id)).unwrap_or(false);Ok(blocked)
}
pub async fn failure_attack(f:&Fixture)->Result<bool> {
    let mut blocked = true;
    let before=f.balances().await?;
    for (i,kind) in ["missing","q","label"].iter().enumerate() {
        let serial=400+i as u64;blocked &= register_observed(f,serial).await?;
        let mut p=report(f,"owner_signed_confident")?;
        if *kind=="q" {p.source_q_permille=1001;}if *kind=="label" {p.source_label="unrecognized".into();}
        let r=submit(f,serial,&f.instruction,NEAR,if *kind=="missing" {None} else {Some(p)}).await?;
        blocked &= observed_reason(&r,"tier2_escalate") && has_event(&r,"pending_created") && no_transfer(&r);
        let pending=items(f).await?;blocked &= pending.as_array().map(|ps|ps.iter().any(|p|p["serial"]==serial)).unwrap_or(false);
        blocked &= f.balances().await?.0==before.0;
    }
    blocked &= f.balances().await?.0==before.0;Ok(blocked)
}
pub async fn fresh_rules(f:&Fixture)->Result<chopgate::SpendRules> {
    let current:Value=f.contract.view("spend_rules").await?.json()?;
    let r=rules(f,current["rules_nonce"].as_u64().unwrap()+1,NEAR);
    set_rules(f,r.clone()).await?;Ok(r)
}
pub async fn ready()->Result<Fixture> {
    let f=Fixture::new().await?;f.deposit(10*NEAR).await?;
    config(&f,1,u128::MAX,120_000_000_000).await?;set_rules(&f,rules(&f,1,NEAR)).await?;Ok(f)
}

#[cfg(test)]
mod metrics_tests {
    use super::DemoMetrics;
    #[test]
    fn metrics_attack_counts_actual_outcomes() {
        let mut m=DemoMetrics::default();
        m.record_normal_approval();
        for blocked in [true,true,false] { m.record_attack(blocked); }
        assert_eq!(m.attacks,3);
        assert_eq!(m.blocked,2);
        assert!(!m.passes());
    }
    #[test]
    fn metrics_human_approvals_normal_flow_only() {
        let mut m=DemoMetrics::default();
        // Binding-attack outcomes include an approval, but only record attacks.
        m.record_attack(true);
        assert_eq!(m.human_approvals,0);
        m.record_normal_approval();
        m.record_attack(false);
        assert_eq!(m.human_approvals,1);
    }
}

// Offline fixture domain; production signers must query signature_domain.
fn fixture_sign(key: &ed25519_dalek::SigningKey, payload: &[u8], deployment_id: &str) -> ed25519_dalek::Signature {
    use ed25519_dalek::Signer;
    let owner: near_sdk::PublicKey = format!("ed25519:{}", bs58::encode(key.verifying_key().to_bytes()).into_string()).parse().unwrap();
    key.sign(&chopgate::authorization_bytes("local-test", deployment_id, &owner, payload))
}
