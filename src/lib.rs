pub mod judge;
pub mod tier2;
#[cfg(not(target_arch = "wasm32"))]
pub mod jev; #[cfg(not(target_arch = "wasm32"))] pub mod jev_live; // same line: keeps wasm panic line numbers unchanged
pub use tier2::{SpendRules, Payee, JudgeReport};
pub fn spend_rules_bytes(contract: &AccountId, rules: &SpendRules) -> Vec<u8> {
    let mut bytes = b"chopgate:spend-rules:v1\0".to_vec();
    bytes.extend(near_sdk::borsh::to_vec(&(contract, rules)).unwrap()); bytes
}
use judge::{Judge, JudgeInput, DefaultJudge, Verdict, final_decision};
use near_sdk::json_types::U128;
use near_sdk::{env, near, AccountId, PublicKey, NearToken, Promise, Gas, PromiseError};
use std::collections::BTreeMap;

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Permission {
    pub action: String,
    pub target: String,
    pub max_amount: U128,
    pub instruction_hash: String,
}
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Mandate {
    pub serial: u64,
    pub agent: AccountId,
    pub entries: Vec<Permission>,
    pub budget: U128,
    pub expires_at: u64,
    pub parent_serial: Option<u64>,
}
#[near(serializers = [borsh])]
struct Stored {
    mandate: Mandate,
    remaining: u128,
    blocks: u32,
    last: Option<String>,
    frozen: bool,
    used: Vec<bool>,
}
#[near(serializers = [json])]
pub struct Decision {
    pub serial: u64,
    pub verdict: String,
    pub reason_code: String,
    pub reason: String,
    pub action: String,
    pub target: String,
    pub amount: U128,
    pub instruction_hash: String,
    pub remaining_budget: U128,
}
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Tier2Config {
    pub config_nonce: u64,
    pub amount_threshold: U128,
    pub pending_ttl_ns: u64,
    pub new_payee_check: bool,
    pub trusted_sources: Vec<String>,
    pub known_payees: Vec<String>,
    pub denied_targets: Vec<String>,
}
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct PendingItem {
    pub id: u64,
    pub serial: u64,
    pub action: String,
    pub target: String,
    pub amount: U128,
    pub instruction_hash: String,
    pub source: String,
    pub predecessor: AccountId,
    pub created_at: u64,
    pub deadline: u64,
    pub report: Option<JudgeReport>,
}
pub fn tier2_config_bytes(contract: &AccountId, config: &Tier2Config) -> Vec<u8> {
    let mut bytes = b"chopgate:tier2-config:v1\0".to_vec();
    bytes.extend(near_sdk::borsh::to_vec(&(contract, config)).unwrap());
    bytes
}
pub fn pending_decision_bytes(contract: &AccountId, id: u64, approve: bool) -> Vec<u8> {
    let mut bytes = b"chopgate:pending-decision:v1\0".to_vec();
    bytes.extend(near_sdk::borsh::to_vec(&(contract, id, approve)).unwrap());
    bytes
}
/// SHA-256 of Borsh(action, target, amount, serial, instruction_hash).
/// Includes execution content only; decision v2 additionally binds contract/id/choice.
pub fn pending_request_hash(item: &PendingItem) -> Vec<u8> {
    env::sha256(&near_sdk::borsh::to_vec(&(
        &item.action, &item.target, item.amount, item.serial, &item.instruction_hash
    )).unwrap())
}
pub fn pending_decision_v2_bytes(contract: &AccountId, id: u64, approve: bool, request_hash: &[u8]) -> Vec<u8> {
    let mut bytes = b"chopgate:pending-decision:v2\0".to_vec();
    bytes.extend(near_sdk::borsh::to_vec(&(contract, id, approve, request_hash)).unwrap());
    bytes
}
#[near(contract_state)]
#[derive(near_sdk::PanicOnDefault)]
pub struct Gate {
    report_nonces: BTreeMap<String, u64>,
    payouts: BTreeMap<u64, (u64, AccountId, U128)>,
    next_payout_id: u64,
    withdrawals: BTreeMap<u64, (AccountId, U128)>,
    chain_id: String,
    deployment_id: String,
    judge_policy: JudgePolicy,
    spend_rules: SpendRules,
    daily: BTreeMap<i64, (u128, u32)>,
    config: Tier2Config,
    pending: BTreeMap<u64, PendingItem>,
    next_pending_id: u64,
    owner: PublicKey,
    escrow: u128,
    withdrawal_nonce: u64,
    mandates: BTreeMap<u64, Stored>,
    counters: BTreeMap<String, u64>,
    causes: BTreeMap<(String, String, String), u64>,
    proposals: Vec<Proposal>,
    version: u64,
}

