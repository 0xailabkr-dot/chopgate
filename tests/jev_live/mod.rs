//! HTTP transport for live JEV calls (shared by tests and examples via `#[path]`).
//! The API key comes only from the process environment (`TYPESAFE_API_KEY`) or from a file
//! named by `JEV_KEY_FILE` (a `TYPESAFE_API_KEY=...` line). It is sent only in the
//! Authorization header and is never printed, logged, stored or returned.
#![allow(dead_code)]
use chopgate::jev_live::{self, Decision, JevAnswer, JevConfig, JevState, Receipt};
use serde_json::{json, Value};
use std::io::Write as _;
use std::time::{Duration, Instant};

pub struct Key(String);
impl Key { pub fn new(token: String) -> Self { Key(token) } }
impl std::fmt::Debug for Key { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("Key(<redacted>)") } }

/// Returns None when no key is configured. Errors never contain key material.
pub fn load_key() -> Result<Option<Key>, String> {
    if let Ok(path) = std::env::var("JEV_KEY_FILE") {
        let text = std::fs::read_to_string(&path).map_err(|_| "key file unreadable".to_string())?;
        for line in text.lines() {
            if let Some(v) = line.trim().strip_prefix("TYPESAFE_API_KEY=") {
                let v = v.trim().trim_matches('"').trim_matches('\'');
                if !v.is_empty() { return Ok(Some(Key(v.to_string()))); }
            }
        }
        return Err("key file has no TYPESAFE_API_KEY line".into());
    }
    Ok(std::env::var("TYPESAFE_API_KEY").ok().filter(|v| !v.is_empty()).map(Key))
}

/// Call counter file (JSON lines). Every HTTP attempt writes a `"phase":"attempt"` line *before*
/// the request is sent and a `"phase":"outcome"` line afterwards. Calls = attempt lines (older
/// lines without a phase count as attempts too). A missing file counts 0; an unreadable file is an
/// error, and so is a file that cannot be appended to: both fail closed (no call is made).
pub fn count_calls(path: &str) -> Result<usize, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(_) => return Err("call_log_unreadable".into()),
    };
    Ok(text.lines().filter(|l| !l.trim().is_empty()).filter(|l| {
        serde_json::from_str::<Value>(l).map(|v| v.get("phase").and_then(Value::as_str).map_or(true, |p| p == "attempt")).unwrap_or(true)
    }).count())
}
fn append_line(path: &str, v: Value) -> Result<(), String> {
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path).map_err(|_| "call_log_unwritable".to_string())?;
    writeln!(f, "{v}").and_then(|_| f.sync_all()).map_err(|_| "call_log_unwritable".to_string())
}
fn now_ms() -> u128 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0) }
fn record_attempt(path: &str, n: usize, scene: &str, endpoint: &str) -> Result<(), String> {
    append_line(path, json!({"phase": "attempt", "n": n, "unix_ms": now_ms(), "scene": scene, "endpoint": endpoint}))
}
fn record_outcome(path: &str, n: usize, scene: &str, outcome: &str, request_id: Option<&str>, ms: u128) {
    // The attempt is already counted; a failed outcome write cannot undercount.
    let _ = append_line(path, json!({"phase": "outcome", "n": n, "unix_ms": now_ms(), "scene": scene, "outcome": outcome, "request_id": request_id, "latency_ms": ms}));
}

pub struct Judged { pub receipt: Receipt, pub answer: Result<JevAnswer, String>, pub recorded: Option<Value> }

/// One JEV request (no retries). Any failure fails closed to human review.
pub async fn judge(cfg: &JevConfig, key: Option<&Key>, log: &str, scene: &str, state: &JevState, mandatory: (Decision, Vec<String>)) -> Judged {
    let start = Instant::now();
    let mut recorded = None;
    let answer: Result<JevAnswer, String> = async {
        let key = key.ok_or("key_absent")?;
        if log.is_empty() { return Err("call_log_required".to_string()); }
        let used = count_calls(log)?;
        if used >= cfg.call_budget as usize { return Err("call_budget_exhausted".to_string()); }
        let n = used + 1;
        // No redirects: a 3xx is an HTTP error (human review), so no other origin can supply p(yes).
        let client = reqwest::Client::builder().timeout(Duration::from_millis(cfg.timeout_ms)).redirect(reqwest::redirect::Policy::none()).build()
            .map_err(|_| "client_build_error".to_string())?;
        record_attempt(log, n, scene, &cfg.endpoint)?;
        let sent = client.post(&cfg.endpoint).bearer_auth(&key.0).json(&jev_live::request_body(cfg, state)).send().await;
        let resp = match sent {
            Ok(r) => r,
            Err(e) => {
                let kind = if e.is_timeout() { "timeout" } else if e.is_connect() { "connect_error" } else { "transport_error" };
                record_outcome(log, n, scene, kind, None, start.elapsed().as_millis());
                return Err(kind.to_string());
            }
        };
        let status = resp.status().as_u16();
        if resp.url().as_str() != cfg.endpoint { record_outcome(log, n, scene, "unexpected_response_url", None, start.elapsed().as_millis()); return Err("unexpected_response_url".to_string()); }
        let rid = resp.headers().get("x-typesafe-request-id").and_then(|v| v.to_str().ok()).map(String::from);
        let body = match resp.text().await {
            Ok(b) => b,
            Err(e) => { let k = if e.is_timeout() { "timeout" } else { "body_read_error" };
                record_outcome(log, n, scene, k, rid.as_deref(), start.elapsed().as_millis()); return Err(k.to_string()); }
        };
        record_outcome(log, n, scene, &format!("http_{status}"), rid.as_deref(), start.elapsed().as_millis());
        // Keep only documented response fields and the request id (no other headers).
        let v: Value = serde_json::from_str(&body).unwrap_or(Value::String("<non-json body omitted>".into()));
        let kept = if status == 200 { json!({"model": v["model"], "answers": v["answers"], "usage": v["usage"]}) } else { json!({"detail": v.get("detail").cloned().unwrap_or(Value::Null)}) };
        recorded = Some(json!({"synthetic": false, "note": "recorded live JEV response; only model/answers/usage (or detail) and the request id are kept",
            "status": status, "request_id": rid, "body": kept}));
        jev_live::parse_response(status, &body, rid.as_deref())
    }.await;
    // `receipt` sets report_authenticated only for an answer from the official endpoint.
    let live = key.is_some();
    let receipt = jev_live::receipt(scene, live, cfg, mandatory, &answer, Some(start.elapsed().as_millis()));
    Judged { receipt, answer, recorded }
}
