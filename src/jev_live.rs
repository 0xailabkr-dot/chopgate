//! Live JEV (TypeSafe System One) decision layer. Native only: excluded from wasm.
//!
//! This module holds the pure parts: configuration, the request body, response parsing,
//! the decision rule, the receipt and the judge-report encoding. The HTTP transport lives in
//! `tests/jev_live/mod.rs` (dev-dependency `reqwest`), so the contract crate gains no network
//! dependency. The API key is never handled here.
//!
//! Decision rule (thresholds come from `config/jev.json`):
//! * mandatory rules first: a mandatory block or human review can never be relaxed by JEV;
//! * p(yes) >= allow_min -> allow; tier2_min <= p(yes) < allow_min -> tier2 (human approval);
//!   p(yes) < tier2_min -> block;
//! * no key, transport error, HTTP error, malformed answer or timeout -> human review (fail closed).
#![cfg(not(target_arch = "wasm32"))]
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::{self, json, Value};

/// Question name used in every request; the answer is looked up under the same name.
pub const QUESTION: &str = "pay_automatically";
/// Question v2. v1 also treated "amount above the human-review amount" as a no, so a payment that
/// should go to human approval (a mandatory tier-2 rule) was answered as a block. v2 asks only
/// about the mandate scope; the human-review amount is enforced by the mandatory rules.
pub const QUESTION_VERSION: &str = "v2";
pub const QUESTION_TEXT: &str = "Is this payment inside the owner's signed mandate scope: same action, recipient equal to the mandate target, and amount at or below the mandate per-payment maximum?";
pub const CRITERIA_TRUE: &str = "Action and recipient match the mandate and the amount is at or below max_amount_near. An amount above human_review_above_near is still inside the scope; human review is decided separately.";
/// The documented TypeSafe System One endpoint. Only answers from this endpoint can set
/// `report_authenticated`; any other endpoint (for example a local test stub) is labelled "stub".
pub const OFFICIAL_ENDPOINT: &str = "https://api.typesafe.ai/v1/systemone";
/// Hard upper bound for `call_budget` in the config file.
pub const MAX_CALL_BUDGET: u32 = 10;
pub const CRITERIA_FALSE: &str = "The action or recipient differs from the mandate, or the amount is above max_amount_near.";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(crate = "near_sdk::serde")]
pub struct JevConfig {
    pub endpoint: String,
    pub model: String,
    pub allow_min: f64,
    pub tier2_min: f64,
    pub timeout_ms: u64,
    pub call_budget: u32,
}
impl JevConfig {
    pub fn from_file(path: impl AsRef<std::path::Path>) -> Result<Self, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("config read: {e}"))?;
        let c: Self = serde_json::from_str(&text).map_err(|e| format!("config parse: {e}"))?;
        c.validate()?;
        Ok(c)
    }
    pub fn validate(&self) -> Result<(), String> {
        let ok = self.tier2_min.is_finite() && self.allow_min.is_finite()
            && 0.0 <= self.tier2_min && self.tier2_min <= self.allow_min && self.allow_min <= 1.0;
        if !ok { return Err("thresholds must satisfy 0 <= tier2_min <= allow_min <= 1".into()); }
        if self.model.is_empty() { return Err("model required".into()); }
        // The key travels in the Authorization header: https only; plain http only for a loopback test stub.
        endpoint_ok(&self.endpoint)?;
        if self.timeout_ms == 0 { return Err("timeout_ms must be positive".into()); }
        if self.call_budget == 0 || self.call_budget > MAX_CALL_BUDGET { return Err(format!("call_budget must be 1..={MAX_CALL_BUDGET}")); }
        Ok(())
    }
}

/// Endpoint rule: `https://` with a plain host, or `http://` only when the host is exactly
/// 127.0.0.1, localhost or [::1]. The authority must not contain userinfo (`@`) or a backslash,
/// so `http://127.0.0.1:80@evil.example/` is rejected.
fn endpoint_ok(endpoint: &str) -> Result<(), String> {
    let err = || Err("endpoint must be https:// (http only for loopback), without userinfo".to_string());
    let (https, rest) = if let Some(r) = endpoint.strip_prefix("https://") { (true, r) }
        else if let Some(r) = endpoint.strip_prefix("http://") { (false, r) } else { return err(); };
    let authority = &rest[..rest.find(['/', '?', '#']).unwrap_or(rest.len())];
    if authority.is_empty() || authority.contains(['@', '\\', ' ']) { return err(); }
    let host = if authority.starts_with('[') {
        match authority.find(']') { Some(i) => { let tail = &authority[i + 1..];
            if !(tail.is_empty() || tail.strip_prefix(':').is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))) { return err(); }
            &authority[..=i] } None => return err() }
    } else {
        let (h, port) = authority.split_once(':').map_or((authority, None), |(h, p)| (h, Some(p)));
        if port.is_some_and(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit())) { return err(); }
        h
    };
    if host.is_empty() { return err(); }
    if !https && !["127.0.0.1", "localhost", "[::1]"].contains(&host) { return err(); }
    Ok(())
}

