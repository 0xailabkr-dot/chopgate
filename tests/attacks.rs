mod attack_support;
use attack_support::*;
use anyhow::Result;
use std::sync::{Arc,Weak,OnceLock};
// One runtime keeps sandbox I/O alive across the four synchronous test entries.
// Weak ownership lets the last participating test drop the sandbox normally.
static RUNTIME:OnceLock<tokio::runtime::Runtime>=OnceLock::new();
static SHARED:tokio::sync::Mutex<Option<Weak<tokio::sync::Mutex<Fixture>>>>=tokio::sync::Mutex::const_new(None);
fn runtime()->&'static tokio::runtime::Runtime {
    RUNTIME.get_or_init(||tokio::runtime::Runtime::new().expect("test runtime"))
}
async fn shared()->Result<Arc<tokio::sync::Mutex<Fixture>>> {
    let mut slot=SHARED.lock().await;
    if let Some(f)=slot.as_ref().and_then(Weak::upgrade) {return Ok(f);}
    let f=Arc::new(tokio::sync::Mutex::new(ready().await?));
    *slot=Some(Arc::downgrade(&f));Ok(f)
}
async fn run_attack(kind:u8)->Result<()> {
    let fixture=shared().await?;let f=fixture.lock().await;
    let blocked = match kind {0=>budget_attack(&f).await,1=>replay_attack(&f).await,
        2=>binding_attack(&f).await,_=>failure_attack(&f).await}?;
    assert!(blocked,"attack case {kind} was not blocked");
    Ok(())
}
#[test]
fn attack_budget_overrun_concurrent()->Result<()> {runtime().block_on(run_attack(0))}
#[test]
fn attack_signature_instruction_replay()->Result<()> {runtime().block_on(run_attack(1))}
#[test]
fn attack_approval_bound_to_request_hash()->Result<()> {runtime().block_on(run_attack(2))}
#[test]
fn attack_jev_failure_fails_closed()->Result<()> {runtime().block_on(run_attack(3))}