/// Canonical signing format: ASCII domain, then Borsh(contract AccountId, Mandate).
/// Mandate fields: serial, agent, entries, budget, expires_at, parent_serial.
/// Each signed entry binds action, target, max_amount (U128), instruction_hash in that order.
/// Borsh encodes strings/vectors with little-endian u32 lengths and integers LE.
pub fn signing_bytes(contract: &AccountId, mandate: &Mandate) -> Vec<u8> {
    let mut bytes = b"chopgate:owner-mandate:v1\0".to_vec();
    bytes.extend(near_sdk::borsh::to_vec(&(contract, mandate)).unwrap());
    bytes
}
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Proposal {
    pub proposal_id: u64,
    pub reason_code: String,
    pub action: String,
    pub target: String,
    pub count: u64,
    pub proposed_rule: String,
    pub policy_version: u64,
    pub approved: bool,
    pub revoked: bool,
}
pub fn rule_approval_bytes(
    contract: &AccountId,
    proposal_id: u64,
    policy_version: u64,
    action: &str,
    target: &str,
) -> Vec<u8> {
    let mut bytes = b"chopgate:rule-approval:v1\0".to_vec();
    bytes.extend(
        near_sdk::borsh::to_vec(&(contract, proposal_id, policy_version, action, target)).unwrap(),
    );
    bytes
}
pub fn rule_revocation_bytes(
    contract: &AccountId,
    proposal_id: u64,
    policy_version: u64,
    action: &str,
    target: &str,
) -> Vec<u8> {
    let mut bytes = b"chopgate:rule-revoke:v1\0".to_vec();
    bytes.extend(
        near_sdk::borsh::to_vec(&(contract, proposal_id, policy_version, action, target)).unwrap(),
    );
    bytes
}
/// Full outer signature domain. Deployment id MUST be fresh on account recreation.
/// Asset is native NEAR; inner domains bind method, nonce and all arguments.
pub fn authorization_bytes(chain_id: &str, deployment_id: &str, owner: &PublicKey, payload: &[u8]) -> Vec<u8> {
    let mut bytes=b"chopgate:authorization:v3\0".to_vec();
    bytes.extend(near_sdk::borsh::to_vec(&(chain_id, deployment_id, owner, "native:NEAR", payload)).unwrap()); bytes
}
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct JudgePolicy { pub nonce:u64, pub keys:Vec<PublicKey> }
pub fn judge_policy_bytes(contract:&AccountId, policy:&JudgePolicy)->Vec<u8> {
    let mut b=b"chopgate:judge-policy:v1\0".to_vec();
    b.extend(near_sdk::borsh::to_vec(&(contract,policy)).unwrap()); b
}
pub fn hex_bytes(bytes:&[u8])->String { bytes.iter().map(|b|format!("{b:02x}")).collect() }
pub fn judge_request_hash(serial:u64, action:&str, target:&str, amount:U128, instruction_hash:&str, source:&str, caller:&AccountId)->Vec<u8> {
    env::sha256(&near_sdk::borsh::to_vec(&(serial,action,target,amount,instruction_hash,source,caller)).unwrap())
}
/// Signature excludes the signature field itself, and binds every model output.
pub fn judge_report_bytes(contract:&AccountId, r:&JudgeReport)->Vec<u8> {
    let mut b=b"chopgate:judge-report:v2\0".to_vec();
    b.extend(near_sdk::borsh::to_vec(&(contract,&r.request_hash,r.expires_at,r.nonce,r.key_generation,&r.signer_public_key,&r.source_label,
        r.source_q_permille,&r.instruction_hash,&r.category,r.category_q_permille,&r.mode)).unwrap()); b
}
fn event(name: &str, data: impl near_sdk::serde::Serialize) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        near_sdk::serde_json::json!({"standard":"chopgate","version":"1.0.0","event":name,"data":[data]})
    ));
}
fn valid_signature(owner: &PublicKey, bytes: &[u8], signature: Option<String>) -> bool {
    let sig = signature.and_then(|s| {
        if s.len() != 128 || !s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return None;
        }
        let mut out = [0; 64];
        for (i, b) in out.iter_mut().enumerate() {
            *b = u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()?;
        }
        Some(out)
    });
    if owner.as_bytes().len() != 33 || owner.as_bytes()[0] != 0 { return false; }
    let key: [u8; 32] = owner.as_bytes()[1..].try_into().unwrap();
    sig.map(|s| env::ed25519_verify(&s, bytes, &key))
        .unwrap_or(false)
}
fn similar(a: &str, b: &str) -> bool {
    fn norm(s: &str) -> String {
        s.chars()
            .filter_map(|c| match c {
                '-' | '_' | '.' => None,
                '1' | 'l' | 'i' => Some('l'),
                '0' | 'o' => Some('o'),
                c => Some(c),
            })
            .collect()
    }
    let (a, b) = (norm(a), norm(b));
    a == b || a.starts_with(&b) || a.ends_with(&b) || b.starts_with(&a) || b.ends_with(&a)
}
#[near]
impl Gate {
    #[init]
    pub fn new(owner_public_key: PublicKey, chain_id: String, deployment_id: String) -> Self {
        assert!(!chain_id.is_empty() && !deployment_id.is_empty(), "signature domain required");
        assert_eq!(owner_public_key.as_bytes()[0], 0, "ed25519 required");
        Self {
            report_nonces:BTreeMap::new(), payouts:BTreeMap::new(), next_payout_id:1, withdrawals:BTreeMap::new(),
            chain_id, deployment_id:format!("{}:{}", deployment_id, env::block_timestamp()), judge_policy: JudgePolicy { nonce:0, keys:vec![] },
            spend_rules: SpendRules::default(), daily: BTreeMap::new(),
            config: Tier2Config { config_nonce:0, amount_threshold:U128(u128::MAX),
                pending_ttl_ns:3_600_000_000_000, new_payee_check:false,
                trusted_sources:vec![], known_payees:vec![], denied_targets:vec![] },
            pending:BTreeMap::new(), next_pending_id:1,
            owner: owner_public_key,
            escrow: 0,
            withdrawal_nonce: 0,
            mandates: BTreeMap::new(),
            counters: BTreeMap::new(),
            causes: BTreeMap::new(),
            proposals: Vec::new(),
            version: 1,
        }
    }
    pub fn escrow_balance(&self) -> U128 { U128(self.escrow) }

    #[payable]
    pub fn deposit(&mut self) {
        let amount = env::attached_deposit().as_yoctonear();
        assert!(amount > 0, "deposit must be positive");
        self.escrow = self.escrow.checked_add(amount).expect("escrow overflow");
        event("escrow_deposit", near_sdk::serde_json::json!({
            "depositor":env::predecessor_account_id(), "amount":U128(amount),
            "escrow_balance":U128(self.escrow)}));
    }

    /// Failed transfers restore escrow through a private callback, but leave the
    /// signed entry and mandate budget consumed. Only this payment path is gated;
    /// an agent's keys and funds elsewhere are outside the contract.
    pub fn authorize_and_pay(&mut self, serial: u64, action: String, target: String,
        amount: U128, instruction: String) -> Decision {
        self.authorize_inner(serial, action, target, amount, instruction, true)
    }

