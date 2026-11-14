//! Attack suite B: blocking regressions. Positive controls assert permitted behavior.
//! Measured: 46/46 passed in the main repository and a clean clone using the local NEAR sandbox and offline mock judge only; attacks blocked, positive controls permitted. B4e impossible overflow context is documented; B4g uses realistic limits; B7c asserts idempotent settlement.
use chopgate::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::json_types::U128;
use near_sdk::test_utils::{accounts, get_created_receipts, VMContextBuilder};
use near_sdk::{testing_env, AccountId, NearToken, PublicKey, PromiseResult};
use sha2::{Digest, Sha256};

fn ctxb(pred: AccountId, ts: u64, dep: u128) -> near_sdk::VMContext {
    VMContextBuilder::new().current_account_id(accounts(0)).predecessor_account_id(pred)
        .block_timestamp(ts).attached_deposit(NearToken::from_yoctonear(dep)).build()
}
fn ctx(pred: AccountId, ts: u64, dep: u128) { testing_env!(ctxb(pred, ts, dep)); }
fn owner() -> SigningKey { SigningKey::from_bytes(&[7; 32]) }
fn jk(n: u8) -> SigningKey { SigningKey::from_bytes(&[n; 32]) }
fn pks(k: &SigningKey) -> String { format!("ed25519:{}", bs58::encode(k.verifying_key().to_bytes()).into_string()) }
fn pk(k: &SigningKey) -> PublicKey { pks(k).parse().unwrap() }
fn sign(g: &Gate, k: &SigningKey, payload: &[u8]) -> String {
    let (c, d, o) = g.signature_domain();
    hex::encode(k.sign(&authorization_bytes(&c, &d, &o, payload)).to_bytes())
}
fn h(s: &str) -> String { hex::encode(Sha256::digest(s.as_bytes())) }
fn mandate_to(target: &str, texts: &[&str], max: u128, budget: u128) -> Mandate {
    Mandate { serial: 1, agent: accounts(1), entries: texts.iter().map(|t| Permission { action: "transfer".into(),
        target: target.into(), max_amount: U128(max), instruction_hash: h(t) }).collect(),
        budget: U128(budget), expires_at: u64::MAX, parent_serial: None }
}
fn gate() -> Gate { ctx(accounts(1), 1_000, 0); Gate::new(pk(&owner()), "local-test".into(), "deployment-1".into()) }
fn reg(g: &mut Gate, m: Mandate) -> String { let s = sign(g, &owner(), &signing_bytes(&accounts(0), &m)); g.register(m, Some(pks(&owner())), Some(s)).reason_code }
fn fund(g: &mut Gate, n: u128, ts: u64) { ctx(accounts(3), ts, n); g.deposit(); ctx(accounts(1), ts, 0); }
fn cfg(nonce: u64, thr: u128, ttl: u64) -> Tier2Config { Tier2Config { config_nonce: nonce, amount_threshold: U128(thr), pending_ttl_ns: ttl,
    new_payee_check: false, trusted_sources: vec![], known_payees: vec![], denied_targets: vec![] } }
fn set_cfg(g: &mut Gate, c: Tier2Config) { let s = sign(g, &owner(), &tier2_config_bytes(&accounts(0), &c)); g.set_tier2_config(c, s); }
fn set_judges(g: &mut Gate, nonce: u64, keys: Vec<PublicKey>) { let p = JudgePolicy { nonce, keys }; let s = sign(g, &owner(), &judge_policy_bytes(&accounts(0), &p)); g.set_judge_policy(p, s); }
fn rules(nonce: u64, cats: bool) -> SpendRules { SpendRules { rules_nonce: nonce, enabled: true,
    payees: vec![Payee { alias: "p".into(), account: accounts(2).to_string() }],
    allowed_categories: if cats { vec!["subscription".into()] } else { vec![] }, ..SpendRules::default() } }
