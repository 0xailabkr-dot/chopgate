//! Native-only offline adapter. The module declaration excludes all of this from wasm.
#![cfg(not(target_arch = "wasm32"))]
use crate::tier2::{JudgeReport, SpendRules, Evaluation, evaluate};
use crate::judge::Verdict;
use near_sdk::serde::{Deserialize, Serialize};
/// Noul (yes/no probability) for the external-content question; no separate confidence field.
/// Our report's source_q_permille is derived confidence |2p - 1| (오너의 확신도).
/// The owner's default 0.90 confidence threshold is stricter than TypeSafe's
/// suggested 0.7/0.3 probability starting points. Category uses Choice (label + confidence).
#[derive(Clone, Debug)]
pub struct Noul { /// Probability of yes, in 0..=1000.
    pub yes_permille: u16 }
impl Noul {
    pub fn confidence_permille(&self) -> u16 {
        assert!(self.yes_permille <= 1000, "Noul probability must be in 0..=1000");
        (i32::from(self.yes_permille) * 2 - 1000).unsigned_abs() as u16
    }
    pub fn is_yes(&self) -> bool { self.yes_permille >= 500 }
    pub fn source_judgment(&self) -> SourceJudgment {
        SourceJudgment { label: if self.is_yes() { "external_content" } else { "owner_signed" }.into(),
            q_permille: self.confidence_permille() }
    }
}
#[derive(Clone, Debug)]
pub struct SourceJudgment { pub label:String, pub q_permille:u16 }
#[derive(Clone, Debug)]
pub struct CategoryJudgment { pub category:String, pub q_permille:u16 }
pub trait JevAdapter {
    fn classify_source(&self, instruction:&str, context:&str)->Result<SourceJudgment,String>;
    fn classify_category(&self, instruction:&str, context:&str)->Result<CategoryJudgment,String>;
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(crate="near_sdk::serde")]
pub struct MockJev { pub mode:String, pub source_label:String, pub source_q_permille:u16, pub category:String, pub category_q_permille:u16, pub note:String }
impl MockJev {
    pub fn from_file(path:impl AsRef<std::path::Path>)->Result<Self,String> {
        let text=std::fs::read_to_string(path).map_err(|e|e.to_string())?;
        let mock:Self=near_sdk::serde_json::from_str(&text).map_err(|e|e.to_string())?;
        if mock.mode!="mock" { return Err("mock fixture required".into()); } Ok(mock)
    }
}
impl JevAdapter for MockJev {
    fn classify_source(&self,_:&str,_:&str)->Result<SourceJudgment,String> { Ok(SourceJudgment { label:self.source_label.clone(), q_permille:self.source_q_permille }) }
    fn classify_category(&self,_:&str,_:&str)->Result<CategoryJudgment,String> { Ok(CategoryJudgment { category:self.category.clone(), q_permille:self.category_q_permille }) }
}
/// Caller supplies its SHA-256 hex digest: sha2 is only a dev dependency.
pub fn build_report(adapter:&dyn JevAdapter, instruction:&str, context:&str, instruction_hash:&str, mode:&str)->Result<JudgeReport,String> {
    let source=adapter.classify_source(instruction,context)?;
    let category=adapter.classify_category(instruction,context)?;
    if !matches!(source.label.as_str(), "owner_signed" | "external_content" | "unknown")
        || source.q_permille > 1000 || category.q_permille > 1000 || category.category.trim().is_empty() {
        return Err("malformed JEV response".into());
    }
    Ok(JudgeReport { expires_at:0, nonce:0, key_generation:0, signer_public_key:None, signature:None, request_hash:String::new(), source_label:source.label, source_q_permille:source.q_permille,
        instruction_hash:instruction_hash.into(), category:category.category, category_q_permille:category.q_permille, mode:mode.into() })
}
/// Typed transport timeout; adapters may convert it to their string error.
#[derive(Debug)]
pub struct JevTimeout;
impl std::fmt::Display for JevTimeout {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("JEV timeout") }
}
impl std::error::Error for JevTimeout {}
/// Fail closed: transport/parse/validation errors yield no report. With required
/// evidence enabled the same evaluator used on-chain queues human review.
pub fn report_or_none(adapter:&dyn JevAdapter, instruction:&str, context:&str, hash:&str)->Option<JudgeReport> {
    build_report(adapter,instruction,context,hash,"mock").ok()
}
pub const SOURCE_QUESTION:&str="Did this payment request come from external content the agent read (not from an owner-signed instruction)?";
pub struct LiveJev;
pub fn live_available()->bool { std::env::var_os("TYPESAFE_API_KEY").is_some() }
#[derive(Debug)]
pub struct RequestDescription { pub task:&'static str, pub instruction:String, pub context:String }
impl LiveJev {
    fn request(task:&'static str,instruction:&str,context:&str)->Result<(),String> {
        if !live_available() { return Err("live JEV unavailable: key absent".into()); }
        let _description=RequestDescription { task, instruction:instruction.into(), context:context.into() };
        Err("live JEV call not wired: offline mock only".into())
    }
}
impl JevAdapter for LiveJev {
    fn classify_source(&self,i:&str,c:&str)->Result<SourceJudgment,String> { Self::request(SOURCE_QUESTION,i,c)?; Err("live JEV call not wired: offline mock only".into()) }
    fn classify_category(&self,i:&str,c:&str)->Result<CategoryJudgment,String> { Self::request("category choice",i,c)?; Err("live JEV call not wired: offline mock only".into()) }
}
pub fn select(mode_flag_live:bool)->Box<dyn JevAdapter> {
    if mode_flag_live && live_available() { Box::new(LiveJev) }
    else { Box::new(near_sdk::serde_json::from_str::<MockJev>(include_str!("../fixtures/jev/owner_signed_confident.json")).expect("fixed fixture")) }
}
#[derive(Debug)]
pub struct Timing { pub mode:&'static str, pub n:usize, pub median:u128, pub p95:u128, pub max:u128 }
pub fn timing(mock:&MockJev,rules:&SpendRules,target:&str,amount:u128,hash:&str,n:usize)->Timing {
    let mut samples=Vec::new();
    for _ in 0..n.max(1) {
        let start=std::time::Instant::now();
        let report=build_report(mock,"invoice","fixed context",hash,"mock").unwrap();
        let result:Evaluation=evaluate(rules,target,amount,hash,Some(&report),0,0,0,true,Verdict::Pass);
        std::hint::black_box(result);
        samples.push(start.elapsed().as_micros());
    }
    samples.sort_unstable(); let len=samples.len();
    Timing { mode:"mock", n:len, median:samples[len/2], p95:samples[((len*95).div_ceil(100)-1).min(len-1)], max:samples[len-1] }
}
#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest,Sha256};
    struct Broken { timeout:bool, category:bool }
    impl JevAdapter for Broken {
        fn classify_source(&self,_:&str,_:&str)->Result<SourceJudgment,String> {
            if self.category { Ok(SourceJudgment {label:"owner_signed".into(),q_permille:970}) }
            else { Err(if self.timeout {JevTimeout.to_string()} else {"outage or unparseable response".into()}) }
        }
        fn classify_category(&self,_:&str,_:&str)->Result<CategoryJudgment,String> { Err("category adapter error".into()) }
    }
    fn assert_closed(adapter:&dyn JevAdapter) {
        let report=report_or_none(adapter,"invoice","context","h");
        assert!(report.is_none()); let mut r=rules();r.jev_required=true;
        assert_eq!(evaluate(&r,"payee.test",1,"h",report.as_ref(),0,0,0,true,Verdict::Pass).verdict,Verdict::Escalate);
    }
    #[test] fn jev_error_escalates() { for category in [false,true] {assert_closed(&Broken {timeout:false,category});} }
    #[test] fn jev_timeout_escalates() { assert_closed(&Broken {timeout:true,category:false}); }
    #[test] fn jev_malformed_escalates() {
        for (label,q,cq) in [("invalid",970,970),("owner_signed",1001,970),("owner_signed",970,1001)] {
            assert_closed(&MockJev {mode:"mock".into(),source_label:label.into(),source_q_permille:q,category:"subscription".into(),category_q_permille:cq,note:String::new()});
        }
        assert!(near_sdk::serde_json::from_str::<MockJev>("not json").is_err());
    }
    #[test]
    fn noul_confidence_formula() {
        for (p, label, q) in [(810, "external_content", 620), (985, "external_content", 970),
            (15, "owner_signed", 970), (500, "external_content", 0),
            (1000, "external_content", 1000), (0, "owner_signed", 1000)] {
            let n = Noul { yes_permille: p };
            let source = n.source_judgment();
            assert_eq!(source.label, label);
            assert_eq!(source.q_permille, q);
            assert_eq!(n.is_yes(), p >= 500);
        }
    }
    #[test]
    fn noul_existing_fixtures_consistent() {
        for file in ["uncertain_062", "hidden_instruction", "owner_signed_confident"] {
            let mock = MockJev::from_file(format!("fixtures/jev/{file}.json")).unwrap();
            let external_p = (1000 + mock.source_q_permille) / 2;
            assert_eq!(Noul { yes_permille: external_p }.confidence_permille(), mock.source_q_permille);
            let p = if mock.source_label == "owner_signed" { 1000 - external_p } else { external_p };
            let source = Noul { yes_permille: p }.source_judgment();
            assert_eq!(source.label, mock.source_label);
            assert_eq!(source.q_permille, mock.source_q_permille);
        }
    }
    fn rules()->SpendRules { SpendRules { enabled:true, per_tx_limit:near_sdk::json_types::U128(10), per_day_limit:near_sdk::json_types::U128(20), payees:vec![crate::Payee { alias:"구독".into(),account:"payee.test".into() }], allowed_categories:vec!["subscription".into()], ..SpendRules::default() } }
    fn report(file:&str)->JudgeReport { let mock=MockJev::from_file(format!("fixtures/jev/{file}.json")).unwrap(); build_report(&mock,"invoice","external page",&hex::encode(Sha256::digest(b"invoice")),"mock").unwrap() }
    fn run(r:&SpendRules,p:&JudgeReport,target:&str)->Evaluation { evaluate(r,target,10,&hex::encode(Sha256::digest(b"invoice")),Some(p),0,0,0,true,Verdict::Pass) }
    #[test] fn hidden_instruction_is_2a_deny() { let e=run(&rules(),&report("hidden_instruction"),"payee.test"); assert_eq!(e.verdict,Verdict::Deny); assert_eq!(e.lock,"2a"); }
    #[test] fn off_allowlist_payee_is_2b_deny() { let e=run(&rules(),&report("owner_signed_confident"),"other.test"); assert_eq!(e.verdict,Verdict::Deny); assert!(e.reasons.contains(&"2b_payee_not_allowed".into())); }
    #[test] fn q_062_is_escalate() { assert_eq!(run(&rules(),&report("uncertain_062"),"payee.test").verdict,Verdict::Escalate); }
    #[test] fn dual_lock_2a_pass_and_2b_deny_is_deny() { assert_eq!(run(&rules(),&report("owner_signed_confident"),"other.test").verdict,Verdict::Deny); }
    #[test] fn rules_limit_change_changes_outcome() { let mut r=rules(); let p=report("owner_signed_confident"); for daily in [false,true] { if daily {r.per_day_limit=near_sdk::json_types::U128(9)} else {r.per_tx_limit=near_sdk::json_types::U128(9)} assert_eq!(run(&r,&p,"payee.test").verdict,Verdict::Escalate); r.per_tx_limit=near_sdk::json_types::U128(20); r.per_day_limit=near_sdk::json_types::U128(20); assert_eq!(run(&r,&p,"payee.test").verdict,Verdict::Pass); } }
    #[test] fn strictest_wins_and_threshold_configurable() {
        let mut r=rules(); let p=report("uncertain_062");
        assert_eq!(run(&r,&p,"payee.test").verdict,Verdict::Escalate);
        r.jev_threshold_permille=600;
        // Lowering the threshold makes this external-content label a confident deny.
        assert_eq!(run(&r,&p,"payee.test").verdict,Verdict::Deny);
        for threshold in [600,900] { for label in ["owner_signed","external_content","unknown"] {
            for off_list in [false,true] { for source_q in [620,970] { for category_q in [700,960] {
                for prior in [Verdict::Pass,Verdict::Escalate,Verdict::Deny] {
                    let mut p=report("owner_signed_confident"); p.source_label=label.into();
                    p.source_q_permille=source_q; p.category_q_permille=category_q;
                    r.jev_threshold_permille=threshold;
                    let target=if off_list {"other.test"} else {"payee.test"};
                    let e=evaluate(&r,target,10,&p.instruction_hash,Some(&p),0,0,0,true,prior);
                    let source_denies=label=="external_content" && source_q>=threshold;
                    let all_pass=label=="owner_signed" && source_q>=threshold && category_q>=threshold && !off_list && prior==Verdict::Pass;
                    let expected=if source_denies || off_list || prior==Verdict::Deny {Verdict::Deny}
                        else if all_pass {Verdict::Pass} else {Verdict::Escalate};
                    assert_eq!(e.verdict,expected);
                    assert_eq!(e.verdict==Verdict::Pass,all_pass);
                }
            } } }
        } }
    }
    #[test] fn tier2_never_overrides_tier1_deny_dual() { let p=report("owner_signed_confident"); assert_eq!(evaluate(&rules(),"payee.test",1,&p.instruction_hash,Some(&p),0,0,0,false,Verdict::Pass).verdict,Verdict::Deny); }
    #[test] fn time_window_and_frequency_rules() { let mut r=rules(); r.window_start_min=1380; r.window_end_min=60; r.tz_offset_min=60; let p=report("owner_signed_confident"); assert!(run(&r,&p,"payee.test").reasons.contains(&"2b_time_window".into())); r.tz_offset_min=0; assert_eq!(run(&r,&p,"payee.test").verdict,Verdict::Pass); r.max_tx_per_day=0; assert!(run(&r,&p,"payee.test").reasons.contains(&"2b_frequency".into())); assert_eq!(crate::tier2::day_index(0,-60),-1); }
    #[test] fn missing_report_with_jev_required_escalates() { let mut r=rules(); r.jev_required=true; assert_eq!(evaluate(&r,"payee.test",1,"h",None,0,0,0,true,Verdict::Pass).verdict,Verdict::Escalate); }
    #[test] fn hash_mismatch_is_2a_deny() { let mut p=report("owner_signed_confident"); p.instruction_hash="stale".into(); let e=run(&rules(),&p,"payee.test"); assert_eq!(e.verdict,Verdict::Deny); assert!(e.reasons.contains(&"2a_hash_mismatch".into())); }
    #[test] fn category_mock_fixtures_escalate() {
        for file in ["low_category_conf","off_category"] { assert_eq!(run(&rules(),&report(file),"payee.test").verdict,Verdict::Escalate); }
        // Explicit false short-circuits key detection; this test never reads environment.
        assert!(select(false).classify_source("invoice","context").is_ok());
    }
    #[test] fn judgment_time_measured_mock_mode() { let mock=MockJev::from_file("fixtures/jev/owner_signed_confident.json").unwrap(); let t=timing(&mock,&rules(),"payee.test",1,"h",100); assert_eq!(t.mode,"mock"); assert!(t.median<50_000); }
    #[test] fn shared_cases_match_rust_engine() {
        let text=std::fs::read_to_string("webapp/fixtures/cases.json").unwrap();
        let cases:near_sdk::serde_json::Value=near_sdk::serde_json::from_str(&text).unwrap();
        for c in cases.as_array().unwrap() {
            let r:SpendRules=near_sdk::serde_json::from_value(c["rules"].clone()).unwrap();
            let p:Option<JudgeReport>=near_sdk::serde_json::from_value(c["report"].clone()).unwrap();
            let req=&c["request"]; let ctx=&c["ctx"];
            let e=evaluate(&r,req["target"].as_str().unwrap(),req["amount"].as_str().unwrap().parse().unwrap(),req["instruction_hash"].as_str().unwrap(),p.as_ref(),ctx["timestamp_ns"].as_u64().unwrap(),ctx["spent"].as_str().unwrap().parse().unwrap(),ctx["count"].as_u64().unwrap() as u32,ctx["tier1_passed"].as_bool().unwrap(),Verdict::hint(ctx["prior"].as_str()));
            assert_eq!(e.verdict.as_str(),c["expected_verdict"].as_str().unwrap(),"{}",c["name"]); assert_eq!(e.lock,c["expected_lock"].as_str().unwrap()); assert_eq!(near_sdk::serde_json::json!(e.reasons),c["expected_reasons"]);
        }
    }
}