    pub fn spend_rules(&self) -> SpendRules { self.spend_rules.clone() }
    pub fn set_spend_rules(&mut self, rules: SpendRules, signature: String) {
        assert!(self.spend_rules.rules_nonce.checked_add(1) == Some(rules.rules_nonce), "rules nonce replay");
        assert!(rules.window_start_min < 1440 && rules.window_end_min < 1440, "invalid window");
        assert!(rules.jev_threshold_permille <= 1000, "invalid threshold");
        assert!((-1440..=1440).contains(&rules.tz_offset_min), "invalid timezone");
        assert!(self.valid_owner_signature( &spend_rules_bytes(&env::current_account_id(), &rules), Some(signature)), "invalid rules signature");
        self.spend_rules = rules;
        event("spend_rules_updated", &self.spend_rules);
    }
    pub fn authorize_and_pay_dual(&mut self, serial:u64, action:String, target:String, amount:U128,
        instruction:String, source:String, judge_report:Option<JudgeReport>, judge_hint:Option<String>) -> Decision {
        self.authorize_path(serial, action, target, amount, instruction, true, source, judge_hint, judge_report)
    }
    pub fn signature_domain(&self) -> (String, String, PublicKey) {
        (self.chain_id.clone(), self.deployment_id.clone(), self.owner.clone())
    }
    pub fn set_judge_policy(&mut self, policy: JudgePolicy, signature: String) {
        assert!(self.judge_policy.nonce.checked_add(1) == Some(policy.nonce), "judge policy replay");
        assert!(policy.keys.iter().all(|k| k.as_bytes().len()==33 && k.as_bytes()[0]==0), "ed25519 required");
        assert!(self.valid_owner_signature(&judge_policy_bytes(&env::current_account_id(), &policy), Some(signature)), "invalid judge policy signature");
        self.judge_policy = policy;
        for item in self.pending.values_mut() {
            if item.report.is_some() { event("pending_report_invalidated", near_sdk::serde_json::json!({"id":item.id,"key_generation":self.judge_policy.nonce})); }
        }
    }
    pub fn tier2_config(&self) -> Tier2Config { self.config.clone() }
    pub fn set_tier2_config(&mut self, config: Tier2Config, signature: String) {
        assert!(self.config.config_nonce.checked_add(1) == Some(config.config_nonce), "config nonce replay");
        assert!(config.pending_ttl_ns > 0, "positive ttl required");
        assert!(self.valid_owner_signature( &tier2_config_bytes(&env::current_account_id(), &config), Some(signature)), "invalid config signature");
        self.config = config;
    }
    pub fn pending_item(&self, id: u64) -> Option<PendingItem> { self.pending.get(&id).cloned() }
    /// Current authenticity only; key rotation never releases the reservation.
    pub fn pending_report_valid(&self, id:u64) -> bool {
        self.pending.get(&id).and_then(|item| item.report.as_ref().map(|r| (item,r))).map_or(false, |(item,r)| {
            self.authenticated_report(r,&judge_request_hash(item.serial,&item.action,&item.target,item.amount,&item.instruction_hash,&item.source,&item.predecessor))
        })
    }
    pub fn pending_items(&self) -> Vec<PendingItem> { self.pending.values().cloned().collect() }
    pub fn authorize_and_pay_tiered(&mut self, serial: u64, action: String, target: String,
        amount: U128, instruction: String, source: String, judge_hint: Option<String>) -> Decision {
        self.authorize_path(serial, action, target, amount, instruction, true, source, judge_hint, None)
    }
    pub fn approve_pending(&mut self, id: u64, signature: String) {
        self.resolve_pending(id, true, signature);
    }
    pub fn reject_pending(&mut self, id: u64, signature: String) {
        self.resolve_pending(id, false, signature);
    }
    pub fn expire_pending(&mut self, id: u64) {
        let item = self.pending.get(&id).expect("unknown or resolved pending").clone();
        assert!(env::block_timestamp() >= item.deadline, "pending not expired");
        self.pending.remove(&id);
        self.escrow += item.amount.0;
        self.pending_event("pending_expired", &item);
    }

    /// Settles the scheduled transfer without changing authorization history.
    #[private]
    pub fn on_payout(&mut self, serial: u64, recipient: AccountId, amount: U128) {
        // A transfer returns no bytes. Only a failed receipt warrants a refund.
        assert_eq!(env::predecessor_account_id(), env::current_account_id(), "private callback");
        let Some((mandate_serial, expected_recipient, expected_amount)) = self.payouts.get(&serial) else { return; };
        assert!(expected_recipient == &recipient && expected_amount.0 == amount.0, "callback mismatch");
        let mandate_serial=*mandate_serial;
        self.payouts.remove(&serial);
        let failed = matches!(env::promise_result_checked(0, 32), Err(PromiseError::Failed));
        if failed {
            // Budget, used entries, freezes and counters remain unchanged: later
            // authorizations may already have relied on the consumed entry.
            // Overflow is unreachable for escrow backed by NEAR supply; saturate
            // defensively rather than panic and roll back the refund accounting.
            self.escrow = self.escrow.checked_add(amount.0).unwrap_or(u128::MAX);
        }
        event(if failed { "payout_refunded" } else { "payout_settled" },
            near_sdk::serde_json::json!({"serial":mandate_serial, "recipient":recipient,
                "amount":amount, "escrow_balance":U128(self.escrow)}));
    }

    /// Owner-key authority controls escrow; the submitting account has no authority.
    /// Failed transfers restore escrow through a private callback; the nonce stays consumed.
    pub fn withdraw_escrow(&mut self, amount: U128, recipient: AccountId,
        nonce: u64, signature: String) -> Promise {
        assert!(self.withdrawal_nonce.checked_add(1) == Some(nonce), "withdrawal nonce replay");
        assert!(self.valid_owner_signature(
            &withdrawal_bytes(&env::current_account_id(), amount, &recipient, nonce),
            Some(signature)), "invalid withdrawal signature");
        assert!(amount.0 > 0 && amount.0 <= self.escrow, "payout_unavailable: escrow");
        self.escrow -= amount.0;
        self.withdrawal_nonce = nonce;
        self.withdrawals.insert(nonce, (recipient.clone(), amount));
        event("escrow_withdraw", near_sdk::serde_json::json!({"nonce":nonce,
            "recipient":recipient,"amount":amount,"escrow_balance":U128(self.escrow)}));
        Promise::new(recipient.clone()).transfer(NearToken::from_yoctonear(amount.0))
            .then(Self::ext(env::current_account_id())
                .with_static_gas(near_sdk::Gas::from_tgas(5))
                .with_unused_gas_weight(0)
                .on_withdraw(nonce, recipient, amount))
    }

    /// Settles a withdrawal without rolling back its nonce.
    #[private]
    pub fn on_withdraw(&mut self, nonce: u64, recipient: AccountId, amount: U128) {
        assert_eq!(env::predecessor_account_id(), env::current_account_id(), "private callback");
        let Some((expected_recipient, expected_amount)) = self.withdrawals.get(&nonce) else { return; };
        assert!(expected_recipient == &recipient && expected_amount.0 == amount.0, "callback mismatch");
        self.withdrawals.remove(&nonce);
        let failed = matches!(env::promise_result_checked(0, 32), Err(PromiseError::Failed));
        if failed {
            self.escrow = self.escrow.checked_add(amount.0).unwrap_or(u128::MAX);
        }
        event(if failed { "withdraw_refunded" } else { "withdraw_settled" },
            near_sdk::serde_json::json!({"nonce":nonce, "recipient":recipient,
                "amount":amount, "escrow_balance":U128(self.escrow)}));
    }