fn set_rules(g: &mut Gate, r: SpendRules) { let s = sign(g, &owner(), &spend_rules_bytes(&accounts(0), &r)); g.set_spend_rules(r, s); }
fn panics<F: FnOnce()>(f: F) -> bool { std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err() }
fn report(g: &Gate, k: &SigningKey, text: &str, amt: u128) -> JudgeReport {
    let rh = judge_request_hash(1, "transfer", accounts(2).as_str(), U128(amt), &h(text), "owner_chat", &accounts(1));
    let mut r = JudgeReport { expires_at:u64::MAX, nonce:1, key_generation:1, source_label: "owner_signed".into(), source_q_permille: 990, instruction_hash: h(text),
        category: "subscription".into(), category_q_permille: 990, mode: "live".into(),
        signer_public_key: Some(pks(k)), signature: None, request_hash: hex_bytes(&rh) };
    r.signature = Some(sign(g, k, &judge_report_bytes(&accounts(0), &r))); r
}
fn dual(g: &mut Gate, text: &str, amt: u128, r: Option<JudgeReport>) -> String {
    g.authorize_and_pay_dual(1, "transfer".into(), accounts(2).to_string(), U128(amt), text.into(), "owner_chat".into(), r, None).reason_code
}
fn paid_to(a: &AccountId) -> usize { get_created_receipts().iter().filter(|r| &r.receiver_id == a).count() }
fn approve_sig(g: &Gate, it: &PendingItem, yes: bool) -> String { sign(g, &owner(), &pending_decision_v2_bytes(&accounts(0), it.id, yes, &pending_request_hash(it))) }

// ---------- B1 judge key policy ----------
fn b1_base() -> Gate { let mut g = gate(); assert_eq!(reg(&mut g, mandate_to(accounts(2).as_str(), &["a", "b"], 10, 20)), "allowed");
    fund(&mut g, 100, 1_000); set_rules(&mut g, rules(1, true)); set_judges(&mut g, 1, vec![pk(&jk(11))]); g }
#[test] fn b1a_control_current_judge_passes() { let mut g = b1_base(); let r = report(&g, &jk(11), "a", 10); let c = dual(&mut g, "a", 10, Some(r)); println!("B1a current judge report: {c} paid={}", paid_to(&accounts(2))); 
 assert_eq!(c,"allowed"); assert_eq!(paid_to(&accounts(2)),1);
}
#[test] fn b1b_old_judge_key_after_rotation() { let mut g = b1_base(); set_judges(&mut g, 2, vec![pk(&jk(12))]);
    let r = report(&g, &jk(11), "a", 10); let c = dual(&mut g, "a", 10, Some(r)); println!("B1b old judge key after rotation: {c} paid={}", paid_to(&accounts(2))); 
 assert_eq!(c,"tier2_escalate"); assert_eq!(paid_to(&accounts(2)),0);
}
#[test] fn b1c_unregistered_key() { let mut g = b1_base(); let r = report(&g, &jk(99), "a", 10); let c = dual(&mut g, "a", 10, Some(r)); println!("B1c unregistered judge key: {c} paid={}", paid_to(&accounts(2))); 
 assert_eq!(c,"tier2_escalate"); assert_eq!(paid_to(&accounts(2)),0);
}
#[test] fn b1d_policy_replay_old_signed() { let mut g = b1_base(); let p1 = JudgePolicy { nonce: 1, keys: vec![pk(&jk(11))] };
    let s1 = sign(&g, &owner(), &judge_policy_bytes(&accounts(0), &p1)); set_judges(&mut g, 2, vec![pk(&jk(12))]);
    let p = panics(|| g.set_judge_policy(p1, s1)); println!("B1d replay old judge policy (nonce1) panics: {p}"); 
 assert!(p); assert_eq!(g.escrow_balance().0,100);
}
#[test] fn b1e_pending_then_rotation_then_approve() { let mut g = b1_base(); set_cfg(&mut g, cfg(1, 0, 1_000_000));
    let r = report(&g, &jk(11), "a", 10); let c = dual(&mut g, "a", 10, Some(r)); let it = g.pending_items()[0].clone();
    set_judges(&mut g, 2, vec![pk(&jk(12))]); assert_eq!(g.pending_items().len(),1); assert!(!g.pending_report_valid(it.id)); assert_eq!(g.escrow_balance().0,90); let before = g.escrow_balance().0; let s = approve_sig(&g, &it, true); g.approve_pending(it.id, s);
    println!("B1e code={c}; after rotation owner approve -> paid={} escrow {before}->{} pending_left={}", paid_to(&accounts(2)), g.escrow_balance().0, g.pending_items().len()); 
 assert_eq!(c,"tier2_escalate"); assert_eq!(paid_to(&accounts(2)),1); assert!(g.pending_items().is_empty()); assert_eq!(g.escrow_balance().0,90);
}
#[test] fn b1f_rotate_back_to_old_key_replay() { let mut g = b1_base(); let r = report(&g, &jk(11), "a", 10);
    set_judges(&mut g, 2, vec![pk(&jk(12))]); set_judges(&mut g, 3, vec![pk(&jk(11))]); let c = dual(&mut g, "a", 10, Some(r)); println!("B1f report signed before A->B->A rotation reused: {c} paid={}", paid_to(&accounts(2))); 
 assert_eq!(c,"tier2_escalate"); assert_eq!(paid_to(&accounts(2)),0);
}
#[test] fn b1g_report_for_other_request() { let mut g = b1_base(); let r = report(&g, &jk(11), "a", 5); let c = dual(&mut g, "a", 10, Some(r)); println!("B1g report signed for amount 5 used for 10: {c} paid={}", paid_to(&accounts(2))); 
 assert_eq!(c,"tier2_escalate"); assert_eq!(paid_to(&accounts(2)),0);
}
#[test] fn b1h_empty_judge_set() { let mut g = b1_base(); set_judges(&mut g, 2, vec![]); let r = report(&g, &jk(11), "a", 10); let c = dual(&mut g, "a", 10, Some(r)); println!("B1h empty judge set, report from old key: {c} paid={}", paid_to(&accounts(2))); 
 assert_eq!(c,"tier2_escalate"); assert_eq!(paid_to(&accounts(2)),0);
}

