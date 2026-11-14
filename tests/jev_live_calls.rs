//! JEV transport tests. Offline tests use a local one-shot HTTP stub (no key, no network).
//! The live test runs only when JEV_LIVE=1 and a key is configured; it makes exactly one call
//! per scene (1, 4, 5) and appends every attempt to the JEV_CALL_LOG counter file.
#[path = "jev_live/mod.rs"]
mod jev_live_http;
use chopgate::jev_live::{mandatory_check, Decision, JevConfig, JevState, MandateScope};
use jev_live_http::{count_calls, judge, Key};
use std::io::{Read, Write};

const M: u128 = 1_000_000_000_000_000_000_000;
fn near(y: u128) -> String { format!("{}.{:03}", y / (1000 * M), (y / M) % 1000) }
pub fn scene_state(scene: &str) -> (JevState, (Decision, Vec<String>)) {
    let (amount, max, review) = match scene { "1" => (10 * M, 10 * M, 50 * M), "4" => (20 * M, 10 * M, 50 * M), _ => (80 * M, 80 * M, 50 * M) };
    let st = JevState { amount_near: near(amount), recipient: "payee.example.testnet".into(), previous_decision: "none".into(),
        mandate_scope: MandateScope { action: "transfer".into(), target: "payee.example.testnet".into(), max_amount_near: near(max), human_review_above_near: near(review) } };
    let m = mandatory_check(amount, &st.recipient, &st.mandate_scope.target, max, review);
    (st, m)
}
fn cfg_with(endpoint: &str, timeout_ms: u64) -> JevConfig { let mut c = JevConfig::from_file("config/jev.json").unwrap(); c.endpoint = endpoint.into(); c.timeout_ms = timeout_ms; c }
/// Offline placeholder token for the local stub; never a real key.
fn fake_key() -> Key { Key::new("offline-test-token".into()) }