    pub fn policy_version(&self) -> u64 {
        self.version
    }
    pub fn rules(&self) -> Vec<Proposal> {
        self.proposals.clone()
    }
    pub fn approve_rule(
        &mut self,
        proposal_id: u64,
        signer_public_key: Option<String>,
        signature: Option<String>,
    ) -> Decision {
        let proposal = self
            .proposals
            .iter()
            .find(|p| p.proposal_id == proposal_id)
            .cloned();
        let code = if signature.is_none() {
            "missing_signature"
        } else if signer_public_key
            .and_then(|s| s.parse::<PublicKey>().ok())
            .as_ref()
            != Some(&self.owner)
        {
            "owner_impersonation"
        } else if let Some(p) = &proposal {
            if p.approved || p.revoked {
                "already_approved"
            } else if !self.valid_owner_signature(
                &rule_approval_bytes(
                    &env::current_account_id(),
                    proposal_id,
                    self.version,
                    &p.action,
                    &p.target,
                ),
                signature,
            ) {
                "invalid_signature"
            } else {
                "allowed"
            }
        } else {
            "unknown_proposal"
        };
        let (action, target) = proposal
            .as_ref()
            .map(|p| (p.action.clone(), p.target.clone()))
            .unwrap_or_default();
        if code == "allowed" {
            let old = self.version;
            self.version += 1;
            self.proposals
                .iter_mut()
                .find(|p| p.proposal_id == proposal_id)
                .unwrap()
                .approved = true;
            event(
                "policy_update",
                near_sdk::serde_json::json!({"proposal_id":proposal_id,"old_version":old,"new_version":self.version,"rule":{"action":action,"target":target,"effect":"deny"},"change":"approved"}),
            );
        } else {
            event(
                "policy_update_rejected",
                near_sdk::serde_json::json!({"proposal_id":proposal_id,"reason_code":code,"policy_version":self.version}),
            );
        }
        self.emit(0, code, action, target, U128(0), String::new())
    }
    pub fn revoke_rule(
        &mut self,
        proposal_id: u64,
        signer_public_key: Option<String>,
        signature: Option<String>,
    ) -> Decision {
        let proposal = self
            .proposals
            .iter()
            .find(|p| p.proposal_id == proposal_id)
            .cloned();
        let code = if signature.is_none() {
            "missing_signature"
        } else if signer_public_key
            .and_then(|s| s.parse::<PublicKey>().ok())
            .as_ref()
            != Some(&self.owner)
        {
            "owner_impersonation"
        } else if let Some(p) = &proposal {
            // Verify before activity so stale signed bytes always fail after a version change.
            if !self.valid_owner_signature(
                &rule_revocation_bytes(
                    &env::current_account_id(),
                    proposal_id,
                    self.version,
                    &p.action,
                    &p.target,
                ),
                signature,
            ) {
                "invalid_signature"
            } else if !p.approved {
                "rule_not_active"
            } else {
                "allowed"
            }
        } else {
            "unknown_proposal"
        };
        let (action, target) = proposal
            .as_ref()
            .map(|p| (p.action.clone(), p.target.clone()))
            .unwrap_or_default();
        if code == "allowed" {
            let old = self.version;
            self.version += 1;
            let p = self
                .proposals
                .iter_mut()
                .find(|p| p.proposal_id == proposal_id)
                .unwrap();
            p.approved = false;
            p.revoked = true;
            event(
                "policy_update",
                near_sdk::serde_json::json!({"proposal_id":proposal_id,"old_version":old,"new_version":self.version,"rule":{"action":action,"target":target,"effect":"deny"},"change":"revoked"}),
            );
        } else {
            event(
                "policy_update_rejected",
                near_sdk::serde_json::json!({"proposal_id":proposal_id,"reason_code":code,"policy_version":self.version}),
            );
        }
        self.emit(0, code, action, target, U128(0), String::new())
    }
    pub fn owner_public_key(&self) -> PublicKey {
        self.owner.clone()
    }
    pub fn block_counters(&self) -> BTreeMap<String, u64> {
        self.counters.clone()
    }
    pub fn remaining_budget(&self, serial: u64) -> Option<U128> {
        self.mandates.get(&serial).map(|w| U128(w.remaining))
    }
    pub fn register(
        &mut self,
        mandate: Mandate,
        signer_public_key: Option<String>,
        signature: Option<String>,
    ) -> Decision {
        let serial = mandate.serial;
        let code = if self.mandates.contains_key(&serial) {
            "nonce_reuse"
        } else if mandate.entries.iter().any(|e|e.target.parse::<AccountId>().is_err()) {
            "invalid_recipient"
        } else if signature.is_none() {
            "missing_signature"
        } else if signer_public_key
            .and_then(|s| s.parse::<PublicKey>().ok())
            .as_ref()
            != Some(&self.owner)
        {
            "owner_impersonation"
        } else {
            let sig = signature.and_then(|s| {
                if s.len() != 128 || !s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
                    return None;
                }
                let mut out = [0u8; 64];
                for (i, v) in out.iter_mut().enumerate() {
                    *v = u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()?;
                }
                Some(out)
            });
            let key: [u8; 32] = self.owner.as_bytes()[1..].try_into().unwrap();
            if !sig
                .map(|sig| {
                    env::ed25519_verify(
                        &sig,
                        &authorization_bytes(&self.chain_id, &self.deployment_id, &self.owner,
                            &signing_bytes(&env::current_account_id(), &mandate)),
                        &key,
                    )
                })
                .unwrap_or(false)
            {
                "invalid_signature"
            } else if mandate.expires_at <= env::block_timestamp() {
                "expired"
            } else if let Some(parent) = mandate.parent_serial {
                match self.mandates.get(&parent) {
                    None => "missing_parent",
                    Some(p) if p.frozen => "auto_frozen",
                    Some(p) if env::predecessor_account_id() != p.mandate.agent => "wrong_caller",
                    Some(p) if p.mandate.expires_at <= env::block_timestamp() => "expired",
                    Some(p) => {
                        let mut matched = Vec::new();
                        let subset = mandate.entries.iter().all(|e| {
                            let index = p
                                .mandate
                                .entries
                                .iter()
                                .enumerate()
                                .find(|(i, t)| {
                                    !p.used[*i]
                                        && !matched.contains(i)
                                        && e.action == t.action
                                        && e.target == t.target
                                        && e.instruction_hash == t.instruction_hash
                                        && e.max_amount.0 <= t.max_amount.0
                                })
                                .map(|(i, _)| i);
                            if let Some(i) = index {
                                matched.push(i);
                                true
                            } else {
                                false
                            }
                        });
                        let strict = mandate.entries.len() < p.mandate.entries.len()
                            || mandate.budget.0 < p.remaining
                            || mandate.expires_at < p.mandate.expires_at
                            || matched
                                .iter()
                                .zip(&mandate.entries)
                                .any(|(i, e)| e.max_amount.0 < p.mandate.entries[*i].max_amount.0);
                        if !subset
                            || mandate.budget.0 > p.remaining
                            || mandate.expires_at > p.mandate.expires_at
                            || !strict
                        {
                            "child_wider"
                        } else {
                            "allowed"
                        }
                    }
                }
            } else {
                "allowed"
            }
        };
        if code == "allowed" {
            if let Some(parent) = mandate.parent_serial {
                let p = self.mandates.get_mut(&parent).unwrap();
                p.remaining -= mandate.budget.0;
                for e in &mandate.entries {
                    let i = p
                        .mandate
                        .entries
                        .iter()
                        .enumerate()
                        .position(|(i, t)| {
                            !p.used[i]
                                && e.action == t.action
                                && e.target == t.target
                                && e.instruction_hash == t.instruction_hash
                                && e.max_amount.0 <= t.max_amount.0
                        })
                        .unwrap();
                    p.used[i] = true;
                }
            }
            self.mandates.insert(
                serial,
                Stored {
                    used: vec![false; mandate.entries.len()],
                    remaining: mandate.budget.0,
                    mandate: mandate.clone(),
                    blocks: 0,
                    last: None,
                    frozen: false,
                },
            );
        }
        self.record_block(code, "register", "");
        self.emit(
            serial,
            code,
            "register".into(),
            "".into(),
            mandate.budget,
            String::new(),
        )
    }
    pub fn authorize(
        &mut self,
        serial: u64,
        action: String,
        target: String,
        amount: U128,
        instruction: String,
    ) -> Decision {
        self.authorize_inner(serial, action, target, amount, instruction, false)
    }
}
impl Gate {
    fn authorize_inner(&mut self, serial: u64, action: String, target: String,
        amount: U128, instruction: String, pay: bool) -> Decision {
        self.authorize_path(serial, action, target, amount, instruction, pay, String::new(), None, None)
    }
    fn authorize_path(&mut self, serial: u64, action: String, target: String,
        amount: U128, instruction: String, pay: bool, source: String, judge_hint: Option<String>, judge_report: Option<JudgeReport>) -> Decision {
        if target.parse::<AccountId>().is_err() { return self.emit(serial, "invalid_recipient", action, target, amount, String::new()); }
        // Per-agent cap applies across mandates, before consuming any signed entry.
        if pay && self.pending.values().filter(|p|p.predecessor==env::predecessor_account_id()).count() >= 8 {
            return self.emit(serial, "pending_limit", action, target, amount, String::new());
        }
        let instruction_hash = env::sha256(instruction.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let fingerprint = near_sdk::serde_json::to_string(&(
            &action,
            &target,
            &amount,
            &instruction_hash,
            env::predecessor_account_id(),
        ))
        .unwrap();
        let denied = self
            .proposals
            .iter()
            .any(|p| p.approved && p.action == action && p.target == target);
        let mut underlying = "unknown_mandate";
        let code = match self.mandates.get_mut(&serial) {
            None => "unknown_mandate",
            Some(s) => {
                let mut code = if s.frozen {
                    "auto_frozen"
                } else if env::predecessor_account_id() != s.mandate.agent {
                    "wrong_caller"
                } else if s.mandate.expires_at <= env::block_timestamp() {
                    "expired"
                } else if !s
                    .mandate
                    .entries
                    .iter()
                    .any(|e| e.instruction_hash == instruction_hash)
                {
                    "unsigned_instruction"
                } else if denied {
                    "policy_rule_denied"
                } else if !s
                    .mandate
                    .entries
                    .iter()
                    .any(|p| p.action == action && p.target == target)
                {
                    if s.mandate
                        .entries
                        .iter()
                        .any(|p| p.target != target && similar(&p.target, &target))
                    {
                        "lookalike_account"
                    } else {
                        "out_of_scope"
                    }
                } else if !s.mandate.entries.iter().any(|e| {
                    e.action == action
                        && e.target == target
                        && e.instruction_hash == instruction_hash
                }) {
                    "instruction_binding_mismatch"
                } else if s
                    .mandate
                    .entries
                    .iter()
                    .enumerate()
                    .filter(|(_, e)| {
                        e.action == action
                            && e.target == target
                            && e.instruction_hash == instruction_hash
                    })
                    .all(|(i, _)| s.used[i])
                {
                    "instruction_reused"
                } else if !s.mandate.entries.iter().enumerate().any(|(i, e)| {
                    !s.used[i]
                        && e.action == action
                        && e.target == target
                        && e.instruction_hash == instruction_hash
                        && amount.0 <= e.max_amount.0
                }) {
                    "entry_limit_exceeded"
                } else if amount.0 > s.remaining {
                    "budget_exceeded"
                } else {
                    "allowed"
                };
                underlying = code;
                if code == "allowed" {
                    // Reject zero only after instruction validation, without consuming state.
                    if amount.0 == 0 {
                        return self.emit(serial, "zero_amount", action, target, amount, String::new());
                    }
                    let i = s
                        .mandate
                        .entries
                        .iter()
                        .enumerate()
                        .position(|(i, e)| {
                            !s.used[i]
                                && e.action == action
                                && e.target == target
                                && e.instruction_hash == instruction_hash
                                && amount.0 <= e.max_amount.0
                        })
                        .unwrap();
                    // Validate before changing any state, including entry usage and budget.
                    if pay && action == "transfer" {
                        assert!(target.parse::<AccountId>().is_ok(), "payout_unavailable: invalid recipient");
                        assert!(self.escrow >= amount.0, "payout_unavailable: insufficient escrow");
                    }
                    s.used[i] = true;
                    s.remaining -= amount.0;
                    s.blocks = 0;
                    s.last = None;
                } else if !s.frozen {
                    s.blocks += 1;
                    if s.blocks >= 3 || s.last.as_ref() == Some(&fingerprint) {
                        s.frozen = true;
                        code = "auto_frozen";
                    }
                    s.last = Some(fingerprint);
                }
                code
            }
        };
        // Tier 1 denials never construct or consult a judge. Non-transfer actions
        // retain the existing decision-only semantics: there is no escrow payment.
        if code == "allowed" && pay && action == "transfer" {
            let input = JudgeInput { serial, action:action.clone(), target:target.clone(),
                amount:amount.0, instruction_hash:instruction_hash.clone(), source:source.clone() };
            let default = DefaultJudge { amount_threshold:self.config.amount_threshold.0,
                new_payee_check:self.config.new_payee_check,
                trusted_sources:self.config.trusted_sources.clone(), known_payees:self.config.known_payees.clone(),
                denied_targets:self.config.denied_targets.clone() };
            let day = tier2::day_index(env::block_timestamp(), self.spend_rules.tz_offset_min);
            let (spent, count) = self.usage_with_pending(day, None);
            let request_hash = judge_request_hash(serial, &action, &target, amount, &instruction_hash, &source, &env::predecessor_account_id());
            let report_valid = judge_report.as_ref().map_or(false, |r| self.authenticated_report(r, &request_hash) && r.nonce > self.report_nonces.get(&format!("{}:{}",r.signer_public_key.as_ref().unwrap(),r.request_hash)).copied().unwrap_or(0));
            if report_valid { let r=judge_report.as_ref().unwrap(); self.report_nonces.insert(format!("{}:{}",r.signer_public_key.as_ref().unwrap(),r.request_hash), r.nonce); }
            let authenticated = judge_report.as_ref().filter(|_| report_valid);
            let untrusted = (judge_report.is_some() && !report_valid)
                || (!source.is_empty() && source != "owner_chat");
            let dual = tier2::evaluate(&self.spend_rules, &target, amount.0, &instruction_hash,
                authenticated, env::block_timestamp(), spent, count, true,
                default.judge(&input).tighten(Verdict::hint(judge_hint.as_deref()))
                    .tighten(if untrusted { Verdict::Escalate } else { Verdict::Pass }));
            let verdict = final_decision(true, dual.verdict);
            event("tier2_decision", near_sdk::serde_json::json!({"tier":2,"serial":serial,
                "lock":dual.lock,"reasons":dual.reasons,
                "report_authenticated":report_valid,
                "source_q_permille":authenticated.map(|r|r.source_q_permille),
                "category_q_permille":authenticated.map(|r|r.category_q_permille),
                "threshold":self.spend_rules.jev_threshold_permille,
                "mode":authenticated.map(|r|r.mode.as_str()).unwrap_or("none"),
                "verdict":verdict.as_str(),"target":target,"amount":amount,"source":source,
                "escrow_balance":U128(self.escrow)}));
            if verdict != Verdict::Pass {
                if verdict == Verdict::Escalate {
                    let created_at = env::block_timestamp();
                    let item = PendingItem { id:self.next_pending_id, serial, action:action.clone(),
                        target:target.clone(), amount, instruction_hash:instruction_hash.clone(), source,
                        predecessor:env::predecessor_account_id(), created_at, report:authenticated.cloned(),
                        deadline:created_at.checked_add(self.config.pending_ttl_ns).expect("deadline overflow").min(created_at.saturating_add(3_600_000_000_000)) };
                    self.next_pending_id = self.next_pending_id.checked_add(1).expect("pending id overflow");
                    self.escrow -= amount.0;
                    self.pending.insert(item.id, item.clone());
                    self.pending_event("pending_created", &item);
                }
                // Tier 1 entry and budget remain consumed even on tier 2 denial,
                // rejection or timeout. Only reserved escrow is restored.
                return self.emit(serial, if verdict == Verdict::Deny { "tier2_deny" } else { "tier2_escalate" }, action, target, amount, instruction_hash);
            }
            self.escrow -= amount.0;
            self.schedule_payout(serial, &target, amount);
        }
        self.record_block(underlying, &action, &target);
        self.emit(serial, code, action, target, amount, instruction_hash)
    }
}
impl Gate {
    fn valid_owner_signature(&self, bytes: &[u8], signature: Option<String>) -> bool {
        valid_signature(&self.owner, &authorization_bytes(&self.chain_id, &self.deployment_id, &self.owner, bytes), signature)
    }
    fn authenticated_report(&self, report: &JudgeReport, request_hash: &[u8]) -> bool {
        let Some(key) = report.signer_public_key.as_ref().and_then(|s|s.parse::<PublicKey>().ok()) else { return false; };
        self.judge_policy.keys.contains(&key) && report.key_generation == self.judge_policy.nonce
            && report.expires_at > env::block_timestamp() && report.nonce > 0
            && report.request_hash == hex_bytes(request_hash)
            && valid_signature(&key, &authorization_bytes(&self.chain_id, &self.deployment_id, &self.owner,
                &judge_report_bytes(&env::current_account_id(), report)), report.signature.clone())
    }
    // Outstanding reservations count on EVERY day until resolved, including after
    // midnight or a timezone policy change. Scheduling remains charged on failure.
    fn usage_with_pending(&self, day: i64, exclude: Option<u64>) -> (u128, u32) {
        let (mut amount, mut count) = self.daily.get(&day).copied().unwrap_or_default();
        for item in self.pending.values().filter(|p|Some(p.id)!=exclude) {
            amount = amount.saturating_add(item.amount.0);
            count = count.saturating_add(1);
        }
        (amount, count)
    }
    fn approval_allowed(&self, item: &PendingItem) -> bool {
        let Some(s) = self.mandates.get(&item.serial) else { return false; };
        if s.frozen || s.mandate.expires_at <= env::block_timestamp() || s.mandate.agent != item.predecessor
            || item.action != "transfer" || item.target.parse::<AccountId>().is_err()
            || self.config.denied_targets.contains(&item.target)
            || self.proposals.iter().any(|p|p.approved && p.action==item.action && p.target==item.target)
            || !s.mandate.entries.iter().enumerate().any(|(i,e)|s.used[i] && e.action==item.action
                && e.target==item.target && e.instruction_hash==item.instruction_hash && item.amount.0<=e.max_amount.0) {
            return false;
        }
        // Budget and entry were consumed atomically at reservation; never debit twice.
        // Tier 3 may resolve model uncertainty, never override current 2b rules.
        let day = tier2::day_index(env::block_timestamp(), self.spend_rules.tz_offset_min);
        let (spent,count) = self.usage_with_pending(day, Some(item.id));
        let mut rules = self.spend_rules.clone(); rules.jev_required=false;
        let mut report = item.report.clone();
        if let Some(r)=report.as_ref() {
            let hash=judge_request_hash(item.serial,&item.action,&item.target,item.amount,&item.instruction_hash,&item.source,&item.predecessor);
            if !self.authenticated_report(r,&hash) {
                event("pending_report_invalidated", near_sdk::serde_json::json!({"id":item.id}));
            }
        }
        // Owner signs the exact pending request and resolves model uncertainty.
        // Retained category is only a restriction checked against CURRENT rules;
        // stale evidence never authenticates a new request or bypasses a limit.
        if let Some(r) = report.as_mut() { r.source_label="owner_signed".into(); r.source_q_permille=1000; }
        if rules.enabled && !rules.allowed_categories.is_empty() && report.is_none() { return false; }
        tier2::evaluate(&rules, &item.target, item.amount.0, &item.instruction_hash, report.as_ref(),
            env::block_timestamp(), spent, count, true, Verdict::Pass).verdict == Verdict::Pass
    }
    fn schedule_payout(&mut self, serial: u64, target: &str, amount: U128) {
        let day = tier2::day_index(env::block_timestamp(), self.spend_rules.tz_offset_min);
        let counters = self.daily.entry(day).or_default();
        counters.0 = counters.0.saturating_add(amount.0);
        counters.1 = counters.1.saturating_add(1);
        let recipient: AccountId = target.parse().expect("validated recipient");
        let payout_id=self.next_payout_id;
        self.next_payout_id=self.next_payout_id.checked_add(1).expect("payout id overflow");
        self.payouts.insert(payout_id, (serial, recipient.clone(), amount));
        drop(Promise::new(recipient.clone()).transfer(NearToken::from_yoctonear(amount.0))
            .then(Self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(5))
                .with_unused_gas_weight(0).on_payout(payout_id, recipient.clone(), amount)));
        event("payout", near_sdk::serde_json::json!({"serial":serial,
            "recipient":recipient,"amount":amount,"escrow_balance":U128(self.escrow)}));
    }
    fn pending_event(&self, name: &str, item: &PendingItem) {
        event(name, near_sdk::serde_json::json!({"id":item.id,"serial":item.serial,
            "target":item.target,"amount":item.amount,"deadline":item.deadline,
            "decision_time":env::block_timestamp(),"escrow_balance":U128(self.escrow)}));
    }
    fn resolve_pending(&mut self, id: u64, approve: bool, signature: String) {
        let stored = self.pending.get(&id).expect("unknown or resolved pending");
        assert!(self.valid_owner_signature(
            &pending_decision_v2_bytes(&env::current_account_id(), id, approve, &pending_request_hash(stored)),
            Some(signature)), "invalid pending signature");
        let item = self.pending.remove(&id).expect("unknown or resolved pending");
        if env::block_timestamp() >= item.deadline {
            self.escrow += item.amount.0;
            self.pending_event("pending_expired", &item);
        } else if approve && self.approval_allowed(&item) {
            self.pending_event("pending_approved", &item);
            self.schedule_payout(item.serial, &item.target, item.amount);
        } else {
            self.escrow += item.amount.0;
            self.pending_event("pending_rejected", &item);
        }
    }
    fn record_block(&mut self, underlying: &str, action: &str, target: &str) {
        if !["allowed", "auto_frozen", "unknown_mandate"].contains(&underlying) {
            let count = self
                .causes
                .entry((underlying.into(), action.to_string(), target.to_string()))
                .or_default();
            *count += 1;
            if *count == 3 {
                let p = Proposal {
                    proposal_id: self.proposals.len() as u64 + 1,
                    reason_code: underlying.into(),
                    action: action.to_string(),
                    target: target.to_string(),
                    count: 3,
                    proposed_rule: "deny".into(),
                    policy_version: self.version,
                    approved: false,
                    revoked: false,
                };
                event("rule_proposal", &p);
                self.proposals.push(p);
            }
        }
    }
    fn emit(
        &mut self,
        serial: u64,
        code: &str,
        action: String,
        target: String,
        amount: U128,
        instruction_hash: String,
    ) -> Decision {
        let allow = code == "allowed";
        if !allow {
            *self.counters.entry(code.into()).or_default() += 1;
        }
        let d = Decision {
            serial,
            verdict: if allow { "allow" } else { "block" }.into(),
            reason_code: code.into(),
            reason: code.replace('_', " "),
            action,
            target,
            amount,
            instruction_hash,
            remaining_budget: U128(self.mandates.get(&serial).map_or(0, |s| s.remaining)),
        };
        env::log_str(&format!(
            "EVENT_JSON:{}",
            near_sdk::serde_json::json!({"standard":"chopgate","version":"1.0.0","event":"decision","data":[&d]})
        ));
        d
    }
}

