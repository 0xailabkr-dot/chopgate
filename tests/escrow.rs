mod escrow_support;
use escrow_support::*;
use anyhow::Result;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::json_types::U128;
use serde_json::json;
use chopgate::withdrawal_bytes;
#[tokio::test]
async fn deposit_is_tracked_in_state()->Result<()> {
    let f=Fixture::new().await?; let b=f.balances().await?; let agent_before=f.agent.view_account().await?.balance.as_yoctonear(); f.deposit(10*NEAR).await?;
    let d=print_delta("deposit_is_tracked_in_state",b,f.balances().await?,agent_before,f.agent.view_account().await?.balance.as_yoctonear());
    assert_eq!(f.escrow().await?,10*NEAR); assert_eq!(d.0,0); assert_eq!(d.2,(10*NEAR) as i128); assert!((d.1-10*NEAR as i128).abs()<=TOL as i128); Ok(())
}
#[tokio::test]
async fn allowed_order_pays_recipient_from_escrow()->Result<()> {
    let f=Fixture::new().await?; f.deposit(10*NEAR).await?;
    f.check_call("allowed_order_pays_recipient_from_escrow","authorize_and_pay",&f.instruction,NEAR,"allowed",NEAR).await
}
#[tokio::test]
async fn blocked_unsigned_instruction_pays_zero()->Result<()> {
    let f=Fixture::new().await?; f.deposit(10*NEAR).await?;
    f.check_call("blocked_unsigned_instruction_pays_zero","authorize_and_pay","hidden instruction",NEAR,"unsigned_instruction",0).await
}
#[tokio::test]
async fn blocked_over_limit_pays_zero()->Result<()> {
    let f=Fixture::new().await?; f.deposit(10*NEAR).await?;
    f.check_call("blocked_over_limit_pays_zero","authorize_and_pay",&f.instruction,2*NEAR,"entry_limit_exceeded",0).await
}
#[tokio::test]
async fn plain_authorize_never_moves_funds()->Result<()> {
    let f=Fixture::new().await?; f.deposit(10*NEAR).await?;
    f.check_call("plain_authorize_never_moves_funds","authorize",&f.instruction,NEAR,"allowed",0).await
}
#[tokio::test]
async fn insufficient_escrow_reverts_and_keeps_budget()->Result<()> {
    let f=Fixture::new().await?; let b=f.balances().await?; let agent_before=f.agent.view_account().await?.balance.as_yoctonear(); let budget=f.budget().await?;
    let r=f.act("authorize_and_pay",&f.instruction,NEAR).await?;
    assert!(r.is_failure()); assert!(format!("{r:?}").contains("payout_unavailable"));
    assert_eq!(f.budget().await?,budget);
    let d=print_delta("insufficient_escrow_reverts_and_keeps_budget",b,f.balances().await?,agent_before,f.agent.view_account().await?.balance.as_yoctonear());
    assert_eq!(d.0,0); assert_eq!(d.2,0); assert!(d.1.abs()<=TOL as i128); Ok(())
}
#[tokio::test]
async fn agent_cannot_withdraw_and_owner_can()->Result<()> {
    let f=Fixture::new().await?; f.deposit(10*NEAR).await?;
    let bytes=withdrawal_bytes(&f.contract.id().as_str().parse()?,U128(NEAR),&f.recipient.id().as_str().parse()?,1);
    let foreign=SigningKey::generate(&mut rand::rngs::OsRng);
    let b=f.balances().await?; let agent_before=f.agent.view_account().await?.balance.as_yoctonear(); let budget=f.budget().await?;
    for signature in [String::new(),hex::encode(fixture_sign(&foreign, &bytes, &f.deployment_id).to_bytes())] {
        let r=f.agent.call(f.contract.id(),"withdraw_escrow").args_json(json!({"amount":NEAR.to_string(),"recipient":f.recipient.id(),"nonce":1,"signature":signature})).transact().await?;
        assert!(r.is_failure());
    }
    let d=print_delta("agent_cannot_withdraw_and_owner_can_rejected",b,f.balances().await?,agent_before,f.agent.view_account().await?.balance.as_yoctonear());
    assert_eq!(d.0,0); assert_eq!(d.2,0); assert!(d.1.abs()<=TOL as i128); assert_eq!(f.budget().await?,budget);
    let signature=hex::encode(fixture_sign(&f.key, &bytes, &f.deployment_id).to_bytes());
    let args=json!({"amount":NEAR.to_string(),"recipient":f.recipient.id(),"nonce":1,"signature":signature});
    let b=f.balances().await?; let agent_before=f.agent.view_account().await?.balance.as_yoctonear();
    f.owner.call(f.contract.id(),"withdraw_escrow").args_json(args.clone()).transact().await?.into_result()?;
    let d=print_delta("agent_cannot_withdraw_and_owner_can",b,f.balances().await?,agent_before,f.agent.view_account().await?.balance.as_yoctonear());
    assert_eq!(d.0,NEAR as i128); assert_eq!(d.2,-(NEAR as i128)); assert!((d.1+NEAR as i128).abs()<=TOL as i128);
    let b=f.balances().await?; let agent_before=f.agent.view_account().await?.balance.as_yoctonear();
    assert!(f.owner.call(f.contract.id(),"withdraw_escrow").args_json(args).transact().await?.is_failure());
    let d=print_delta("agent_cannot_withdraw_and_owner_can_replay",b,f.balances().await?,agent_before,f.agent.view_account().await?.balance.as_yoctonear());
    assert_eq!(d.0,0); assert_eq!(d.2,0); assert!(d.1.abs()<=TOL as i128); Ok(())
}

