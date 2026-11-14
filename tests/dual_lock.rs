mod dual_support;
use dual_support::*;
use anyhow::Result;
use serde_json::json;
#[tokio::test]
async fn sandbox_hidden_instruction_2a_deny_no_payout()->Result<()> {
    let f=Fixture::new().await?;f.deposit(10*NEAR).await?;set_rules(&f,rules(&f,1,NEAR)).await?;
    no_payout(&f,"hidden_instruction").await
}
#[tokio::test]
async fn sandbox_off_allowlist_2b_deny()->Result<()> {
    let f=Fixture::new().await?;f.deposit(10*NEAR).await?;let mut r=rules(&f,1,NEAR);r.payees.clear();set_rules(&f,r).await?;
    no_payout(&f,"owner_signed_confident").await
}
#[tokio::test]
async fn sandbox_q062_escalates_to_pending()->Result<()> {
    let f=Fixture::new().await?;f.deposit(10*NEAR).await?;set_rules(&f,rules(&f,1,NEAR)).await?;
    let before=f.balances().await?;let r=dual(&f,1,"uncertain_062").await?;decision(&r,"tier2_escalate")?;event(&r,"pending_created");
    assert_eq!(items(&f).await?.as_array().unwrap().len(),1);let after=f.balances().await?;assert_eq!(after.0,before.0);assert_eq!(after.2,before.2-NEAR as i128);Ok(())
}
#[tokio::test]
async fn sandbox_rules_limit_change_flips_outcome()->Result<()> {
    let f=Fixture::new().await?;f.deposit(10*NEAR).await?;set_rules(&f,rules(&f,1,NEAR-1)).await?;
    decision(&dual(&f,1,"owner_signed_confident").await?,"tier2_escalate")?;
    set_rules(&f,rules(&f,2,NEAR)).await?;
    // Same payment request, fresh signed entry: escalation consumed serial 1.
    register(&f,2).await?;let before=f.balances().await?;
    let r=dual(&f,2,"owner_signed_confident").await?;decision(&r,"allowed")?;event(&r,"payout_settled");
    let after=f.balances().await?;assert_eq!(after.0-before.0,NEAR as i128);assert_eq!(after.2,before.2-NEAR as i128);Ok(())
}
#[tokio::test]
async fn sandbox_unsigned_rules_update_rejected()->Result<()> {
    let f=Fixture::new().await?;
    assert!(!f.agent.call(f.contract.id(),"set_spend_rules").args_json(json!({"rules":rules(&f,1,NEAR),"signature":"00".repeat(64)})).transact().await?.is_success());Ok(())
}