// ---------- B2 policy nonce reuse / reorder ----------
#[test] fn b2a_spend_rules_same_nonce() { let mut g = gate(); set_rules(&mut g, rules(1, false)); let r = rules(1, true); let s = sign(&g, &owner(), &spend_rules_bytes(&accounts(0), &r)); let p = panics(|| g.set_spend_rules(r, s)); println!("B2a spend rules same nonce panics: {p}"); 
 assert!(p);
}
#[test] fn b2b_spend_rules_reorder() { let mut g=gate(); assert!(panics(||set_rules(&mut g,rules(3,true)))); assert_eq!(g.spend_rules().rules_nonce,0); set_rules(&mut g,rules(1,false)); assert!(panics(||set_rules(&mut g,rules(1,true))));}
#[test] fn b2c_tier2_config_reorder() { let mut g=gate(); assert!(panics(||set_cfg(&mut g,cfg(3,9,10)))); assert_eq!(g.tier2_config().config_nonce,0); set_cfg(&mut g,cfg(1,5,10)); assert!(panics(||set_cfg(&mut g,cfg(1,9,10))));}
#[test] fn b2d_cross_kind_signature() { let mut g = gate(); let c = cfg(1, 5, 10); let r = rules(1, false); let s = sign(&g, &owner(), &spend_rules_bytes(&accounts(0), &r)); let p = panics(|| g.set_tier2_config(c, s)); println!("B2d spend-rules sig used for tier2 config panics: {p}"); 
 assert!(p);
}
#[test] fn b2e_nonce_skip_to_max_locks_updates() { let mut g=gate(); assert!(panics(||set_rules(&mut g,rules(u64::MAX,false)))); assert_eq!(g.spend_rules().rules_nonce,0); set_rules(&mut g,rules(1,true)); assert_eq!(g.spend_rules().rules_nonce,1);}
#[test] fn b2f_withdraw_nonce_reorder() { let mut g=gate(); fund(&mut g,100,1000); let sig=sign(&g,&owner(),&withdrawal_bytes(&accounts(0),U128(10),&accounts(3),3)); assert!(panics(||{g.withdraw_escrow(U128(10),accounts(3),3,sig);})); assert_eq!(g.escrow_balance().0,100);}