/// One-shot local HTTP stub on an OS-assigned port; `reply=None` accepts and never answers.
fn stub(reply: Option<(u16, &'static str, Option<&'static str>)>) -> String {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap(); let addr = l.local_addr().unwrap();
    std::thread::spawn(move || { if let Ok((mut s, _)) = l.accept() {
        let mut buf = [0u8; 8192]; let _ = s.read(&mut buf);
        match reply { Some((code, body, rid)) => {
            let rid = rid.map(|r| format!("x-typesafe-request-id: {r}\r\n")).unwrap_or_default();
            let _ = write!(s, "HTTP/1.1 {code} X\r\ncontent-type: application/json\r\n{rid}content-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
        } None => std::thread::sleep(std::time::Duration::from_secs(5)) } } });
    format!("http://{addr}/v1/systemone")
}
fn counter() -> String { let p = std::env::temp_dir().join(format!("jevcount-{}-{}", std::process::id(), rand::random::<u32>())); p.to_string_lossy().into() }

#[tokio::test]
async fn stub_allow_scene1_and_mandatory_scene4() {
    let body = r#"{"model":"jev-stub","answers":{"pay_automatically":{"type":"noul","noul":0.96}},"usage":{"input_tokens":9,"output_tokens":1}}"#;
    let log = counter();
    let (st, m) = scene_state("1"); let k = fake_key();
    let j = judge(&cfg_with(&stub(Some((200, body, Some("stub-req-1")))), 3000), Some(&k), &log, "1", &st, m).await;
    assert_eq!(j.receipt.final_decision, "allow"); assert_eq!(j.receipt.request_id.as_deref(), Some("stub-req-1"));
    assert!(!j.receipt.report_authenticated && j.receipt.source == "stub", "a stub answer never authenticates");
    let (st, m) = scene_state("4");
    let j = judge(&cfg_with(&stub(Some((200, body, Some("stub-req-4")))), 3000), Some(&k), &log, "4", &st, m).await;
    assert_eq!((j.receipt.jev_decision.as_str(), j.receipt.final_decision.as_str()), ("allow", "block"), "mandatory rule wins");
    assert_eq!(count_calls(&log), Ok(2));
    let t = std::fs::read_to_string(&log).unwrap();
    assert_eq!(t.lines().count(), 4, "attempt + outcome line per call");
    assert!(t.lines().next().unwrap().contains(r#""phase":"attempt""#));
    let _ = std::fs::remove_file(&log);
}
#[tokio::test]
async fn stub_failures_fail_closed() {
    let log = counter(); let k = fake_key(); let (st, m) = scene_state("1");
    for (reply, want) in [(Some((401, r#"{"detail":"bad key"}"#, Some("r401"))), "http_status_401"),
        (Some((529, r#"{"detail":"Overloaded"}"#, None)), "http_status_529"),
        (Some((200, "not json", Some("rbad"))), "malformed_json"),
        (Some((200, r#"{"model":"m","answers":{"pay_automatically":{"type":"noul","noul":0.99}},"usage":{"input_tokens":1,"output_tokens":1}}"#, None)), "missing_request_id"),
        (Some((307, r#"{"detail":"moved"}"#, Some("r307"))), "http_status_307"),
        (None, "timeout")] {
        let j = judge(&cfg_with(&stub(reply), 400), Some(&k), &log, "1", &st, m.clone()).await;
        assert_eq!(j.answer.as_ref().err().map(String::as_str), Some(want));
        assert_eq!(j.receipt.final_decision, "human_review"); assert!(!j.receipt.report_authenticated);
    }
    // No key: no HTTP attempt, human review.
    assert_eq!(count_calls(&log), Ok(6), "every HTTP attempt is counted, including timeouts");
    let before = std::fs::read_to_string(&log).map(|t| t.lines().count()).unwrap_or(0);
    let j = judge(&cfg_with("http://127.0.0.1:9/v1/systemone", 400), None, &log, "1", &st, m.clone()).await;
    assert_eq!(j.answer.err().as_deref(), Some("key_absent")); assert_eq!(j.receipt.final_decision, "human_review");
    assert_eq!(std::fs::read_to_string(&log).map(|t| t.lines().count()).unwrap_or(0), before);
    let _ = std::fs::remove_file(&log);
}
#[tokio::test]
async fn call_budget_enforced() {
    let log = counter(); std::fs::write(&log, "{}\n".repeat(10)).unwrap();
    let (st, m) = scene_state("1"); let k = fake_key();
    let j = judge(&cfg_with("http://127.0.0.1:9/v1/systemone", 400), Some(&k), &log, "1", &st, m).await;
    assert_eq!(j.answer.err().as_deref(), Some("call_budget_exhausted"));
    assert_eq!(std::fs::read_to_string(&log).unwrap().lines().count(), 10, "no extra attempt recorded");
    let _ = std::fs::remove_file(&log);
}
#[tokio::test]
async fn unusable_call_log_fails_closed() {
    let (st, m) = scene_state("1"); let k = fake_key();
    // Unwritable: parent directory does not exist. The stub would answer allow, but no request is sent.
    let body = r#"{"model":"jev-stub","answers":{"pay_automatically":{"type":"noul","noul":0.99}},"usage":{"input_tokens":1,"output_tokens":1}}"#;
    let missing = std::env::temp_dir().join(format!("jev-no-dir-{}", rand::random::<u32>())).join("calls.jsonl");
    let j = judge(&cfg_with(&stub(Some((200, body, Some("r")))), 400), Some(&k), missing.to_str().unwrap(), "1", &st, m.clone()).await;
    assert_eq!(j.answer.err().as_deref(), Some("call_log_unwritable")); assert_eq!(j.receipt.final_decision, "human_review");
    // Unreadable: the path is a directory.
    let dir = std::env::temp_dir().to_string_lossy().to_string();
    let j = judge(&cfg_with("http://127.0.0.1:9/v1/systemone", 400), Some(&k), &dir, "1", &st, m).await;
    assert_eq!(j.answer.err().as_deref(), Some("call_log_unreadable")); assert_eq!(j.receipt.final_decision, "human_review");
}

/// Live: JEV_LIVE=1 plus a key (JEV_KEY_FILE or TYPESAFE_API_KEY) plus JEV_CALL_LOG and JEV_OUT_DIR.
#[tokio::test]
async fn live_scenes_1_4_5_once_each() {
    if std::env::var("JEV_LIVE").ok().as_deref() != Some("1") { println!("JEV LIVE SKIP: JEV_LIVE!=1"); return; }
    let Some(key) = jev_live_http::load_key().expect("key source") else { println!("JEV LIVE SKIP: no key"); return; };
    let cfg = JevConfig::from_file("config/jev.json").unwrap();
    let out = std::env::var("JEV_OUT_DIR").expect("JEV_OUT_DIR");
    let log = std::env::var("JEV_CALL_LOG").expect("JEV_CALL_LOG");
    for scene in ["1", "4", "5"] {
        let (st, m) = scene_state(scene);
        let before = count_calls(&log).expect("call log");
        let j = judge(&cfg, Some(&key), &log, &format!("live-test-{scene}"), &st, m).await;
        assert_eq!(count_calls(&log).expect("call log"), before + 1, "exactly one counted attempt per scene");
        std::fs::write(format!("{out}/receipt-live-test-{scene}.json"), serde_json::to_string_pretty(&j.receipt).unwrap()).unwrap();
        if let Some(r) = &j.recorded { std::fs::write(format!("{out}/recorded-live-test-{scene}.json"), serde_json::to_string_pretty(r).unwrap()).unwrap(); }
        println!("JEV LIVE scene={scene} final={} jev={} p_yes={:?} model={:?} request_id={:?} err={:?}", j.receipt.final_decision,
            j.receipt.jev_decision, j.receipt.p_yes, j.receipt.model_version, j.receipt.request_id, j.receipt.error);
        let a = j.answer.as_ref().expect("live JEV answer");
        assert!(j.receipt.report_authenticated && (0.0..=1.0).contains(&a.p_yes) && !a.request_id.is_empty());
        if scene == "4" { assert_eq!(j.receipt.final_decision, "block", "mandatory entry limit"); }
        if scene == "5" { assert_ne!(j.receipt.final_decision, "allow", "amount above review threshold"); }
    }
}
