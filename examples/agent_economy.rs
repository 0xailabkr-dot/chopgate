#[path="../tests/attack_support.rs"]
mod attack_support;
use attack_support::*;
use anyhow::Result;
use serde_json::Value;
use chopgate::{jev::{MockJev,build_report,JevAdapter},judge::Verdict,tier2::evaluate};
use sha2::{Digest,Sha256};
use std::time::Instant;
use ed25519_dalek::Signer;
async fn run()->Result<()> {
    println!("JEV MODE: offline mock; source classification is model judgment, not proof; all METRICS use mock JEV");
    let f=ready().await?;let mut metrics=DemoMetrics::default();let mut scenes_ok=true;
    let before=f.balances().await?;
    let first=dual(&f,1,"owner_signed_confident").await?;
    let d:Value=first.clone().json().unwrap_or(Value::Null);metrics.record_normal(d["reason_code"]=="tier2_deny");
    scenes_ok &= observed_reason(&first,"allowed") && has_event(&first,"payout_settled");
    let after=f.balances().await?;scenes_ok &= after.0-before.0==NEAR as i128;
    println!("SCENE 1: allowed API subscription service -> tier 1 pass, tier 2 pass, paid; recipient_delta={}",after.0-before.0);
    // Existing subscription category represents the allow-listed API service.
    set_rules(&f,rules(&f,2,NEAR-1)).await?;register(&f,2).await?;
    let second=dual(&f,2,"owner_signed_confident").await?;
    let d:Value=second.clone().json().unwrap_or(Value::Null);metrics.record_normal(d["reason_code"]=="tier2_deny");
    scenes_ok &= observed_reason(&second,"tier2_escalate") && no_transfer(&second);
    set_rules(&f,rules(&f,3,NEAR)).await?;
    let before=f.balances().await?;let approval=resolve(&f,1,true).await?;
    if approval.is_success() && has_event(&approval,"payout_settled") { metrics.record_normal_approval(); }
    scenes_ok &= f.balances().await?.0-before.0==NEAR as i128;
    println!("SCENE 2: purchase above limit -> pending, signed limit raised, exact request hash approved, paid");
    fresh_rules(&f).await?;register(&f,3).await?;let before=f.balances().await?;
    let hidden=dual(&f,3,"hidden_instruction").await?;
    let after=f.balances().await?;
    let hidden_blocked=observed_reason(&hidden,"tier2_deny") && no_transfer(&hidden)
        && after.0==before.0 && after.2==before.2;
    metrics.record_attack(hidden_blocked);
    scenes_ok &= hidden_blocked;
    println!("SCENE 3: hidden external instruction blocked={hidden_blocked}");
    metrics.record_attack(budget_attack(&f).await?);
    metrics.record_attack(replay_attack(&f).await?);
    metrics.record_attack(binding_attack(&f).await?);
    metrics.record_attack(failure_attack(&f).await?);
    let DemoMetrics { attacks, blocked, normal, false_blocks, human_approvals }=&metrics;
    println!("METRICS attacks_blocked={blocked}/{attacks}");
    println!("METRICS false_blocks_on_normal={false_blocks}/{normal}");
    println!("METRICS human_approvals={human_approvals}");
    // Measure local evaluation stages only. These are mock JEV timings, never block time.
    let r=rules(&f,1,NEAR);let target=f.recipient.id().as_str();
    let start=Instant::now();let hash=hex::encode(Sha256::digest(f.instruction.as_bytes()));
    let permission=chopgate::Permission {action:"transfer".into(),target:target.into(),
        max_amount:near_sdk::json_types::U128(NEAR),instruction_hash:hash.clone()};
    let mandate=chopgate::Mandate {serial:999,agent:f.agent.id().as_str().parse()?,entries:vec![permission],
        budget:near_sdk::json_types::U128(NEAR),expires_at:4_000_000_000_000_000_000,parent_serial:None};
    let bytes=chopgate::signing_bytes(&f.contract.id().as_str().parse()?,&mandate);
    let signature=fixture_sign(&f.key, &bytes, &f.deployment_id);f.key.verifying_key().verify_strict(&chopgate::authorization_bytes("local-test",&f.deployment_id,&attack_support::dual_support::tier_support::escrow_support::pk(&f.key).parse()?,&bytes),&signature)?;
    assert_eq!(mandate.entries[0].instruction_hash,hash);assert_eq!(mandate.entries[0].target,target);
    assert!(NEAR<=mandate.entries[0].max_amount.0 && NEAR<=mandate.budget.0);
    let tier1=start.elapsed().as_micros();
    let mock=MockJev::from_file("fixtures/jev/owner_signed_confident.json").map_err(anyhow::Error::msg)?;
    let start=Instant::now();let source=mock.classify_source(&f.instruction,"local API invoice").map_err(anyhow::Error::msg)?;
    assert_eq!(source.label,"owner_signed");let p=build_report(&mock,&f.instruction,"local API invoice",&hash,"mock").map_err(anyhow::Error::msg)?;
    assert_eq!(evaluate(&chopgate::SpendRules::default(),target,NEAR,&hash,Some(&p),0,0,0,true,Verdict::Pass).verdict,Verdict::Pass);
    let tier2a=start.elapsed().as_micros();
    let start=Instant::now();assert_eq!(evaluate(&r,target,NEAR,&hash,Some(&p),0,0,0,true,Verdict::Pass).verdict,Verdict::Pass);
    let tier2b=start.elapsed().as_micros();
    let start=Instant::now();let mut near_limit=r.clone();near_limit.per_tx_limit=near_sdk::json_types::U128(NEAR-1);
    let mut queue=Vec::new();let outcome=evaluate(&near_limit,target,NEAR,&hash,Some(&p),0,0,0,true,Verdict::Pass);
    if outcome.verdict==Verdict::Escalate {queue.push((target,NEAR,hash.clone()));}
    assert_eq!(queue.len(),1);std::hint::black_box(&queue);let tier3=start.elapsed().as_micros();
    println!("METRICS stage_time (mock JEV, offline; NOT real JEV latency) tier1={tier1}us tier2a={tier2a}us tier2b={tier2b}us tier3_queue={tier3}us");
    anyhow::ensure!(metrics.passes() && metrics.normal==2 && scenes_ok,"Agent Economy observed outcomes failed");
    println!("AGENT ECONOMY RESULT: PASS");
    Ok(())
}
#[tokio::main]
async fn main(){run().await.expect("Agent Economy demo failed");}

// Offline fixture domain; production signers must query signature_domain.
fn fixture_sign(key: &ed25519_dalek::SigningKey, payload: &[u8], deployment_id: &str) -> ed25519_dalek::Signature {
    use ed25519_dalek::Signer;
    let owner: near_sdk::PublicKey = format!("ed25519:{}", bs58::encode(key.verifying_key().to_bytes()).into_string()).parse().unwrap();
    key.sign(&chopgate::authorization_bytes("local-test", deployment_id, &owner, payload))
}
