//! NEAR-TN-1 A2+ negative tests: approve_pending must reject a wrong signature and a
//! signature made with a different key. Mock VM only; fixed test keys, no real secrets.
use chopgate::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::json_types::U128;
use near_sdk::test_utils::{accounts, get_created_receipts, VMContextBuilder};
use near_sdk::{testing_env, AccountId, NearToken, PublicKey};
use sha2::{Digest, Sha256};

fn ctx(pred: AccountId, ts: u64, deposit: u128) {
    testing_env!(VMContextBuilder::new().current_account_id(accounts(0)).predecessor_account_id(pred)
        .block_timestamp(ts).attached_deposit(NearToken::from_yoctonear(deposit)).build());
}
fn owner_key() -> SigningKey { SigningKey::from_bytes(&[7; 32]) }
fn other_key() -> SigningKey { SigningKey::from_bytes(&[11; 32]) }
fn pk_str(k: &SigningKey) -> String { format!("ed25519:{}", bs58::encode(k.verifying_key().to_bytes()).into_string()) }
fn h(s: &str) -> String { hex::encode(Sha256::digest(s.as_bytes())) }
/// Signs `payload` with `k` inside the v3 authorization domain; `claimed_owner` is the owner key placed in the domain.
fn sign_as(g: &Gate, k: &SigningKey, claimed_owner: &PublicKey, payload: &[u8]) -> String {
    let (chain, dep, _) = g.signature_domain();
    hex::encode(k.sign(&authorization_bytes(&chain, &dep, claimed_owner, payload)).to_bytes())
}
/// Returns the panic message, or None if `f` did not panic.
fn panic_msg<F: FnOnce()>(f: F) -> Option<String> {
    let e = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).err()?;
    Some(e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_else(|| "<non-string panic>".into()))
}
/// Asserts that `f` panics specifically with the contract's signature rejection.
fn assert_sig_rejected<F: FnOnce()>(label: &str, f: F) {
    let m = panic_msg(f).unwrap_or_else(|| panic!("{label}: expected rejection, call succeeded"));
    println!("NEG {label}: {m}");
    assert!(m.contains("invalid pending signature"), "{label}: unexpected panic message: {m}");
}

/// Gate with one pending item (serial 1, amount 10) reserved from escrow 100.
fn gate_with_pending() -> (Gate, PendingItem) {
    ctx(accounts(1), 1_000, 0);
    let owner: PublicKey = pk_str(&owner_key()).parse().unwrap();
    let mut g = Gate::new(owner.clone(), "local-test".into(), "deployment-1".into());
    let m = Mandate { serial: 1, agent: accounts(1), entries: vec![Permission { action: "transfer".into(),
        target: accounts(2).to_string(), max_amount: U128(10), instruction_hash: h("a") }],
        budget: U128(20), expires_at: u64::MAX, parent_serial: None };
    let s = sign_as(&g, &owner_key(), &owner, &signing_bytes(&accounts(0), &m));
    assert_eq!(g.register(m, Some(pk_str(&owner_key())), Some(s)).reason_code, "allowed");
    ctx(accounts(3), 1_000, 100); g.deposit(); ctx(accounts(1), 1_000, 0);
    let c = Tier2Config { config_nonce: 1, amount_threshold: U128(0), pending_ttl_ns: 1_000_000, new_payee_check: false,
        trusted_sources: vec![], known_payees: vec![], denied_targets: vec![] };
    let cs = sign_as(&g, &owner_key(), &owner, &tier2_config_bytes(&accounts(0), &c));
    g.set_tier2_config(c.clone(), cs);
    assert_eq!(g.tier2_config().config_nonce, c.config_nonce, "tier2 config applied");
    let d = g.authorize_and_pay(1, "transfer".into(), accounts(2).to_string(), U128(10), "a".into());
    assert_eq!(d.reason_code, "tier2_escalate");
    let items = g.pending_items(); assert_eq!(items.len(), 1);
    (g, items[0].clone())
}
fn payee_receipts() -> usize { get_created_receipts().iter().filter(|r| r.receiver_id == accounts(2)).count() }

#[test]
fn approve_pending_rejects_wrong_signature() {
    let (mut g, it) = gate_with_pending();
    let owner: PublicKey = pk_str(&owner_key()).parse().unwrap();
    let good = sign_as(&g, &owner_key(), &owner, &pending_decision_v2_bytes(&accounts(0), it.id, true, &pending_request_hash(&it)));
    // (a) well-formed hex of the right length but not a signature
    let zeros = "00".repeat(64);
    // (b) the genuine signature with one byte flipped
    let mut flipped = hex::decode(&good).unwrap(); flipped[10] ^= 0x01; let flipped = hex::encode(flipped);
    // (c) malformed: wrong length, uppercase
    for (label, bad) in [("zeros", zeros), ("flipped-byte", flipped), ("short-126", good[..126].to_string()),
        ("uppercase-hex (contract requires lowercase)", good.to_uppercase())] {
        assert_sig_rejected(label, || g.approve_pending(it.id, bad.clone()));
    }
    assert_eq!(g.pending_items().len(), 1, "pending must stay open after rejected approvals");
    assert_eq!(g.escrow_balance().0, 90, "reserved escrow unchanged");
    assert_eq!(payee_receipts(), 0, "no transfer to payee");
    g.approve_pending(it.id, good);
    assert!(g.pending_items().is_empty());
    assert_eq!(payee_receipts(), 1, "positive control: genuine owner signature pays once");
}

#[test]
fn approve_pending_rejects_other_key_signature() {
    let (mut g, it) = gate_with_pending();
    let owner: PublicKey = pk_str(&owner_key()).parse().unwrap();
    let other: PublicKey = pk_str(&other_key()).parse().unwrap();
    let payload = pending_decision_v2_bytes(&accounts(0), it.id, true, &pending_request_hash(&it));
    // (a) other key signs exact payload while claiming the owner key in the domain
    let s1 = sign_as(&g, &other_key(), &owner, &payload);
    // (b) other key signs exact payload with its own key in the domain
    let s2 = sign_as(&g, &other_key(), &other, &payload);
    assert_sig_rejected("other key, owner key claimed in domain", || g.approve_pending(it.id, s1.clone()));
    assert_sig_rejected("other key, own key in domain", || g.approve_pending(it.id, s2.clone()));
    // reject_pending with other key is also refused
    let rp = sign_as(&g, &other_key(), &owner, &pending_decision_v2_bytes(&accounts(0), it.id, false, &pending_request_hash(&it)));
    assert_sig_rejected("other key reject_pending", || g.reject_pending(it.id, rp.clone()));
    assert_eq!(g.pending_items().len(), 1);
    assert_eq!(g.escrow_balance().0, 90);
    assert_eq!(payee_receipts(), 0);
    // positive control: the same item is still approvable with the genuine owner signature
    let good = sign_as(&g, &owner_key(), &owner, &payload);
    g.approve_pending(it.id, good);
    assert!(g.pending_items().is_empty());
    assert_eq!(payee_receipts(), 1, "positive control: genuine owner signature pays once");
}