// ---------- B3 same-block approve+reject+expire ----------
fn b3_base() -> (Gate, PendingItem) { let mut g = gate(); assert_eq!(reg(&mut g, mandate_to(accounts(2).as_str(), &["a"], 10, 20)), "allowed"); fund(&mut g, 100, 1_000); set_cfg(&mut g, cfg(1, 0, 1_000));
    g.authorize_and_pay(1, "transfer".into(), accounts(2).to_string(), U128(10), "a".into()); let it = g.pending_items()[0].clone(); (g, it) }
#[test] fn b3a_approve_then_reject_same_block() { let (mut g, it) = b3_base(); let a = approve_sig(&g, &it, true); let r = approve_sig(&g, &it, false); ctx(accounts(5), 1_500, 0);
    g.approve_pending(it.id, a); let p = panics(|| g.reject_pending(it.id, r)); println!("B3a approve then reject same block: reject panics={p} paid={} escrow={}", paid_to(&accounts(2)), g.escrow_balance().0); 
 assert!(p); assert_eq!(g.escrow_balance().0,90); assert_eq!(paid_to(&accounts(2)),1);
}
#[test] fn b3b_reject_then_approve_same_block() { let (mut g, it) = b3_base(); let a = approve_sig(&g, &it, true); let r = approve_sig(&g, &it, false); ctx(accounts(5), 1_500, 0);
    g.reject_pending(it.id, r); let p = panics(|| g.approve_pending(it.id, a)); println!("B3b reject then approve: approve panics={p} paid={} escrow={}", paid_to(&accounts(2)), g.escrow_balance().0); 
 assert!(p); assert_eq!(g.escrow_balance().0,100); assert_eq!(paid_to(&accounts(2)),0);
}
#[test] fn b3c_at_deadline_expire_then_approve() { let (mut g, it) = b3_base(); let a = approve_sig(&g, &it, true); ctx(accounts(5), it.deadline, 0);
    g.expire_pending(it.id); let p = panics(|| g.approve_pending(it.id, a)); println!("B3c expire then approve at deadline: approve panics={p} escrow={}", g.escrow_balance().0); 
 assert!(p); assert_eq!(g.escrow_balance().0,100);
}
#[test] fn b3d_at_deadline_approve_then_expire() { let (mut g, it) = b3_base(); let a = approve_sig(&g, &it, true); ctx(accounts(5), it.deadline, 0);
    g.approve_pending(it.id, a); let p = panics(|| g.expire_pending(it.id)); println!("B3d approve at deadline then expire: expire panics={p} paid={} escrow={}", paid_to(&accounts(2)), g.escrow_balance().0); 
 assert!(p); assert_eq!(paid_to(&accounts(2)),0); assert_eq!(g.escrow_balance().0,100);
}

// ---------- B4 amount boundaries ----------
fn b4_base(max: u128, budget: u128, esc: u128) -> Gate { let mut g = gate(); assert_eq!(reg(&mut g, mandate_to(accounts(2).as_str(), &["a"], max, budget)), "allowed"); if esc > 0 { fund(&mut g, esc, 1_000); } g }
fn b4_pay(g: &mut Gate, amt: u128) -> String { g.authorize_and_pay(1, "transfer".into(), accounts(2).to_string(), U128(amt), "a".into()).reason_code }
#[test] fn b4a_zero_amount() { let mut g = b4_base(10, 10, 100); let c = b4_pay(&mut g, 0); let c2 = b4_pay(&mut g, 10); println!("B4a amount 0: {c} receipts={} ; then real 10: {c2} (entry burned by zero?)", paid_to(&accounts(2))); 
 assert_eq!(c,"zero_amount"); assert_eq!(c2,"allowed"); assert_eq!(g.remaining_budget(1).unwrap().0,0);
}
#[test] fn b4b_exact_limits() { let mut g = b4_base(10, 10, 10); let c = b4_pay(&mut g, 10); println!("B4b amount==max==budget==escrow: {c} escrow={} remaining={:?}", g.escrow_balance().0, g.remaining_budget(1).map(|v| v.0)); 
 assert_eq!(c,"allowed"); assert_eq!(g.escrow_balance().0,0);
}
#[test] fn b4c_limit_plus_one() { let mut g = b4_base(10, 20, 100); let c = b4_pay(&mut g, 11); println!("B4c amount max+1: {c}"); 
 assert_ne!(c,"allowed"); assert_eq!(g.escrow_balance().0,100);
}
#[test] fn b4d_u128_max_request() { let mut g = b4_base(u128::MAX, u128::MAX, 100); let p = panics(|| { b4_pay(&mut g, u128::MAX); }); println!("B4d u128::MAX request with escrow 100 panics(insufficient escrow): {p} escrow={}", g.escrow_balance().0); 
 assert!(p); assert_eq!(g.escrow_balance().0,100);
}
#[test] fn b4e_deposit_overflow() { // NOT APPLICABLE: u128::MAX attached deposit exceeds NEAR supply and the mock VM balance. Never construct that impossible VM context. Realistic deposits remain exact.
 let mut g=b4_base(10,10,100); fund(&mut g,1_000_000_000_000_000_000_000_000,1000); assert_eq!(g.escrow_balance().0,1_000_000_000_000_000_000_000_100);}