/// The only content sent to JEV: amount, recipient, mandate scope and the previous decision.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(crate = "near_sdk::serde")]
pub struct JevState {
    pub amount_near: String,
    pub recipient: String,
    pub mandate_scope: MandateScope,
    pub previous_decision: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(crate = "near_sdk::serde")]
pub struct MandateScope {
    pub action: String,
    pub target: String,
    pub max_amount_near: String,
    pub human_review_above_near: String,
}

pub fn request_body(cfg: &JevConfig, state: &JevState) -> Value {
    json!({
        "model": cfg.model,
        "state": state,
        "questions": { QUESTION: { "type": "noul", "instructions": QUESTION_TEXT,
            "criteria": { "true": CRITERIA_TRUE, "false": CRITERIA_FALSE } } }
    })
}

/// A parsed, validated JEV answer.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(crate = "near_sdk::serde")]
pub struct JevAnswer {
    /// `model` field of the response (the version that actually answered).
    pub model: String,
    /// `x-typesafe-request-id` response header.
    pub request_id: String,
    /// `answers.<QUESTION>.noul`: probability of yes, 0..=1.
    pub p_yes: f64,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// Validates an HTTP status and body. Anything unexpected is an error (which fails closed).
pub fn parse_response(status: u16, body: &str, request_id: Option<&str>) -> Result<JevAnswer, String> {
    if status != 200 { return Err(format!("http_status_{status}")); }
    let v: Value = serde_json::from_str(body).map_err(|_| "malformed_json".to_string())?;
    let model = v["model"].as_str().filter(|s| !s.is_empty()).ok_or("missing_model")?.to_string();
    let a = &v["answers"][QUESTION];
    if a["type"].as_str() != Some("noul") { return Err("missing_noul_answer".into()); }
    let p = a["noul"].as_f64().ok_or("missing_probability")?;
    if !(0.0..=1.0).contains(&p) || !p.is_finite() { return Err("probability_out_of_range".into()); }
    let input_tokens = v["usage"]["input_tokens"].as_u64().ok_or("missing_usage")?;
    let output_tokens = v["usage"]["output_tokens"].as_u64().ok_or("missing_usage")?;
    let request_id = request_id.filter(|s| !s.is_empty()).ok_or("missing_request_id")?.to_string();
    Ok(JevAnswer { model, request_id, p_yes: p, input_tokens, output_tokens })
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(crate = "near_sdk::serde", rename_all = "snake_case")]
pub enum Decision { Allow, Tier2, HumanReview, Block }
impl Decision {
    pub fn as_str(self) -> &'static str {
        match self { Self::Allow => "allow", Self::Tier2 => "tier2", Self::HumanReview => "human_review", Self::Block => "block" }
    }
    /// Strictest wins: Block > HumanReview > Tier2 > Allow.
    pub fn tighten(self, other: Self) -> Self { std::cmp::max(self, other) }
    /// Judge hint understood by the contract (`Verdict::hint`).
    pub fn hint(self) -> &'static str {
        match self { Self::Allow => "pass", Self::Tier2 | Self::HumanReview => "escalate", Self::Block => "deny" }
    }
}

/// JEV-only decision from p(yes).
pub fn decide_p(cfg: &JevConfig, p: f64) -> Decision {
    if p >= cfg.allow_min { Decision::Allow } else if p >= cfg.tier2_min { Decision::Tier2 } else { Decision::Block }
}

/// Mandatory (deterministic) checks computed from the same state, before JEV.
pub fn mandatory_check(amount_yocto: u128, recipient: &str, target: &str, max_yocto: u128, review_above_yocto: u128) -> (Decision, Vec<String>) {
    let mut d = Decision::Allow; let mut reasons = vec![];
    if recipient != target { d = d.tighten(Decision::Block); reasons.push("recipient_out_of_scope".into()); }
    if amount_yocto > max_yocto { d = d.tighten(Decision::Block); reasons.push("entry_limit_exceeded".into()); }
    if amount_yocto > review_above_yocto { d = d.tighten(Decision::Tier2); reasons.push("amount_above_review_threshold".into()); }
    (d, reasons)
}

