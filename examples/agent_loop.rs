// This is a rule-based stand-in for an agent, not an LLM. It shows what the
// gate does with an unsigned instruction, not that any model is safe.
#[path = "../tests/escrow_support.rs"]
mod escrow_support;
use escrow_support::*;
use anyhow::Result;
use serde_json::{json, Value};

fn strip_tags(page: &str) -> String {
    // Deliberately naive: preserve comment bodies as well as display:none text.
    let page=page.replace("<!--", " ").replace("-->", " ");
    let mut in_tag=false;
    page.chars().filter(|c| {
        if *c=='<' { in_tag=true; return false; }
        if *c=='>' { in_tag=false; return false; }
        !in_tag
    }).collect()
}
fn plan(text:&str)->(String,u128,String) {
    let start=text.find("transfer ").expect("transfer sentence");
    let words:Vec<&str>=text[start..].split_whitespace().collect();
    assert_eq!(words[0],"transfer"); assert_eq!(words[2],"NEAR"); assert_eq!(words[3],"to");
    let amount=words[1].parse::<u128>().expect("whole NEAR").checked_mul(NEAR).unwrap();
    let target=words[4].trim_end_matches('.').to_string();
    (format!("transfer {} NEAR to {}",words[1],target),amount,target)
}
async fn run()->Result<()> {
    let f=Fixture::new().await?;
    let attacker=f.worker.dev_create_account().await?;
    // The owner-side setup holds the signing key; the act request uses only agent.
    f.deposit(10*NEAR).await?;
    println!("1. read_page: local fixture (hidden text retained)");
    let path=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("examples/fixtures/product-page.html");
    let page=std::fs::read_to_string(path)?;
    let text=strip_tags(&page).replace("attacker.test",attacker.id().as_str());
    println!("2. plan: first transfer sentence from page");
    let (instruction,amount,target)=plan(&text);
    println!("3. act: unsigned page instruction");
    let before=attacker.view_account().await?.balance.as_yoctonear();
    let escrow=f.escrow().await?;
    let agent_before=f.agent.view_account().await?.balance.as_yoctonear();
    let r=f.agent.call(f.contract.id(),"authorize_and_pay").args_json(json!({"serial":1,
        "action":"transfer","target":target,"amount":amount.to_string(),"instruction":instruction})).transact().await?;
    assert!(r.is_success(),"{r:?}"); let d:Value=r.json()?;
    assert_eq!(d["reason_code"],"unsigned_instruction");
    let after=attacker.view_account().await?.balance.as_yoctonear();
    assert_eq!(after,before); assert_eq!(f.escrow().await?,escrow);
    let agent_after=f.agent.view_account().await?.balance.as_yoctonear();
    assert!(agent_after<=agent_before+AGENT_REFUND_TOL);
    assert!(agent_after<agent_before+amount/2);
    println!("decision=unsigned_instruction recipient_delta=0 escrow_delta=0 transfer=0");
    println!("4. plan: signed owner instruction");
    let (instruction,amount,target)=plan(&f.instruction);
    assert_eq!(target,f.recipient.id().as_str());
    println!("5. act: signed owner instruction");
    f.check_call("agent_loop_signed","authorize_and_pay",&instruction,amount,"allowed",NEAR).await?;
    println!("decision=allowed recipient_delta={} escrow_delta=-{}",NEAR,NEAR);
    println!("AGENT LOOP RESULT: PASS - hidden instruction blocked, transfer 0; signed instruction paid");
    Ok(())
}
#[tokio::main]
async fn main() { run().await.expect("agent loop failed"); }