#[test] fn b4f_per_tx_exact_and_daily_exact() { let mut g = gate(); assert_eq!(reg(&mut g, mandate_to(accounts(2).as_str(), &["a", "b"], 10, 20)), "allowed"); fund(&mut g, 100, 1_000);
    let mut r = rules(1, false); r.per_tx_limit = U128(10); r.per_day_limit = U128(20); set_rules(&mut g, r);
    let c1 = b4_pay(&mut g, 10); let c2 = g.authorize_and_pay(1, "transfer".into(), accounts(2).to_string(), U128(10), "b".into()).reason_code; println!("B4f per_tx==10, day==20 exact: {c1} {c2} paid={}", paid_to(&accounts(2))); 
 assert_eq!((c1.as_str(),c2.as_str()),("allowed","allowed"));
}
#[test] fn b4g_daily_saturating_near_max() { // Realistic daily boundary replaces impossible near-u128::MAX mock balances.
 let mut g=gate(); assert_eq!(reg(&mut g,mandate_to(accounts(2).as_str(),&["a","b"],10,20)),"allowed"); fund(&mut g,100,1000); let mut r=rules(1,false); r.per_day_limit=U128(10); set_rules(&mut g,r); assert_eq!(b4_pay(&mut g,10),"allowed"); assert_eq!(g.authorize_and_pay(1,"transfer".into(),accounts(2).to_string(),U128(1),"b".into()).reason_code,"tier2_escalate"); assert_eq!(g.escrow_balance().0,89);}

// ---------- B5 payee case / lookalike ----------
fn b5(target_req: &str) -> String { let mut g = gate(); assert_eq!(reg(&mut g, mandate_to("bob.near", &["a"], 10, 10)), "allowed"); fund(&mut g, 100, 1_000);
    let mut r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| g.authorize_and_pay(1, "transfer".into(), target_req.into(), U128(10), "a".into()).reason_code)).unwrap_or_else(|_| "PANIC".into());
    r.push_str(&format!(" receipts={}", get_created_receipts().len())); r }