/// ASCII domain plus Borsh(contract, amount U128, recipient AccountId, nonce u64).
pub fn withdrawal_bytes(contract: &AccountId, amount: U128, recipient: &AccountId, nonce: u64) -> Vec<u8> {
    let mut bytes = b"chopgate:escrow-withdraw:v1\0".to_vec();
    bytes.extend(near_sdk::borsh::to_vec(&(contract, amount, recipient, nonce)).unwrap());
    bytes
}

#[cfg(test)]
mod unit_tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use near_sdk::{testing_env, test_utils::{accounts, get_created_receipts, VMContextBuilder}};
    use near_sdk::mock::MockAction;
    use sha2::{Digest, Sha256};

    fn context(deposit: u128) {
        testing_env!(VMContextBuilder::new().current_account_id(accounts(0))
            .predecessor_account_id(accounts(1))
            .attached_deposit(NearToken::from_yoctonear(deposit)).build());
    }
    fn ready() -> Gate {
        context(0);
        let key = SigningKey::from_bytes(&[7; 32]);
        let pk: PublicKey = format!("ed25519:{}", bs58::encode(key.verifying_key().to_bytes()).into_string()).parse().unwrap();
        let mut gate = Gate::new(pk.clone(), "local-test".into(), "deployment-1".into());
        let w = Mandate { serial: 1, agent: accounts(1), entries: vec![Permission {
            action: "transfer".into(), target: accounts(2).to_string(), max_amount: U128(10),
            instruction_hash: hex::encode(env::sha256(b"invoice")),
        }], budget: U128(20), expires_at: u64::MAX, parent_serial: None };
        let signature = hex::encode(red2_sign(&key, &signing_bytes(&accounts(0), &w)).to_bytes());
        assert_eq!(gate.register(w, Some(format!("ed25519:{}", bs58::encode(&pk.as_bytes()[1..]).into_string())), Some(signature)).reason_code, "allowed");
        gate
    }
    fn request(g: &mut Gate, pay: bool, text: &str) -> Decision {
        g.authorize_inner(1, "transfer".into(), accounts(2).to_string(), U128(10), text.into(), pay)
    }
    #[test]
    fn signing_is_deterministic_and_domain_separated() {
        let g = ready();
        let w = &g.mandates[&1].mandate;
        assert_eq!(signing_bytes(&accounts(0), w), signing_bytes(&accounts(0), w));
        assert_ne!(signing_bytes(&accounts(0), w), signing_bytes(&accounts(1), w));
        assert_ne!(signing_bytes(&accounts(0), w), withdrawal_bytes(&accounts(0), U128(10), &accounts(2), 1));
    }
    #[test]
    fn unsigned_instruction_blocked() { let mut g=ready(); assert_eq!(request(&mut g,false,"hidden").reason_code,"unsigned_instruction"); }
    #[test]
    fn signed_zero_preserves_entry_and_budget() {
        let mut g = ready();
        assert_eq!(g.authorize_inner(1, "transfer".into(), accounts(2).to_string(),
            U128(0), "invoice".into(), true).reason_code, "zero_amount");
        assert!(!g.mandates[&1].used[0]);
        assert_eq!(g.remaining_budget(1).unwrap().0, 20);
        assert!(get_created_receipts().is_empty());
        assert_eq!(request(&mut g, false, "invoice").reason_code, "allowed");
        assert_eq!(g.remaining_budget(1).unwrap().0, 10);
    }
    #[test]
    fn allowed_entry_debits_budget() { let mut g=ready(); request(&mut g,false,"invoice"); assert_eq!(g.remaining_budget(1).unwrap().0,10); }
    #[test]
    fn single_use_entry() { let mut g=ready(); request(&mut g,false,"invoice"); assert_eq!(request(&mut g,false,"invoice").reason_code,"instruction_reused"); }
    #[test]
    fn deposit_increases_escrow() { let mut g=ready(); context(30); g.deposit(); assert_eq!(g.escrow_balance().0,30); }
    #[test]
    fn payment_creates_exact_transfer() {
        let mut g=ready(); context(30); g.deposit(); context(0);
        assert_eq!(request(&mut g,true,"invoice").reason_code,"allowed");
        let receipts=get_created_receipts(); assert_eq!(receipts.len(),2);
        assert_eq!(receipts[0].receiver_id,accounts(2)); assert_eq!(receipts[0].actions.len(),1);
        assert!(matches!(&receipts[0].actions[0], MockAction::Transfer { deposit, .. } if deposit.as_yoctonear()==10));
        assert_eq!(receipts[1].receiver_id,env::current_account_id());
        assert_eq!(receipts[1].actions.len(),1);
        assert!(matches!(&receipts[1].actions[0], MockAction::FunctionCallWeight { method_name, .. } if method_name == b"on_payout"));
        assert_eq!(g.escrow,20);
    }
    #[test]
    fn blocked_payment_has_no_receipts() { let mut g=ready(); g.escrow=30; request(&mut g,true,"hidden"); assert!(get_created_receipts().is_empty()); assert_eq!(g.escrow,30); }
    #[test]
    fn insufficient_escrow_preserves_budget() {
        let mut g=ready();
        let err=std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| request(&mut g,true,"invoice"))).err().expect("must panic");
        let message=err.downcast_ref::<&str>().copied().or_else(||err.downcast_ref::<String>().map(String::as_str)).unwrap();
        assert!(message.starts_with("payout_unavailable"));
        assert_eq!(g.remaining_budget(1).unwrap().0,20); assert!(!g.mandates[&1].used[0]); assert_eq!(g.escrow,0);
    }
    #[test]
    fn plain_authorize_has_no_receipts() { let mut g=ready(); assert_eq!(g.authorize(1,"transfer".into(),accounts(2).to_string(),U128(10),"invoice".into()).reason_code,"allowed"); assert!(get_created_receipts().is_empty()); }
    #[test]
    fn rules_apply_to_every_payment_path() {
        for path in 0..3 {
            let mut g=ready(); g.escrow=30;
            g.spend_rules=SpendRules { enabled:true, ..SpendRules::default() };
            let d=match path {
                0=>g.authorize_and_pay(1,"transfer".into(),accounts(2).to_string(),U128(10),"invoice".into()),
                1=>g.authorize_and_pay_tiered(1,"transfer".into(),accounts(2).to_string(),U128(10),"invoice".into(),"owner_chat".into(),None),
                _=>g.authorize_and_pay_dual(1,"transfer".into(),accounts(2).to_string(),U128(10),"invoice".into(),"owner_chat".into(),None,None),
            };
            assert_eq!(d.reason_code,"tier2_deny"); assert_eq!(g.escrow,30);
            assert!(get_created_receipts().is_empty()); assert!(g.mandates[&1].used[0]);
        }
    }
    #[test]
    fn pending_v2_payload_binds_execution_content() {
        let mut g=ready();g.escrow=30;g.config.amount_threshold=U128(0);
        request(&mut g,true,"invoice");let item=&g.pending[&1];
        let fields=near_sdk::borsh::to_vec(&(&item.action,&item.target,item.amount,item.serial,&item.instruction_hash)).unwrap();
        assert_eq!(pending_request_hash(item),Sha256::digest(&fields).to_vec());
        let hash=pending_request_hash(item);
        let bytes=pending_decision_v2_bytes(&accounts(0),1,true,&hash);
        let mut expected=b"chopgate:pending-decision:v2\0".to_vec();
        expected.extend(near_sdk::borsh::to_vec(&(accounts(0),1u64,true,hash)).unwrap());
        assert_eq!(bytes,expected);
        let mut legacy=b"chopgate:pending-decision:v1\0".to_vec();
        legacy.extend(near_sdk::borsh::to_vec(&(accounts(0),1u64,true)).unwrap());
        assert_eq!(pending_decision_bytes(&accounts(0),1,true),legacy);
        for field in 0..5 {
            let mut changed=item.clone();match field {
                0=>changed.action="other".into(),1=>changed.target=accounts(3).to_string(),
                2=>changed.amount=U128(11),3=>changed.serial=2,_=>changed.instruction_hash="other".into(),
            }
            assert_ne!(pending_request_hash(&changed),pending_request_hash(item));
        }
    }
    #[test]
    fn daily_accounting_includes_pending_reservations() {
        let mut g=ready();g.escrow=30;
        g.config.amount_threshold=U128(0);
        assert_eq!(request(&mut g,true,"invoice").reason_code,"tier2_escalate");
        assert_eq!(g.usage_with_pending(tier2::day_index(env::block_timestamp(),0),None),(10,1));
        let key=SigningKey::from_bytes(&[7;32]);
        let sig=hex::encode(red2_sign(&key, &pending_decision_v2_bytes(&accounts(0),1,true,&pending_request_hash(&g.pending[&1]))).to_bytes());
        g.approve_pending(1,sig);
        let day=tier2::day_index(env::block_timestamp(),0);
        assert_eq!(g.daily[&day],(10,1)); assert_eq!(g.escrow,20);
        let mut g=ready();g.escrow=30;request(&mut g,true,"invoice");
        assert_eq!(g.daily[&day],(10,1));
    }

}

#[cfg(test)]
// Offline fixture domain; production signers must query signature_domain.
fn red2_sign(key: &ed25519_dalek::SigningKey, payload: &[u8]) -> ed25519_dalek::Signature {
    use ed25519_dalek::Signer;
    let owner: near_sdk::PublicKey = format!("ed25519:{}", bs58::encode(key.verifying_key().to_bytes()).into_string()).parse().unwrap();
    key.sign(&crate::authorization_bytes("local-test", "deployment-1:0", &owner, payload))
}