/// Final decision: mandatory result first (never relaxed), then JEV; any JEV error -> human review.
pub fn final_decision(cfg: &JevConfig, mandatory: Decision, jev: &Result<JevAnswer, String>) -> Decision {
    let j = match jev { Ok(a) => decide_p(cfg, a.p_yes), Err(_) => Decision::HumanReview };
    mandatory.tighten(j)
}

/// Receipt written for every judged request. `report_authenticated` is true only when a response
/// from `OFFICIAL_ENDPOINT` was received and parsed. Fixtures replayed offline ("fixture") and
/// answers from any other endpoint such as a local stub ("stub") never set it.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(crate = "near_sdk::serde")]
pub struct Receipt {
    pub scene: String,
    pub source: String,
    pub question_version: String,
    pub model_requested: String,
    pub model_version: Option<String>,
    pub request_id: Option<String>,
    pub p_yes: Option<f64>,
    pub allow_min: f64,
    pub tier2_min: f64,
    pub jev_decision: String,
    pub mandatory_decision: String,
    pub mandatory_reasons: Vec<String>,
    pub final_decision: String,
    pub error: Option<String>,
    pub report_authenticated: bool,
    pub latency_ms: Option<u128>,
}
pub fn receipt(scene: &str, live: bool, cfg: &JevConfig, mandatory: (Decision, Vec<String>), jev: &Result<JevAnswer, String>, latency_ms: Option<u128>) -> Receipt {
    let fin = final_decision(cfg, mandatory.0, jev);
    let (jd, a, err) = match jev {
        Ok(a) => (decide_p(cfg, a.p_yes), Some(a), None),
        Err(e) => (Decision::HumanReview, None, Some(e.clone())),
    };
    let official = live && cfg.endpoint == OFFICIAL_ENDPOINT;
    let source = if official { "jev_live" } else if live { "stub" } else { "fixture" };
    Receipt { scene: scene.into(), question_version: QUESTION_VERSION.into(), source: source.into(), model_requested: cfg.model.clone(),
        model_version: a.map(|a| a.model.clone()), request_id: a.map(|a| a.request_id.clone()), p_yes: a.map(|a| a.p_yes),
        allow_min: cfg.allow_min, tier2_min: cfg.tier2_min, jev_decision: jd.as_str().into(),
        mandatory_decision: mandatory.0.as_str().into(), mandatory_reasons: mandatory.1, final_decision: fin.as_str().into(),
        error: err, report_authenticated: official && a.is_some(), latency_ms }
}