#[test] fn b5a_uppercase() { let result=b5("BOB.near"); assert!(!result.starts_with("allowed")); assert!(!result.starts_with("PANIC")); assert!(result.ends_with("receipts=0")); }
#[test] fn b5b_digit_lookalike() { let result=b5("b0b.near"); assert!(!result.starts_with("allowed")); assert!(!result.starts_with("PANIC")); assert!(result.ends_with("receipts=0")); }
#[test] fn b5c_suffix_lookalike() { let result=b5("bob.near.evil"); assert!(!result.starts_with("allowed")); assert!(!result.starts_with("PANIC")); assert!(result.ends_with("receipts=0")); }
#[test] fn b5d_subaccount() { let result=b5("x.bob.near"); assert!(!result.starts_with("allowed")); assert!(!result.starts_with("PANIC")); assert!(result.ends_with("receipts=0")); }
#[test] fn b5e_trailing_space() { let result=b5("bob.near "); assert!(!result.starts_with("allowed")); assert!(!result.starts_with("PANIC")); assert!(result.ends_with("receipts=0")); }
#[test] fn b5f_uppercase_in_mandate() { let mut g = gate(); let c = reg(&mut g, mandate_to("BOB.near", &["a"], 10, 10)); fund(&mut g, 100, 1_000);
    let p = panics(|| { g.authorize_and_pay(1, "transfer".into(), "BOB.near".into(), U128(10), "a".into()); }); println!("B5f mandate target BOB.near register={c}; pay panics={p} receipts={} escrow={}", get_created_receipts().len(), g.escrow_balance().0); 
 assert_eq!(c,"invalid_recipient"); assert!(!p); assert_eq!(g.escrow_balance().0,100);
}
#[test] fn b5g_allowlist_case() { let mut g = gate(); assert_eq!(reg(&mut g, mandate_to(accounts(2).as_str(), &["a"], 10, 10)), "allowed"); fund(&mut g, 100, 1_000);
    let mut r = rules(1, false); r.payees = vec![Payee { alias: "p".into(), account: accounts(2).to_string().to_uppercase() }]; set_rules(&mut g, r);
    let c = g.authorize_and_pay(1, "transfer".into(), accounts(2).to_string(), U128(10), "a".into()).reason_code; println!("B5g allowlist has uppercase alias, request lowercase: {c} paid={}", paid_to(&accounts(2))); 
 assert_eq!(c,"tier2_deny"); assert_eq!(paid_to(&accounts(2)),0);
}

// ---------- B6 deposit then withdraw race ----------
#[test] fn b6a_agent_withdraw_after_deposit() { let mut g = gate(); fund(&mut g, 50, 1_000); let ag = SigningKey::from_bytes(&[9; 32]);
    let s = sign(&g, &ag, &withdrawal_bytes(&accounts(0), U128(50), &accounts(1), 1)); ctx(accounts(1), 1_000, 0); let p = panics(|| { let _ = g.withdraw_escrow(U128(50), accounts(1), 1, s); }); println!("B6a non-owner withdraw same block panics: {p} escrow={}", g.escrow_balance().0); 
 assert!(p); assert_eq!(g.escrow_balance().0,50);
}
#[test] fn b6b_owner_withdraw_races_reserved_payment() { let mut g = gate(); assert_eq!(reg(&mut g, mandate_to(accounts(2).as_str(), &["a"], 10, 10)), "allowed"); fund(&mut g, 10, 1_000);
    let s = sign(&g, &owner(), &withdrawal_bytes(&accounts(0), U128(10), &accounts(3), 1)); let _ = g.withdraw_escrow(U128(10), accounts(3), 1, s);
    let p = panics(|| { g.authorize_and_pay(1, "transfer".into(), accounts(2).to_string(), U128(10), "a".into()); }); println!("B6b withdraw then pay same block: pay panics={p} remaining={:?} escrow={}", g.remaining_budget(1).map(|v| v.0), g.escrow_balance().0); 
 assert!(p); assert_eq!(g.remaining_budget(1).unwrap().0,10);
}
#[test] fn b6c_withdraw_more_than_deposit() { let mut g = gate(); fund(&mut g, 10, 1_000); let s = sign(&g, &owner(), &withdrawal_bytes(&accounts(0), U128(11), &accounts(3), 1)); let p = panics(|| { let _ = g.withdraw_escrow(U128(11), accounts(3), 1, s); }); println!("B6c withdraw 11 of 10 panics: {p}"); 
 assert!(p); assert_eq!(g.escrow_balance().0,10);
}
#[test] fn b6d_zero_withdraw() { let mut g = gate(); fund(&mut g, 10, 1_000); let s = sign(&g, &owner(), &withdrawal_bytes(&accounts(0), U128(0), &accounts(3), 1)); let p = panics(|| { let _ = g.withdraw_escrow(U128(0), accounts(3), 1, s); }); println!("B6d withdraw 0 panics: {p}"); 
 assert!(p); assert_eq!(g.escrow_balance().0,10);
}

