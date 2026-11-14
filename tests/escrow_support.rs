use anyhow::Result;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::json_types::U128;
use near_workspaces::{Account, Contract, types::NearToken};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use chopgate::{signing_bytes, Permission, Mandate};
pub const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
// Contract-only tolerance: caller pays gas, but contract gas reward credits and
// storage staking can affect its balance. Recipient and escrow deltas are exact.
pub const TOL: u128 = NEAR / 100;
// Covers asynchronously applied unused-gas refunds: a call may attach up to
// 300 Tgas, about 0.03 NEAR at the sandbox gas price. This is deliberately much
// smaller than the 1 NEAR payout so escrow money reaching the agent is caught.
pub const AGENT_REFUND_TOL: u128 = NEAR / 20;
static WASM: tokio::sync::OnceCell<Vec<u8>> = tokio::sync::OnceCell::const_new();
pub struct Fixture {
    pub worker: near_workspaces::Worker<near_workspaces::network::Sandbox>,
    pub contract: Contract,
    pub owner: Account,
    pub agent: Account,
    pub recipient: Account,
    #[allow(dead_code)]
    pub key: SigningKey,
    pub instruction: String,
    pub deployment_id: String,
}
pub fn pk(key: &SigningKey) -> String {
    format!("ed25519:{}", bs58::encode(key.verifying_key().to_bytes()).into_string())
}
impl Fixture {
    pub async fn new() -> Result<Self> {
        let wasm = WASM.get_or_try_init(|| async { near_workspaces::compile_project("./").await }).await?;
        let worker = near_workspaces::sandbox().await?;
        let contract = worker.dev_deploy(wasm).await?;
        let owner = worker.dev_create_account().await?;
        // Only a small gas balance; invoice and escrow funds stay with the contract.
        let agent = owner.create_subaccount("agent").initial_balance(NearToken::from_yoctonear(NEAR / 10)).transact().await?.into_result()?;
        let recipient = worker.dev_create_account().await?;
        let key = SigningKey::generate(&mut rand::rngs::OsRng);
        contract.call("new").args_json(json!({"owner_public_key":pk(&key),"chain_id":"local-test","deployment_id":"deployment-1"})).transact().await?.into_result()?;
        let (_,deployment_id,_):(String,String,near_sdk::PublicKey)=contract.view("signature_domain").await?.json()?;
        let instruction = format!("transfer 1 NEAR to {}", recipient.id());
        let w = Mandate { serial:1, agent:agent.id().as_str().parse()?, entries:vec![Permission {
            action:"transfer".into(), target:recipient.id().to_string(), max_amount:U128(NEAR),
            instruction_hash:hex::encode(Sha256::digest(instruction.as_bytes())),
        }], budget:U128(5*NEAR), expires_at:4_000_000_000_000_000_000, parent_serial:None };
        let sig = hex::encode(fixture_sign(&key, &signing_bytes(&contract.id().as_str().parse()?, &w), &deployment_id).to_bytes());
        let d: Value = agent.call(contract.id(),"register").args_json(json!({"mandate":w,"signer_public_key":pk(&key),"signature":sig})).transact().await?.json()?;
        assert_eq!(d["reason_code"],"allowed");
        Ok(Self {worker,contract,owner,agent,recipient,key,instruction,deployment_id})
    }
    pub async fn deposit(&self, amount:u128) -> Result<()> {
        self.owner.call(self.contract.id(),"deposit").deposit(NearToken::from_yoctonear(amount)).transact().await?.into_result()?; Ok(())
    }
    pub async fn escrow(&self) -> Result<u128> {
        let b: U128=self.contract.view("escrow_balance").await?.json()?; Ok(b.0)
    }
    #[allow(dead_code)]
    pub async fn budget(&self) -> Result<U128> { Ok(self.contract.view("remaining_budget").args_json(json!({"serial":1})).await?.json()?) }
    pub async fn balances(&self) -> Result<(i128,i128,i128)> {
        Ok((self.recipient.view_account().await?.balance.as_yoctonear() as i128,
            self.worker.view_account(self.contract.id()).await?.balance.as_yoctonear() as i128,
            self.escrow().await? as i128))
    }
    pub async fn act(&self, method:&str, text:&str, amount:u128) -> Result<near_workspaces::result::ExecutionFinalResult> {
        Ok(self.agent.call(self.contract.id(),method).args_json(json!({"serial":1,"action":"transfer","target":self.recipient.id(),"amount":amount.to_string(),"instruction":text})).transact().await?)
    }
    pub async fn check_call(&self, name:&str, method:&str, text:&str, amount:u128, code:&str, paid:u128) -> Result<()> {
        let before=self.balances().await?;
        let agent_before=self.agent.view_account().await?.balance.as_yoctonear();
        let r=self.act(method,text,amount).await?;
        assert!(r.is_success(),"{r:?}");
        if paid>0 { assert!(r.logs().iter().any(|s|s.contains("\"event\":\"payout\""))); }
        let d:Value=r.json()?; assert_eq!(d["reason_code"],code);
        let after=self.balances().await?;
        let agent_after=self.agent.view_account().await?.balance.as_yoctonear();
        let delta=print_delta(name,before,after,agent_before,agent_after);
        assert_eq!(delta.0,paid as i128); assert_eq!(delta.2,-(paid as i128));
        assert!((delta.1+paid as i128).abs()<=TOL as i128);
        assert!(agent_after<=agent_before+AGENT_REFUND_TOL);
        if paid>0 { assert!(agent_after<agent_before+paid/2); }
        Ok(())
    }
}
pub fn print_delta(name:&str,b:(i128,i128,i128),a:(i128,i128,i128),agent_before:u128,agent_after:u128)->(i128,i128,i128) {
    let d=(a.0-b.0,a.1-b.1,a.2-b.2);
    eprintln!("BALANCE {name} recipient_delta={} contract_delta={} escrow_delta={} agent_delta={}",d.0,d.1,d.2,agent_after as i128-agent_before as i128); d
}

// Offline fixture domain; production signers must query signature_domain.
fn fixture_sign(key: &ed25519_dalek::SigningKey, payload: &[u8], deployment_id: &str) -> ed25519_dalek::Signature {
    use ed25519_dalek::Signer;
    let owner: near_sdk::PublicKey = format!("ed25519:{}", bs58::encode(key.verifying_key().to_bytes()).into_string()).parse().unwrap();
    key.sign(&chopgate::authorization_bytes("local-test", deployment_id, &owner, payload))
}
