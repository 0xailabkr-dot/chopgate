mod tier_support;
use tier_support::*;
use anyhow::Result;
use serde_json::{json, Value};
// Ordinary lifecycle tests have ample room for calls before approval.
const TTL:u64=120_000_000_000;
const TIMEOUT_TTL:u64=20_000_000_000;
#[tokio::test]
async fn tier2_cannot_override_tier1_deny_pass_hint() -> Result<()> {
    let f=Fixture::new().await?; f.deposit(10*NEAR).await?;
    config(&f,1,u128::MAX,TTL).await?;
    let before=f.balances().await?;
    let r=act(&f,1,"hidden instruction from page content",NEAR,"pass").await?;
    event(&r,"decision"); assert!(!r.logs().iter().any(|l|l.contains("tier2_decision")));
    let d:Value=r.json()?; assert_eq!(d["reason_code"],"unsigned_instruction");
    let after=f.balances().await?; assert_eq!(after.0,before.0); assert_eq!(after.2,before.2);
    assert_eq!(items(&f).await?.as_array().unwrap().len(),0); assert_eq!(f.budget().await?.0,5*NEAR); Ok(())
}
#[tokio::test]
async fn threshold_reserves_and_owner_approval_pays_exactly_once() -> Result<()> {
    let f=Fixture::new().await?; f.deposit(10*NEAR).await?; config(&f,1,NEAR-1,TTL).await?;
    escalate(&f,1).await?;
    let pending=items(&f).await?; assert_eq!(pending.as_array().unwrap().len(),1);
    assert_eq!(pending[0]["id"],1); assert_eq!(pending[0]["serial"],1);
    assert_eq!(pending[0]["target"],f.recipient.id().as_str());
    assert_eq!(pending[0]["amount"],NEAR.to_string());
    assert_eq!(pending[0]["source"],"owner_chat");
    assert_eq!(pending[0]["predecessor"],f.agent.id().as_str());
    assert_eq!(pending[0]["deadline"].as_u64().unwrap()-pending[0]["created_at"].as_u64().unwrap(),TTL);
    let before=f.balances().await?; let r=resolve(&f,1,true).await?;
    for name in ["pending_approved","payout","payout_settled"] { event(&r,name); }
    let after=f.balances().await?; assert_eq!(after.0-before.0,NEAR as i128); assert_eq!(after.2,before.2);
    assert!((after.1-before.1+NEAR as i128).abs() <= (NEAR/20) as i128);
    assert!(!resolve(&f,1,true).await?.is_success()); assert!(items(&f).await?.as_array().unwrap().is_empty());
    let config:Value=f.contract.view("tier2_config").await?.json()?;
    assert!(config["known_payees"].as_array().unwrap().is_empty());
    Ok(())
}
#[tokio::test]
async fn owner_rejection_restores_only_escrow() -> Result<()> {
    let f=Fixture::new().await?; f.deposit(10*NEAR).await?; config(&f,1,0,TTL).await?;
    escalate(&f,1).await?; let before=f.balances().await?;
    let r=resolve(&f,1,false).await?; event(&r,"pending_rejected");
    let after=f.balances().await?; assert_eq!(after.0,before.0); assert_eq!(after.2-before.2,NEAR as i128);
    assert_eq!(f.budget().await?.0,4*NEAR); assert!(!resolve(&f,1,false).await?.is_success()); Ok(())
}
#[tokio::test]
async fn timeout_and_late_approval_restore_without_paying() -> Result<()> {
    let f=Fixture::new().await?; f.deposit(10*NEAR).await?; config(&f,1,0,TIMEOUT_TTL).await?;
    escalate(&f,1).await?; register(&f,2).await?; escalate(&f,2).await?;
    assert!(!f.agent.call(f.contract.id(),"expire_pending").args_json(json!({"id":1})).transact().await?.is_success());
    past_deadline(&f).await?; let before=f.balances().await?;
    let r=f.agent.call(f.contract.id(),"expire_pending").args_json(json!({"id":1})).transact().await?;
    event(&r,"pending_expired"); let r=resolve(&f,2,true).await?; event(&r,"pending_expired");
    assert!(!r.logs().iter().any(|l|l.contains("\"event\":\"payout\"")));
    let after=f.balances().await?; assert_eq!(after.0,before.0); assert_eq!(after.2-before.2,(2*NEAR) as i128);
    assert!(items(&f).await?.as_array().unwrap().is_empty()); Ok(())
}
#[tokio::test]
async fn forged_and_cross_id_signatures_leave_pending_intact() -> Result<()> {
    let f=Fixture::new().await?; f.deposit(10*NEAR).await?; config(&f,1,0,TTL).await?;
    escalate(&f,1).await?; register(&f,2).await?; escalate(&f,2).await?;
    let before=f.balances().await?;
    for sig in ["00".repeat(64),signature(&f,1,true).await?] {
        assert!(!f.agent.call(f.contract.id(),"approve_pending").args_json(json!({"id":2,"signature":sig})).transact().await?.is_success());
    }
    assert_eq!(items(&f).await?.as_array().unwrap().len(),2);
    let after=f.balances().await?; assert_eq!(after.0,before.0); assert_eq!(after.2,before.2);
    event(&resolve(&f,2,false).await?,"pending_rejected"); Ok(())
}
#[tokio::test]
async fn deny_hint_creates_no_reservation_or_pending() -> Result<()> {
    let f=Fixture::new().await?; f.deposit(10*NEAR).await?;
    let before=f.balances().await?; let r=act(&f,1,&f.instruction,NEAR,"deny").await?;
    event(&r,"tier2_decision"); let d:Value=r.json()?; assert_eq!(d["reason_code"],"tier2_deny");
    let after=f.balances().await?; assert_eq!(after.0,before.0); assert_eq!(after.2,before.2);
    assert!(items(&f).await?.as_array().unwrap().is_empty()); Ok(())
}