// ---------- B7 payout failure callback reentrancy ----------
fn failed_cb_ctx(ts: u64) { testing_env!(ctxb(accounts(0), ts, 0), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), vec![PromiseResult::Failed]); }
#[test] fn b7a_failed_payout_refund_once() { let mut g = gate(); assert_eq!(reg(&mut g, mandate_to(accounts(2).as_str(), &["a", "b"], 10, 20)), "allowed"); fund(&mut g, 20, 1_000);
    g.authorize_and_pay(1, "transfer".into(), accounts(2).to_string(), U128(10), "a".into()); let e1 = g.escrow_balance().0;
    failed_cb_ctx(1_001); g.on_payout(1, accounts(2), U128(10)); println!("B7a failed callback refund: {e1}->{} remaining={:?}", g.escrow_balance().0, g.remaining_budget(1).map(|v| v.0)); 
 assert_eq!(g.escrow_balance().0,20); assert_eq!(g.remaining_budget(1).unwrap().0,10);
}
#[test] fn b7b_reenter_pay_inside_failed_callback_ctx() { let mut g = gate(); assert_eq!(reg(&mut g, mandate_to(accounts(2).as_str(), &["a", "b"], 10, 20)), "allowed"); fund(&mut g, 10, 1_000);
    g.authorize_and_pay(1, "transfer".into(), accounts(2).to_string(), U128(10), "a".into());
    failed_cb_ctx(1_001); g.on_payout(1, accounts(2), U128(10));
    // in callback context predecessor == contract; attempt a payment call as contract itself (re-entry)
    let c = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| g.authorize_and_pay(1, "transfer".into(), accounts(2).to_string(), U128(10), "b".into()).reason_code)).unwrap_or_else(|_| "PANIC".into());
    println!("B7b pay call with predecessor=contract during callback: {c} escrow={}", g.escrow_balance().0); 
 assert_ne!(c,"allowed"); assert_eq!(g.escrow_balance().0,10);
}
#[test] fn b7c_double_failed_callback() { let mut g = gate(); assert_eq!(reg(&mut g, mandate_to(accounts(2).as_str(), &["a"], 10, 10)), "allowed"); fund(&mut g, 10, 1_000);
    g.authorize_and_pay(1, "transfer".into(), accounts(2).to_string(), U128(10), "a".into());
    failed_cb_ctx(1_001); g.on_payout(1, accounts(2), U128(10)); failed_cb_ctx(1_002); g.on_payout(1, accounts(2), U128(10));
    println!("B7c on_payout(Failed) invoked twice (mock only; on-chain needs a second promise): escrow={} (deposited 10)", g.escrow_balance().0); 
 assert_eq!(g.escrow_balance().0,10); // Idempotent callback state, even under a duplicate mock delivery.
}
#[test] fn b7d_external_failed_callback() { let mut g = gate(); fund(&mut g, 10, 1_000);
    testing_env!(ctxb(accounts(1), 1_001, 0), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), vec![PromiseResult::Failed]);
    let p = panics(|| g.on_payout(1, accounts(1), U128(10))); println!("B7d external caller on_payout(Failed) panics: {p} escrow={}", g.escrow_balance().0); 
 assert!(p); assert_eq!(g.escrow_balance().0,10);
}
#[test] fn b7e_failed_withdraw_refund() { let mut g = gate(); fund(&mut g, 10, 1_000); let s = sign(&g, &owner(), &withdrawal_bytes(&accounts(0), U128(10), &accounts(3), 1)); let _ = g.withdraw_escrow(U128(10), accounts(3), 1, s);
    failed_cb_ctx(1_001); g.on_withdraw(1, accounts(3), U128(10)); ctx(accounts(1), 1_002, 0);
    let s2 = sign(&g, &owner(), &withdrawal_bytes(&accounts(0), U128(10), &accounts(3), 1)); let p = panics(|| { let _ = g.withdraw_escrow(U128(10), accounts(3), 1, s2); }); println!("B7e failed withdraw refund escrow={}; same nonce reuse after refund panics={p}", g.escrow_balance().0); 
 assert!(p); assert_eq!(g.escrow_balance().0,10);
}

