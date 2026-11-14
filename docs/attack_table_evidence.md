# Attack-suite table: evidence for manual and code-reading entries

Generated together with the table in CLAIMS.md. Each line is `file:line: source text` from the test.

## `a2_concurrent_budget_overrun` (code reading): paid within mandate; paid after owner approval

- `tests/attack_suite_a.rs:87: let rs: Vec<String> = ["a", "b", "c"].iter().map(|t| pay(&mut g, t, 10)).collect();`
- `tests/attack_suite_a.rs:89: assert_eq!(rs[2], "budget_exceeded");`
- `tests/attack_suite_a.rs:105: assert_eq!(transfers, 1, "only one x10 may pay against limit 15");`

## `a3_post_approval_change` (code reading): paid after owner approval; no payout

- `tests/attack_suite_a.rs:131: g.approve_pending(i1.id, s1.clone());`
- `tests/attack_suite_a.rs:132: let p = panics(|| g.approve_pending(i1.id, s1)); println!("A3 approval replay panics: {p}"); assert!(p);`
- `tests/attack_suite_a.rs:144: assert!(!paid); assert_eq!(g.escrow_balance().0,100);`

## `a7_policy_update_bypass` (code reading): no payout; paid within mandate

- `tests/attack_suite_a.rs:269: assert_eq!(g.approve_rule(id, Some(pk_str(&key())), Some(bad.clone())).reason_code, "invalid_signature");`
- `tests/attack_suite_a.rs:288: fund(&mut g2, 100, 1_000); pay(&mut g2, "a", 10);`
- `tests/attack_suite_a.rs:289: assert_eq!(before,0); assert!(g2.tier2_config().known_payees.is_empty());`

## `b3c_at_deadline_expire_then_approve` (manual (asserts read)): no payout

- `tests/attack_suite_b.rs:113: g.expire_pending(it.id); let p = panics(|| g.approve_pending(it.id, a));`
- `tests/attack_suite_b.rs:114: assert!(p); assert_eq!(g.escrow_balance().0,100);`

## `b4a_zero_amount` (manual (asserts read)): paid within mandate

- `tests/attack_suite_b.rs:125: assert_eq!(c,"zero_amount"); assert_eq!(c2,"allowed"); assert_eq!(g.remaining_budget(1).unwrap().0,0);`

## `b4b_exact_limits` (manual (asserts read)): paid within mandate

- `tests/attack_suite_b.rs:128: assert_eq!(c,"allowed"); assert_eq!(g.escrow_balance().0,0);`

## `b4c_limit_plus_one` (manual (asserts read)): no payout

- `tests/attack_suite_b.rs:131: assert_ne!(c,"allowed"); assert_eq!(g.escrow_balance().0,100);`

## `b4d_u128_max_request` (manual (asserts read)): no payout

- `tests/attack_suite_b.rs:134: assert!(p); assert_eq!(g.escrow_balance().0,100);`

## `b4f_per_tx_exact_and_daily_exact` (manual (asserts read)): paid within mandate

- `tests/attack_suite_b.rs:141: assert_eq!((c1.as_str(),c2.as_str()),("allowed","allowed"));`

## `b4g_daily_saturating_near_max` (manual (asserts read)): paid within mandate; held pending

- `tests/attack_suite_b.rs:144: assert_eq!(b4_pay(&mut g,10),"allowed");`
- `tests/attack_suite_b.rs:144: "b".into()).reason_code,"tier2_escalate"); assert_eq!(g.escrow_balance().0,89);`

## `b5f_uppercase_in_mandate` (manual (asserts read)): no payout

- `tests/attack_suite_b.rs:157: assert_eq!(c,"invalid_recipient"); assert!(!p); assert_eq!(g.escrow_balance().0,100);`

## `b6b_owner_withdraw_races_reserved_payment` (manual (asserts read)): no payout

- `tests/attack_suite_b.rs:173: assert!(p); assert_eq!(g.remaining_budget(1).unwrap().0,10);`

## `b7a_failed_payout_refund_once` (manual (asserts read)): no payout

- `tests/attack_suite_b.rs:186: failed_cb_ctx(1_001); g.on_payout(1, accounts(2), U128(10));`
- `tests/attack_suite_b.rs:187: assert_eq!(g.escrow_balance().0,20); assert_eq!(g.remaining_budget(1).unwrap().0,10);`

## `b7b_reenter_pay_inside_failed_callback_ctx` (manual (asserts read)): no payout

- `tests/attack_suite_b.rs:195: assert_ne!(c,"allowed"); assert_eq!(g.escrow_balance().0,10);`

## `b7c_double_failed_callback` (manual (asserts read)): no payout

- `tests/attack_suite_b.rs:201: assert_eq!(g.escrow_balance().0,10); // Idempotent callback state`

## `b7d_external_failed_callback` (manual (asserts read)): no payout

- `tests/attack_suite_b.rs:205: let p = panics(|| g.on_payout(1, accounts(1), U128(10)));`
- `tests/attack_suite_b.rs:206: assert!(p); assert_eq!(g.escrow_balance().0,10);`

## `n_success_then_failed_callback_cannot_refund_or_repay` (code reading): paid within mandate; no payout

- `tests/attack_suite_b.rs:241: let mut g=b4_base(10,10,20);assert_eq!(b4_pay(&mut g,10),"allowed");`
- `tests/attack_suite_b.rs:244: assert_ne!(b4_pay(&mut g,10),"allowed");assert_eq!(paid_to(&accounts(2)),0);`
