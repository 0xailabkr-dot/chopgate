//! Wasm-safe dual-lock engine. Time and accounting are explicit inputs.
use near_sdk::{near, json_types::U128};
use crate::judge::{Verdict, final_decision};
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Payee { pub alias: String, pub account: String }
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct SpendRules {
    pub rules_nonce:u64, pub enabled:bool, pub per_tx_limit:U128, pub per_day_limit:U128,
    pub payees:Vec<Payee>, pub tz_offset_min:i32, pub window_start_min:u32, pub window_end_min:u32,
    pub max_tx_per_day:u32, pub allowed_categories:Vec<String>, pub jev_threshold_permille:u16, pub jev_required:bool,
}
impl Default for SpendRules {
    fn default()->Self { Self { rules_nonce:0, enabled:false, per_tx_limit:U128(u128::MAX), per_day_limit:U128(u128::MAX), payees:vec![], tz_offset_min:0, window_start_min:0, window_end_min:0, max_tx_per_day:u32::MAX, allowed_categories:vec![], jev_threshold_permille:900, jev_required:false } }
}
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct JudgeReport {
    #[serde(default)] pub expires_at:u64,
    #[serde(default)] pub nonce:u64,
    #[serde(default)] pub key_generation:u64, pub source_label:String, pub source_q_permille:u16, pub instruction_hash:String, pub category:String, pub category_q_permille:u16, pub mode:String,
    #[serde(default)] pub signer_public_key:Option<String>,
    #[serde(default)] pub signature:Option<String>,
    #[serde(default)] pub request_hash:String,
}
#[derive(Clone, Debug)]
pub struct Evaluation { pub verdict:Verdict, pub lock:String, pub reasons:Vec<String> }
pub fn day_index(timestamp_ns:u64, offset:i32)->i64 { ((timestamp_ns / 60_000_000_000) as i64 + offset as i64).div_euclid(1440) }
/// The only aggregation function: Deny > Escalate > Pass. Reports only tighten.
pub fn evaluate(rules:&SpendRules, target:&str, amount:u128, instruction_hash:&str, report:Option<&JudgeReport>, timestamp_ns:u64, spent:u128, count:u32, tier1_passed:bool, prior:Verdict)->Evaluation {
    let mut a=Verdict::Pass; let mut b=Verdict::Pass; let mut reasons=Vec::new();
    if let Some(r)=report {
        let q=r.source_q_permille; let threshold=rules.jev_threshold_permille;
        if r.instruction_hash!=instruction_hash { a=Verdict::Deny; reasons.push("2a_hash_mismatch".into()); }
        if r.source_label=="external_content" {
            a=a.tighten(if q>=threshold { Verdict::Deny } else { Verdict::Escalate });
            reasons.push("2a_external_content".into());
        } else if r.source_label!="owner_signed" { a=a.tighten(Verdict::Escalate); reasons.push("2a_unknown".into()); }
        if q<threshold || q>1000 { a=a.tighten(Verdict::Escalate); reasons.push("2a_low_confidence".into()); }
        if r.category_q_permille<threshold || r.category_q_permille>1000 { b=b.tighten(Verdict::Escalate); reasons.push("2b_low_confidence".into()); }
    } else if rules.enabled && rules.jev_required { a=Verdict::Escalate; reasons.push("jev_missing".into()); }
    if rules.enabled {
        if !rules.payees.iter().any(|p|p.account==target) { b=Verdict::Deny; reasons.push("2b_payee_not_allowed".into()); }
        for (failed,reason) in [
            (amount>rules.per_tx_limit.0,"2b_per_tx_limit"),
            (spent.checked_add(amount).map_or(true,|v|v>rules.per_day_limit.0),"2b_per_day_limit"),
            (count>=rules.max_tx_per_day,"2b_frequency"),
        ] { if failed { b=b.tighten(Verdict::Escalate); reasons.push(reason.into()); } }
        let minute=((timestamp_ns / 60_000_000_000) as i64 + rules.tz_offset_min as i64).rem_euclid(1440) as u32;
        let (start,end)=(rules.window_start_min,rules.window_end_min);
        let inside=if start==end { true } else if start<end { minute>=start && minute<end } else { minute>=start || minute<end };
        if !inside { b=b.tighten(Verdict::Escalate); reasons.push("2b_time_window".into()); }
        // A configured category rule needs authenticated evidence at the boundary.
        if report.is_none() && !rules.allowed_categories.is_empty() { b=b.tighten(Verdict::Escalate); reasons.push("2b_category_missing".into()); }
        // Without a report there is no JEV opinion; deterministic checks still run.
        if let Some(r)=report { if !rules.allowed_categories.is_empty() && !rules.allowed_categories.contains(&r.category) { b=b.tighten(Verdict::Escalate); reasons.push("2b_category".into()); } }
    }
    let verdict=final_decision(tier1_passed,prior.tighten(a).tighten(b));
    let lock=if a==Verdict::Deny { "2a" } else if b==Verdict::Deny { "2b" } else if verdict==Verdict::Pass { "pass" } else { "2c" };
    Evaluation { verdict, lock:lock.into(), reasons }
}