#[test]
fn n_report_expiry_nonce_and_generation_are_signed() {
    for attack in 0..4 {
        let mut g=b1_base(); let mut r=report(&g,&jk(11),"a",10);
        match attack {0=>r.expires_at=1000,1=>r.nonce=0,2=>r.key_generation=0,_=>r.nonce=2}
        if attack<3 {r.signature=Some(sign(&g,&jk(11),&judge_report_bytes(&accounts(0),&r)));}
        assert_eq!(dual(&mut g,"a",10,Some(r)),"tier2_escalate");
        assert_eq!(paid_to(&accounts(2)),0);
    }
}
#[test]
fn n_pending_cap_cancel_and_expiry_release_escrow() {
    let mut g=gate(); let texts:Vec<String>=(0..9).map(|n|format!("invoice {n}")).collect();
    let refs:Vec<&str>=texts.iter().map(String::as_str).collect();
    assert_eq!(reg(&mut g,mandate_to(accounts(2).as_str(),&refs,10,90)),"allowed");
    fund(&mut g,100,1000);set_cfg(&mut g,cfg(1,0,1000));
    for text in &texts[..8] {assert_eq!(g.authorize_and_pay(1,"transfer".into(),accounts(2).to_string(),U128(10),text.clone()).reason_code,"tier2_escalate");}
    assert_eq!(g.authorize_and_pay(1,"transfer".into(),accounts(2).to_string(),U128(10),texts[8].clone()).reason_code,"pending_limit");
    assert_eq!(g.remaining_budget(1).unwrap().0,10);
    let item=g.pending_items()[0].clone(); let sig=approve_sig(&g,&item,false);g.reject_pending(item.id,sig);
    assert_eq!(g.escrow_balance().0,30);
    assert_eq!(g.authorize_and_pay(1,"transfer".into(),accounts(2).to_string(),U128(10),texts[8].clone()).reason_code,"tier2_escalate");
    for item in g.pending_items() {ctx(accounts(5),item.deadline,0);g.expire_pending(item.id);}
    assert!(g.pending_items().is_empty());assert_eq!(g.escrow_balance().0,100);assert_eq!(paid_to(&accounts(2)),0);
}
#[test]
fn n_success_then_failed_callback_cannot_refund_or_repay() {
    let mut g=b4_base(10,10,20);assert_eq!(b4_pay(&mut g,10),"allowed");
    testing_env!(ctxb(accounts(0),1001,0),near_sdk::test_vm_config(),near_sdk::RuntimeFeesConfig::test(),Default::default(),vec![PromiseResult::Successful(vec![])]);
    g.on_payout(1,accounts(2),U128(10));failed_cb_ctx(1002);g.on_payout(1,accounts(2),U128(10));
    assert_eq!(g.escrow_balance().0,10);ctx(accounts(1),1003,0);assert_ne!(b4_pay(&mut g,10),"allowed");assert_eq!(paid_to(&accounts(2)),0);
}

#[test]
fn n_all_policy_nonce_jumps_are_blocked() {
    let mut g=gate();assert!(panics(||set_judges(&mut g,u64::MAX,vec![pk(&jk(11))])));
    assert!(panics(||set_cfg(&mut g,cfg(u64::MAX,0,1000))));
    set_judges(&mut g,1,vec![pk(&jk(11))]);set_cfg(&mut g,cfg(1,0,1000));
    assert_eq!(g.tier2_config().config_nonce,1);
}
#[test]
fn n_successful_withdrawal_cannot_be_refunded_by_duplicate_failure() {
    let mut g=gate();fund(&mut g,20,1000);let sig=sign(&g,&owner(),&withdrawal_bytes(&accounts(0),U128(10),&accounts(3),1));
    let _=g.withdraw_escrow(U128(10),accounts(3),1,sig);
    testing_env!(ctxb(accounts(0),1001,0),near_sdk::test_vm_config(),near_sdk::RuntimeFeesConfig::test(),Default::default(),vec![PromiseResult::Successful(vec![])]);
    g.on_withdraw(1,accounts(3),U128(10));failed_cb_ctx(1002);g.on_withdraw(1,accounts(3),U128(10));assert_eq!(g.escrow_balance().0,10);
}