/// Fields of the on-chain judge report that encode the final decision. The contract compares
/// `source_q_permille` / `category_q_permille` with its own threshold (default 900):
/// allow -> owner_signed with q = floor(p*1000) (>= 900); tier2 -> owner_signed with q capped
/// at 899 (escalates); block -> external_content with q = 1000 (denies). The raw p(yes),
/// model version and request id travel in the signed `mode` string and in the receipt.
/// No category question is asked: callers use `REPORT_CATEGORY` with `category_q_permille`
/// 1000, which is not a model output and only keeps the category check neutral.
pub const REPORT_CATEGORY: &str = "not_asked";
pub fn report_fields(decision: Decision, a: &JevAnswer) -> (String, u16, String) {
    let q = ((a.p_yes * 1000.0).floor() as i64).clamp(0, 1000) as u16;
    let (label, q) = match decision {
        Decision::Allow => ("owner_signed", q.max(900)),
        Decision::Tier2 | Decision::HumanReview => ("owner_signed", q.min(899)),
        Decision::Block => ("external_content", 1000),
    };
    (label.into(), q, format!("jev-live;model={};request_id={};p_yes={:.4}", a.model, a.request_id, a.p_yes))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn cfg() -> JevConfig { JevConfig::from_file("config/jev.json").unwrap() }
    fn fixture(name: &str) -> (u16, String, Option<String>) {
        let v: Value = serde_json::from_str(&std::fs::read_to_string(format!("fixtures/jev_live/{name}.json")).unwrap()).unwrap();
        let body = match &v["body"] { Value::String(s) => s.clone(), other => other.to_string() };
        (v["status"].as_u64().unwrap() as u16, body, v["request_id"].as_str().map(String::from))
    }
    fn parsed(name: &str) -> Result<JevAnswer, String> { let (s, b, r) = fixture(name); parse_response(s, &b, r.as_deref()) }
    const M: u128 = 1_000_000_000_000_000_000_000;
    #[test] fn config_file_thresholds() {
        let c = cfg(); assert_eq!((c.allow_min, c.tier2_min, c.model.as_str()), (0.90, 0.50, "jev-latest"));
        assert!(c.call_budget <= 10);
        let mut bad = c.clone(); bad.tier2_min = 0.95; assert!(bad.validate().is_err());
        let mut bad = c.clone(); bad.allow_min = f64::NAN; assert!(bad.validate().is_err());
        for (b, ok) in [(0, false), (1, true), (10, true), (11, false)] { let mut x = c.clone(); x.call_budget = b; assert_eq!(x.validate().is_ok(), ok, "budget {b}"); }
        for (e, ok) in [("https://api.typesafe.ai/v1/systemone", true), ("http://api.typesafe.ai/v1/systemone", false),
            ("http://127.0.0.1:8080/v1/systemone", true), ("http://localhost:1/x", true), ("http://127.0.0.1.evil.test/x", false),
            ("http://localhost.evil.test/x", false), ("ftp://x", false), ("http://127.0.0.1:80@evil.example/x", false),
            ("http://localhost:80@evil.example", false), ("http://localhost@evil.example/", false), ("https://user@api.typesafe.ai/v1/systemone", false),
            ("http://127.0.0.1\\@evil.example/", false), ("http://[::1]:8080/x", true), ("http://[::1]x/", false), ("http://127.0.0.1:/x", false), ("https:///x", false)] {
            let mut x = c.clone(); x.endpoint = e.into(); assert_eq!(x.validate().is_ok(), ok, "{e}");
        }
        assert_eq!(c.endpoint, OFFICIAL_ENDPOINT);
    }
    #[test] fn thresholds_boundaries() {
        let c = cfg();
        for (p, d) in [(1.0, Decision::Allow), (0.90, Decision::Allow), (0.8999, Decision::Tier2), (0.50, Decision::Tier2),
            (0.4999, Decision::Block), (0.0, Decision::Block)] { assert_eq!(decide_p(&c, p), d, "p={p}"); }
        let mut c2 = c.clone(); c2.allow_min = 0.95; assert_eq!(decide_p(&c2, 0.92), Decision::Tier2);
    }
    #[test] fn request_body_contains_only_allowed_state() {
        let st = JevState { amount_near: "0.01".into(), recipient: "payee.test".into(), previous_decision: "none".into(),
            mandate_scope: MandateScope { action: "transfer".into(), target: "payee.test".into(), max_amount_near: "0.01".into(), human_review_above_near: "0.05".into() } };
        let b = request_body(&cfg(), &st);
        assert_eq!(b["model"], "jev-latest");
        let mut keys: Vec<_> = b["state"].as_object().unwrap().keys().cloned().collect(); keys.sort();
        assert_eq!(keys, ["amount_near", "mandate_scope", "previous_decision", "recipient"]);
        assert_eq!(b["questions"][QUESTION]["type"], "noul");
        let text = b.to_string();
        if let Ok(p) = std::env::var("CHOPGATE_BANNED_WORDS_FILE") { for w in std::fs::read_to_string(p).unwrap().lines().map(str::trim).filter(|w| !w.is_empty()) { assert!(!text.contains(w), "a word from the private list is in the request body"); } }
    }
    #[test] fn fixture_allow_parses() {
        let a = parsed("allow").unwrap();
        assert!(a.p_yes >= 0.9 && !a.request_id.is_empty() && !a.model.is_empty());
        assert_eq!(decide_p(&cfg(), a.p_yes), Decision::Allow);
    }
    #[test] fn fixture_block_and_tier2() {
        assert_eq!(decide_p(&cfg(), parsed("block").unwrap().p_yes), Decision::Block);
        assert_eq!(decide_p(&cfg(), parsed("tier2").unwrap().p_yes), Decision::Tier2);
    }
    #[test] fn errors_fail_closed_to_human_review() {
        let c = cfg();
        for name in ["http_401", "http_529", "malformed", "missing_request_id", "out_of_range", "wrong_type"] {
            let r = parsed(name); assert!(r.is_err(), "{name} must be an error");
            assert_eq!(final_decision(&c, Decision::Allow, &r), Decision::HumanReview, "{name}");
            let rc = receipt("t", true, &c, (Decision::Allow, vec![]), &r, None);
            assert!(!rc.report_authenticated && rc.p_yes.is_none(), "{name}");
        }
        for e in ["key_absent", "timeout", "transport_error"] {
            assert_eq!(final_decision(&c, Decision::Allow, &Err(e.into())), Decision::HumanReview);
        }
    }
    #[test] fn mandatory_rules_cannot_be_overridden() {
        let c = cfg(); let allow = parsed("allow");
        let (d, r) = mandatory_check(20 * M, "payee.test", "payee.test", 10 * M, 50 * M);
        assert_eq!((d, r), (Decision::Block, vec!["entry_limit_exceeded".to_string()]));
        assert_eq!(final_decision(&c, Decision::Block, &allow), Decision::Block);
        let (d, _) = mandatory_check(80 * M, "payee.test", "payee.test", 80 * M, 50 * M);
        assert_eq!(d, Decision::Tier2); assert_eq!(final_decision(&c, d, &allow), Decision::Tier2);
        assert_eq!(mandatory_check(10 * M, "x.test", "payee.test", 10 * M, 50 * M).0, Decision::Block);
        // JEV may only tighten.
        assert_eq!(final_decision(&c, Decision::Allow, &parsed("block")), Decision::Block);
        assert_eq!(final_decision(&c, Decision::Tier2, &parsed("block")), Decision::Block);
    }
    #[test] fn receipt_fields_and_authentication_flag() {
        let c = cfg(); let a = parsed("allow");
        let live = receipt("1", true, &c, (Decision::Allow, vec![]), &a, Some(10));
        assert!(live.report_authenticated && live.request_id.is_some() && live.model_version.is_some() && live.p_yes.is_some());
        assert_eq!(live.final_decision, "allow");
        let replay = receipt("1", false, &c, (Decision::Allow, vec![]), &a, None);
        assert!(!replay.report_authenticated, "fixtures never authenticate");
        assert_eq!(live.source, "jev_live");
        let mut stub = c.clone(); stub.endpoint = "http://127.0.0.1:9/v1/systemone".into();
        let st = receipt("1", true, &stub, (Decision::Allow, vec![]), &a, Some(10));
        assert!(!st.report_authenticated && st.source == "stub", "a non-official endpoint never authenticates");
        let text = serde_json::to_string(&live).unwrap();
        assert!(!text.contains("Bearer") && !text.contains("TYPESAFE_API_KEY"));
    }
    #[test] fn recorded_live_responses_replay_offline() {
        // Recorded with question v1 (see QUESTION_VERSION); replay never authenticates.
        for (scene, want) in [("1", Decision::Allow), ("4", Decision::Block), ("5", Decision::Block)] {
            let a = parsed(&format!("recorded_q1_scene{scene}")).unwrap();
            assert!(a.model.starts_with("jev-") && a.request_id.starts_with("req_"));
            assert_eq!(decide_p(&cfg(), a.p_yes), want, "scene {scene}");
            assert!(!receipt(scene, false, &cfg(), (Decision::Allow, vec![]), &Ok(a), None).report_authenticated);
        }
    }
    #[test] fn recorded_v2_responses_replay_offline() {
        // Recorded in testnet run j2 with question v2: scene 5 is inside the mandate scope (allow), and the
        // mandatory human-review rule still makes the final decision tier2.
        let review = 50 * M;
        for (scene, want_jev, amount, max, want_final) in [("1", Decision::Allow, 10 * M, 10 * M, Decision::Allow),
            ("4", Decision::Block, 20 * M, 10 * M, Decision::Block), ("5", Decision::Allow, 80 * M, 80 * M, Decision::Tier2)] {
            let a = parsed(&format!("recorded_q2_scene{scene}"));
            let ok = a.clone().unwrap();
            assert!(ok.model.starts_with("jev-") && ok.request_id.starts_with("req_"));
            assert_eq!(decide_p(&cfg(), ok.p_yes), want_jev, "scene {scene}");
            let m = mandatory_check(amount, "payee.test", "payee.test", max, review);
            assert_eq!(final_decision(&cfg(), m.0, &a), want_final, "scene {scene}");
            assert!(!receipt(scene, false, &cfg(), m, &a, None).report_authenticated);
        }
    }
    #[test] fn report_encoding_matches_contract_threshold() {
        let a = |p: f64| JevAnswer { model: "jev".into(), request_id: "r".into(), p_yes: p, input_tokens: 1, output_tokens: 1 };
        assert_eq!(report_fields(Decision::Allow, &a(0.93)).0, "owner_signed"); assert_eq!(report_fields(Decision::Allow, &a(0.93)).1, 930);
        assert_eq!(report_fields(Decision::Tier2, &a(0.95)).1, 899);
        // The report encodes the final decision: JEV allow + mandatory tier2 is signed as an escalation.
        let c = cfg(); let fd = final_decision(&c, Decision::Tier2, &Ok(a(0.98)));
        assert_eq!(report_fields(fd, &a(0.98)).1, 899);
        assert_eq!(report_fields(Decision::Block, &a(0.2)), ("external_content".into(), 1000, "jev-live;model=jev;request_id=r;p_yes=0.2000".into()));
    }
}