#[tokio::test]
async fn failed_transfer_restores_escrow() -> Result<()> {
    use sha2::{Digest, Sha256};
    use chopgate::{signing_bytes, Permission, Mandate};
    let f = Fixture::new().await?;
    f.deposit(10 * NEAR).await?;
    // A named subaccount is syntactically valid but is never created.
    let recipient: near_workspaces::AccountId = format!("missing.{}", f.owner.id()).parse()?;
    let instruction = format!("transfer 1 NEAR to {recipient}");
    let mandate = Mandate { serial: 2, agent: f.agent.id().as_str().parse()?,
        entries: vec![Permission { action: "transfer".into(), target: recipient.to_string(),
            max_amount: U128(NEAR), instruction_hash: hex::encode(Sha256::digest(instruction.as_bytes())) }],
        budget: U128(NEAR), expires_at: 4_000_000_000_000_000_000, parent_serial: None };
    let signature = hex::encode(fixture_sign(&f.key, &signing_bytes(&f.contract.id().as_str().parse()?, &mandate), &f.deployment_id).to_bytes());
    f.agent.call(f.contract.id(), "register").args_json(json!({"mandate":mandate,
        "signer_public_key":pk(&f.key), "signature":signature})).transact().await?.into_result()?;
    let escrow_before = f.escrow().await?;
    // transact waits for all receipts, including the detached callback.
    let result = f.agent.call(f.contract.id(), "authorize_and_pay").args_json(json!({
        "serial":2, "action":"transfer", "target":recipient, "amount":NEAR.to_string(),
        "instruction":instruction})).transact().await?;
    let escrow_after = f.escrow().await?;
    eprintln!("BALANCE failed_transfer_restores_escrow escrow_before={escrow_before} escrow_after={escrow_after}");
    assert_eq!(escrow_after, escrow_before);
    let error = f.worker.view_account(&recipient).await.expect_err("recipient must not exist");
    let message = format!("{error:?}").to_lowercase();
    assert!(message.contains("unknownaccount") || message.contains("unknown_account") || message.contains("does not exist"), "{error:?}");
    assert!(result.logs().iter().any(|s| s.contains("\"event\":\"payout_refunded\"")));
    let decision: serde_json::Value = result.json()?;
    assert_eq!(decision["reason_code"], "allowed");
    Ok(())
}

#[tokio::test]
async fn failed_withdrawal_restores_escrow() -> Result<()> {
    let f = Fixture::new().await?;
    f.deposit(10 * NEAR).await?;
    let recipient: near_workspaces::AccountId = format!("missing.{}", f.owner.id()).parse()?;
    let bytes = withdrawal_bytes(&f.contract.id().as_str().parse()?, U128(NEAR),
        &recipient.as_str().parse()?, 1);
    let signature = hex::encode(fixture_sign(&f.key, &bytes, &f.deployment_id).to_bytes());
    let escrow_before = f.escrow().await?;
    // transact waits for the transfer and its settlement callback.
    let result = f.owner.call(f.contract.id(), "withdraw_escrow").args_json(json!({
        "amount":NEAR.to_string(), "recipient":recipient, "nonce":1,
        "signature":signature})).transact().await?;
    let escrow_after = f.escrow().await?;
    eprintln!("BALANCE failed_withdrawal_restores_escrow escrow_before={escrow_before} escrow_after={escrow_after}");
    assert_eq!(escrow_after, escrow_before);
    let error = f.worker.view_account(&recipient).await.expect_err("recipient must not exist");
    let message = format!("{error:?}").to_lowercase();
    assert!(message.contains("unknownaccount") || message.contains("unknown_account") || message.contains("does not exist"), "{error:?}");
    assert!(result.logs().iter().any(|s| s.contains("\"event\":\"withdraw_refunded\"")));
    Ok(())
}

// Offline fixture domain; production signers must query signature_domain.
fn fixture_sign(key: &ed25519_dalek::SigningKey, payload: &[u8], deployment_id: &str) -> ed25519_dalek::Signature {
    use ed25519_dalek::Signer;
    let owner: near_sdk::PublicKey = format!("ed25519:{}", bs58::encode(key.verifying_key().to_bytes()).into_string()).parse().unwrap();
    key.sign(&chopgate::authorization_bytes("local-test", deployment_id, &owner, payload))
}
