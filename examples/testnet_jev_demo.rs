//! NEAR-JEV-1 B-5 testnet demo: scenes 1, 4 and 5 judged by the live JEV model (TypeSafe System One).
//! Testnet only. One JEV call per scene (3 in total), each appended to the JEV_CALL_LOG counter file.
//! The JEV API key comes only from JEV_KEY_FILE or TYPESAFE_API_KEY and is never printed or stored.
//! Without a key (or on any JEV error/timeout) every scene fails closed to human review.
//! Env: RUN_TAG, WASM_PATH, OWNER_ACC, OUT_JSON, JEV_CALL_LOG, JEV_OUT_DIR; optional JEV_CONFIG
//! (default config/jev.json), JEV_KEY_FILE, GATE_BALANCE_MILLI (default 6500).
//! Negative transactions: scene 1 sends one re-pointed copy of its JEV report with the stale signature and a
//! fresh nonce (must not authenticate); scene 5 sends
//! one approve_pending signed by a different key (must fail). Scene 4's over-limit call is itself negative.
#[path = "../tests/jev_live/mod.rs"]
mod jev_live_http;
use anyhow::{anyhow, Result};
use chopgate::jev_live::{self, mandatory_check, Decision, JevConfig, JevState, MandateScope};
use chopgate::{authorization_bytes, judge_policy_bytes, judge_report_bytes, pending_decision_v2_bytes, pending_request_hash,
    signing_bytes, tier2_config_bytes, JudgePolicy, JudgeReport, Mandate, PendingItem, Permission, Tier2Config};
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::json_types::U128;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, Contract, Network, Worker};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fmt::Write as _;

const MILLI: u128 = 1_000_000_000_000_000_000_000;
const CHAIN: &str = "testnet";
const REVIEW_ABOVE: u128 = 50 * MILLI;

fn pk(key: &SigningKey) -> String { format!("ed25519:{}", bs58::encode(key.verifying_key().to_bytes()).into_string()) }
fn h(s: &str) -> String { hex::encode(Sha256::digest(s.as_bytes())) }
fn near_str(y: u128) -> String { format!("{}.{:03}", y / (1000 * MILLI), (y / MILLI) % 1000) }

struct Ctx { owner_key: SigningKey, dep: String, rows: Vec<Value>, mismatches: Vec<String>, bad_rows: std::collections::BTreeSet<usize> }
impl Ctx {
    /// Owner-domain signature by `key` (owner for settings/approvals; judge key for judge reports).
    fn sign_with(&self, key: &SigningKey, payload: &[u8]) -> String {
        let owner: near_sdk::PublicKey = pk(&self.owner_key).parse().unwrap();
        hex::encode(key.sign(&authorization_bytes(CHAIN, &self.dep, &owner, payload)).to_bytes())
    }
    fn sign(&self, payload: &[u8]) -> String { self.sign_with(&self.owner_key, payload) }
}

async fn row<N: Network + 'static>(w: &Worker<N>, ctx: &mut Ctx, scene: &str, step: &str, signer: &str,
    contract: &str, r: &ExecutionFinalResult) -> Result<Value> {
    let tx = r.outcome().transaction_hash.to_string();
    let bh = r.outcome().block_hash;
    let height = w.view_block().block_hash(bh).await?.height();
    let event_data: Vec<Value> = r.logs().iter().filter_map(|l| serde_json::from_str(l.strip_prefix("EVENT_JSON:")?).ok()).collect();
    let events: Vec<String> = event_data.iter().filter_map(|v| Some(v["event"].as_str()?.to_string())).collect();
    let (ok, result) = if r.is_success() {
        let v: Value = r.clone().json().unwrap_or(Value::Null);
        (true, match v.get("reason_code") { Some(c) => format!("success; reason_code={}", c.as_str().unwrap_or("")), None => "success".into() })
    } else {
        let mut s = String::new();
        for f in r.failures() { let _ = write!(s, "{:?}; ", f.clone().into_result().err()); }
        (false, format!("failure: {}", s))
    };
    let v = json!({"scene":scene,"step":step,"signer":signer,"contract":contract,"tx":tx,
        "block_hash":bh.to_string(),"block_height":height,"tx_success":ok,"result":result,"events":events,"event_data":event_data,
        "explorer":format!("https://testnet.nearblocks.io/txns/{tx}")});
    println!("ROW {}", v);
    ctx.rows.push(v.clone());
    if let Ok(p) = std::env::var("OUT_JSON") { std::fs::write(p, serde_json::to_string_pretty(&ctx.rows)?)?; }
    Ok(v)
}
fn expect(ctx: &mut Ctx, v: &Value, want: &str) {
    let ok = v["tx_success"].as_bool().unwrap_or(false);
    let res = v["result"].as_str().unwrap_or("");
    let good = match want.split_once(':') {
        Some(("reason", code)) => ok && res == format!("success; reason_code={code}"),
        Some(("fail", text)) => !ok && res.contains(text),
        _ => ok,
    };
    println!("EXPECT {} | {} | want={} | {}", v["scene"].as_str().unwrap_or(""), v["step"].as_str().unwrap_or(""), want, if good { "OK" } else { "MISMATCH" });
    if !good { ctx.mismatches.push(format!("{} / {} want {} got {}", v["scene"], v["step"], want, res)); ctx.bad_rows.insert(ctx.rows.len()); }
}
fn check(ctx: &mut Ctx, what: &str, good: bool, detail: String) {
    println!("ASSERT {what} | {detail} | {}", if good { "OK" } else { "MISMATCH" });
    if !good { ctx.mismatches.push(format!("{what}: {detail}")); ctx.bad_rows.insert(ctx.rows.len()); }
}
fn event_data<'a>(v: &'a Value, name: &str) -> Option<&'a Value> {
    v["event_data"].as_array()?.iter().find(|e| e["event"] == name).map(|e| &e["data"][0])
}
fn mandate(serial: u64, agent: &Account, payee: &Account, instr: &str, max: u128, budget: u128) -> Mandate {
    Mandate { serial, agent: agent.id().as_str().parse().unwrap(), entries: vec![Permission { action: "transfer".into(),
        target: payee.id().to_string(), max_amount: U128(max), instruction_hash: h(instr) }],
        budget: U128(budget), expires_at: 4_000_000_000_000_000_000, parent_serial: None }
}
fn request_hash(serial: u64, target: &str, amount: u128, instr: &str, caller: &str) -> Result<String> {
    let caller: near_sdk::AccountId = caller.parse()?;
    let fields = near_sdk::borsh::to_vec(&(serial, "transfer", target, U128(amount), &h(instr), "owner_chat", &caller))?;
    Ok(hex::encode(Sha256::digest(fields)))
}

#[tokio::main]
async fn main() -> Result<()> {
    let home = std::env::var("HOME")?;
    let tag = std::env::var("RUN_TAG").map_err(|_| anyhow!("RUN_TAG required"))?;
    let wasm = std::fs::read(std::env::var("WASM_PATH")?)?;
    let owner_acc = std::env::var("OWNER_ACC")?;
    let call_log = std::env::var("JEV_CALL_LOG").map_err(|_| anyhow!("JEV_CALL_LOG required"))?;
    let out_dir = std::env::var("JEV_OUT_DIR").map_err(|_| anyhow!("JEV_OUT_DIR required"))?;
    let cfg = JevConfig::from_file(std::env::var("JEV_CONFIG").unwrap_or_else(|_| "config/jev.json".into())).map_err(anyhow::Error::msg)?;
    let key = jev_live_http::load_key().map_err(anyhow::Error::msg)?;
    let calls_before = jev_live_http::count_calls(&call_log).map_err(anyhow::Error::msg)?;
    println!("JEV MODE: live, model={}, allow_min={}, tier2_min={}, timeout_ms={}, key_present={}, question={}",
        cfg.model, cfg.allow_min, cfg.tier2_min, cfg.timeout_ms, key.is_some(), jev_live::QUESTION_VERSION);
    let cred = format!("{home}/.near-credentials/testnet");
    let w = near_workspaces::testnet().await?;
    let load = |id: &str| -> Result<Account> {
        let v: Value = serde_json::from_str(&std::fs::read_to_string(format!("{cred}/{id}.json"))?)?;
        let sk: SecretKey = v["private_key"].as_str().or(v["secret_key"].as_str()).ok_or(anyhow!("no key field"))?.parse().map_err(|_| anyhow!("key parse"))?;
        Ok(Account::from_secret_key(id.parse()?, sk, &w)) };
    let owner = load(&owner_acc)?;
    let mut ctx = Ctx { owner_key: SigningKey::generate(&mut rand::rngs::OsRng), dep: String::new(), rows: vec![], mismatches: vec![], bad_rows: Default::default() };
    // In-memory judge key for this run only (registered by an owner-signed set_judge_policy).
    let judge_key = SigningKey::generate(&mut rand::rngs::OsRng);
    println!("OWNER_SIGNING_PUBKEY {}", pk(&ctx.owner_key));
    println!("JUDGE_SIGNING_PUBKEY {}", pk(&judge_key));

    let mk = |n: String, bal: u128| { let o = owner.clone(); async move {
        let r = o.create_subaccount(&n).initial_balance(NearToken::from_yoctonear(bal)).keys(SecretKey::from_random(KeyType::ED25519)).transact().await?;
        Ok::<_, anyhow::Error>(r) } };
    let gate_milli: u128 = std::env::var("GATE_BALANCE_MILLI").ok().and_then(|v| v.parse().ok()).unwrap_or(6_500);
    let g = mk(format!("gate{tag}"), gate_milli * MILLI).await?; let gd = g.details.clone(); let gate = g.into_result()?;
    gate.store_credentials(&cred).await?;
    { let v = row(&w, &mut ctx, "setup", "create gate subaccount", owner.id().as_str(), gate.id().as_str(), &gd).await?; expect(&mut ctx, &v, "success"); }
    let a = mk(format!("agent{tag}"), 500 * MILLI).await?; let ad = a.details.clone(); let agent = a.into_result()?;
    agent.store_credentials(&cred).await?;
    { let v = row(&w, &mut ctx, "setup", "create agent subaccount", owner.id().as_str(), agent.id().as_str(), &ad).await?; expect(&mut ctx, &v, "success"); }
    let p = mk(format!("payee{tag}"), 100 * MILLI).await?; let pd = p.details.clone(); let payee = p.into_result()?;
    payee.store_credentials(&cred).await?;
    { let v = row(&w, &mut ctx, "setup", "create payee subaccount", owner.id().as_str(), payee.id().as_str(), &pd).await?; expect(&mut ctx, &v, "success"); }

    let d = gate.deploy(&wasm).await?; let dd = d.details.clone(); let c: Contract = d.into_result()?;
    let gid = c.id().to_string();
    { let v = row(&w, &mut ctx, "setup", "deploy wasm", &gid, &gid, &dd).await?; expect(&mut ctx, &v, "success"); }
    let r = c.call("new").args_json(json!({"owner_public_key":pk(&ctx.owner_key),"chain_id":CHAIN,"deployment_id":format!("near-jev-1-{tag}")})).gas(Gas::from_tgas(100)).transact().await?;
    { let v = row(&w, &mut ctx, "setup", "init new()", &gid, &gid, &r).await?; expect(&mut ctx, &v, "success"); }
    let (_, dep, _): (String, String, near_sdk::PublicKey) = c.view("signature_domain").await?.json()?;
    ctx.dep = dep.clone(); println!("DEPLOYMENT_ID {dep}");
    let r = owner.call(c.id(), "deposit").deposit(NearToken::from_yoctonear(300 * MILLI)).gas(Gas::from_tgas(30)).transact().await?;
    { let v = row(&w, &mut ctx, "setup", "deposit 0.3 NEAR escrow", owner.id().as_str(), &gid, &r).await?; expect(&mut ctx, &v, "success"); }
    let t2 = Tier2Config { config_nonce: 1, amount_threshold: U128(REVIEW_ABOVE), pending_ttl_ns: 3_600_000_000_000,
        new_payee_check: false, trusted_sources: vec![], known_payees: vec![], denied_targets: vec![] };
    let sig = ctx.sign(&tier2_config_bytes(&gid.parse()?, &t2));
    let r = agent.call(c.id(), "set_tier2_config").args_json(json!({"config":t2,"signature":sig})).gas(Gas::from_tgas(30)).transact().await?;
    { let v = row(&w, &mut ctx, "setup", "set_tier2_config threshold 0.05 NEAR (owner-signed)", agent.id().as_str(), &gid, &r).await?; expect(&mut ctx, &v, "success"); }
    let policy = JudgePolicy { nonce: 1, keys: vec![pk(&judge_key).parse()?] };
    let sig = ctx.sign(&judge_policy_bytes(&gid.parse()?, &policy));
    let r = agent.call(c.id(), "set_judge_policy").args_json(json!({"policy":policy,"signature":sig})).gas(Gas::from_tgas(30)).transact().await?;
    { let v = row(&w, &mut ctx, "setup", "set_judge_policy: register JEV judge key (owner-signed)", agent.id().as_str(), &gid, &r).await?; expect(&mut ctx, &v, "success"); }

    let instr = |s: u64, amt: &str| format!("transfer {amt} NEAR to {} (serial {s})", payee.id());
    let specs: [(u64, &str, u128, u128); 4] = [(1, "0.01", 10 * MILLI, 50 * MILLI), (11, "0.01", 10 * MILLI, 50 * MILLI),
        (4, "0.01", 10 * MILLI, 50 * MILLI), (5, "0.08", 80 * MILLI, 100 * MILLI)];
    for (s, amt, max, bud) in specs {
        let m = mandate(s, &agent, &payee, &instr(s, amt), max, bud);
        let sig = ctx.sign(&signing_bytes(&gid.parse()?, &m));
        let r = agent.call(c.id(), "register").args_json(json!({"mandate":m,"signer_public_key":pk(&ctx.owner_key),"signature":sig})).gas(Gas::from_tgas(50)).transact().await?;
        { let v = row(&w, &mut ctx, "setup", &format!("register mandate serial {s} (owner-signed)"), agent.id().as_str(), &gid, &r).await?; expect(&mut ctx, &v, "reason:allowed"); }
    }

    let bal = |a: Account| async move { Ok::<u128, anyhow::Error>(a.view_account().await?.balance.as_yoctonear()) };
    let esc = |c: Contract| async move { let e: U128 = c.view("escrow_balance").await?.json()?; Ok::<u128, anyhow::Error>(e.0) };
    let mut nonce = 0u64;
    let mut receipts = vec![];
    // Judge one scene with live JEV, sign a report for the contract, and call authorize_and_pay_dual.
    // Returns (row, final decision, report sent).
    macro_rules! judged_pay { ($scene:expr, $serial:expr, $amount:expr, $max:expr, $amt_str:expr, $prev:expr) => {{
        let target = payee.id().to_string();
        let state = JevState { amount_near: near_str($amount), recipient: target.clone(), previous_decision: $prev.to_string(),
            mandate_scope: MandateScope { action: "transfer".into(), target: target.clone(), max_amount_near: near_str($max), human_review_above_near: near_str(REVIEW_ABOVE) } };
        let mandatory = mandatory_check($amount, &target, &target, $max, REVIEW_ABOVE);
        let j = jev_live_http::judge(&cfg, key.as_ref(), &call_log, &format!("demo-{}", $scene), &state, mandatory).await;
        std::fs::write(format!("{out_dir}/receipt-demo-scene{}.json", $scene), serde_json::to_string_pretty(&j.receipt)?)?;
        if let Some(rec) = &j.recorded { std::fs::write(format!("{out_dir}/recorded-demo-scene{}.json", $scene), serde_json::to_string_pretty(rec)?)?; }
        println!("JEV scene={} p_yes={:?} model={:?} request_id={:?} jev={} mandatory={} {:?} final={} err={:?}", $scene, j.receipt.p_yes,
            j.receipt.model_version, j.receipt.request_id, j.receipt.jev_decision, j.receipt.mandatory_decision, j.receipt.mandatory_reasons,
            j.receipt.final_decision, j.receipt.error);
        let fd = match j.receipt.final_decision.as_str() { "allow" => Decision::Allow, "tier2" => Decision::Tier2, "block" => Decision::Block, _ => Decision::HumanReview };
        let instruction = instr($serial, $amt_str);
        let report: Option<JudgeReport> = match &j.answer {
            Ok(a) => {
                let (label, q, mode) = jev_live::report_fields(fd, a);
                nonce += 1;
                let now_ns = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos() as u64;
                let mut r = JudgeReport { expires_at: now_ns + 1_800_000_000_000, nonce, key_generation: 1, source_label: label, source_q_permille: q,
                    instruction_hash: h(&instruction), category: jev_live::REPORT_CATEGORY.into(), category_q_permille: 1000, mode,
                    signer_public_key: Some(pk(&judge_key)), signature: None,
                    request_hash: request_hash($serial, &target, $amount, &instruction, agent.id().as_str())? };
                r.signature = Some(ctx.sign_with(&judge_key, &judge_report_bytes(&gid.parse()?, &r)));
                Some(r)
            }
            Err(_) => None,
        };
        receipts.push(j.receipt.clone());
        let r = agent.call(c.id(), "authorize_and_pay_dual").args_json(json!({"serial":$serial,"action":"transfer","target":target,
            "amount":$amount.to_string(),"instruction":instruction,"source":"owner_chat","judge_report":report,"judge_hint":fd.hint()}))
            .gas(Gas::from_tgas(150)).transact().await?;
        (r, fd, report, j.answer.is_ok())
    }}}

    // Scene 1: normal payment judged by JEV.
    let (b0, e0) = (bal(payee.clone()).await?, esc(c.clone()).await?);
    let (r, fd1, rep1, live1) = judged_pay!("1", 1u64, 10 * MILLI, 10 * MILLI, "0.01", "none");
    let want1 = match fd1 { Decision::Allow => "reason:allowed", Decision::Block => "reason:tier2_deny", _ => "reason:tier2_escalate" };
    let v1 = row(&w, &mut ctx, "1 정상 통과 (JEV)", "authorize_and_pay_dual 0.01 NEAR with signed live JEV report", agent.id().as_str(), &gid, &r).await?;
    expect(&mut ctx, &v1, want1);
    let t1 = event_data(&v1, "tier2_decision").cloned().unwrap_or(Value::Null);
    check(&mut ctx, "scene1 tier2_decision.report_authenticated matches live JEV answer", t1["report_authenticated"] == json!(live1), format!("event={t1}"));
    if let Some(rep) = &rep1 { check(&mut ctx, "scene1 on-chain mode carries JEV request id", t1["mode"] == json!(rep.mode), format!("mode={}", t1["mode"])); }
    if fd1 == Decision::Allow {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        let (b1, e1) = (bal(payee.clone()).await?, esc(c.clone()).await?);
        check(&mut ctx, "scene1 payout_settled event", event_data(&v1, "payout_settled").is_some(), format!("events={}", v1["events"]));
        check(&mut ctx, "scene1 payee +0.01 NEAR", b1.checked_sub(b0) == Some(10 * MILLI), format!("delta={}", b1 as i128 - b0 as i128));
        check(&mut ctx, "scene1 escrow -0.01 NEAR", e0.checked_sub(e1) == Some(10 * MILLI), format!("before={e0} after={e1}"));
    }
    // Scene 1 negative (one tx): the scene-1 report re-pointed at mandate serial 11 with p raised and a fresh
    // nonce, keeping the stale signature, so only the signature check can reject it (not nonce replay).
    if let Some(mut forged) = rep1.clone() {
        nonce += 1; forged.nonce = nonce;
        forged.request_hash = request_hash(11, payee.id().as_str(), 10 * MILLI, &instr(11, "0.01"), agent.id().as_str())?;
        forged.instruction_hash = h(&instr(11, "0.01")); forged.source_q_permille = 1000;
        let r = agent.call(c.id(), "authorize_and_pay_dual").args_json(json!({"serial":11,"action":"transfer","target":payee.id(),
            "amount":(10 * MILLI).to_string(),"instruction":instr(11, "0.01"),"source":"owner_chat","judge_report":forged,"judge_hint":"pass"}))
            .gas(Gas::from_tgas(150)).transact().await?;
        let v = row(&w, &mut ctx, "1- 위조 JEV 보고", "authorize_and_pay_dual serial 11 with a re-pointed copy of the scene-1 JEV report (stale signature, fresh nonce)", agent.id().as_str(), &gid, &r).await?;
        expect(&mut ctx, &v, "reason:tier2_escalate");
        let t = event_data(&v, "tier2_decision").cloned().unwrap_or(Value::Null);
        check(&mut ctx, "scene1- forged report not authenticated", t["report_authenticated"] == json!(false), format!("event={t}"));
    } else { check(&mut ctx, "scene1 negative ran", false, "SKIP: no live JEV report to re-point".into()); }

    // Scene 4: over the entry limit. Mandatory Tier 1 rule decides; JEV opinion is recorded but cannot override.
    let (r, fd4, _rep4, _) = judged_pay!("4", 4u64, 20 * MILLI, 10 * MILLI, "0.01", fd1.as_str());
    let v4 = row(&w, &mut ctx, "4 한도 초과 차단 (JEV)", "authorize_and_pay_dual 0.02 NEAR over 0.01 entry limit with live JEV report", agent.id().as_str(), &gid, &r).await?;
    expect(&mut ctx, &v4, "reason:entry_limit_exceeded");
    check(&mut ctx, "scene4 final decision is block (mandatory rule first)", fd4 == Decision::Block, format!("final={}", fd4.as_str()));
    check(&mut ctx, "scene4 no payout", event_data(&v4, "payout_settled").is_none(), format!("events={}", v4["events"]));

    // Scene 5: above the human-review amount -> pending, then owner approval.
    let e5 = esc(c.clone()).await?;
    let (r, fd5, _rep5, live5) = judged_pay!("5", 5u64, 80 * MILLI, 80 * MILLI, "0.08", fd4.as_str());
    let want5 = if fd5 == Decision::Block { "reason:tier2_deny" } else { "reason:tier2_escalate" };
    let v5a = row(&w, &mut ctx, "5 사람 승인 (JEV)", "authorize_and_pay_dual 0.08 NEAR above 0.05 human-review amount with live JEV report", agent.id().as_str(), &gid, &r).await?;
    expect(&mut ctx, &v5a, want5);
    let t5 = event_data(&v5a, "tier2_decision").cloned().unwrap_or(Value::Null);
    check(&mut ctx, "scene5 tier2_decision.report_authenticated matches live JEV answer", t5["report_authenticated"] == json!(live5), format!("event={t5}"));
    if fd5 != Decision::Block {
        let items: Vec<PendingItem> = c.view("pending_items").await?.json()?;
        let item = items.iter().find(|p| p.serial == 5).ok_or(anyhow!("no pending for serial 5"))?.clone();
        let payload = pending_decision_v2_bytes(&gid.parse()?, item.id, true, &pending_request_hash(&item));
        let esc_before = esc(c.clone()).await?;
        let other = SigningKey::generate(&mut rand::rngs::OsRng);
        let nsig = ctx.sign_with(&other, &payload);
        let r = agent.call(c.id(), "approve_pending").args_json(json!({"id":item.id,"signature":nsig})).gas(Gas::from_tgas(150)).transact().await?;
        { let v = row(&w, &mut ctx, "5- 부정 서명", "approve_pending signed by a different key over the exact payload (expect failure)", agent.id().as_str(), &gid, &r).await?; expect(&mut ctx, &v, "fail:invalid pending signature"); }
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        let still: Vec<PendingItem> = c.view("pending_items").await?.json()?;
        let (open, same) = (still.iter().any(|p| p.id == item.id), esc_before == esc(c.clone()).await?);
        check(&mut ctx, "after negative: pending still open, escrow unchanged", open && same, format!("pending_still_open={open} escrow_unchanged={same}"));
        let sig = ctx.sign(&payload);
        let b0 = bal(payee.clone()).await?;
        let r = agent.call(c.id(), "approve_pending").args_json(json!({"id":item.id,"signature":sig})).gas(Gas::from_tgas(150)).transact().await?;
        let v5 = row(&w, &mut ctx, "5 사람 승인 뒤 통과", "approve_pending with owner signature over request hash", agent.id().as_str(), &gid, &r).await?;
        expect(&mut ctx, &v5, "success");
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        let b1 = bal(payee.clone()).await?; let e_after = esc(c.clone()).await?;
        let pa = event_data(&v5, "pending_approved");
        let pa_ok = pa.is_some_and(|d| d["id"] == json!(item.id) && d["serial"] == json!(5) && d["target"] == json!(payee.id().to_string())
            && d["amount"] == json!((80 * MILLI).to_string()));
        check(&mut ctx, "scene5 pending_approved(id,serial,target,amount)", pa_ok, format!("data={}", pa.cloned().unwrap_or(Value::Null)));
        check(&mut ctx, "scene5 payout_settled event", event_data(&v5, "payout_settled").is_some(), format!("events={}", v5["events"]));
        check(&mut ctx, "scene5 payee +0.08 NEAR", b1.checked_sub(b0) == Some(80 * MILLI), format!("delta={}", b1 as i128 - b0 as i128));
        check(&mut ctx, "scene5 escrow -0.08 NEAR (reserved at escalation, not refunded)", e5.checked_sub(e_after) == Some(80 * MILLI), format!("scene5_start={e5} after_approval={e_after}"));
    } else { check(&mut ctx, "scene5 approval steps ran", false, "SKIP: final decision is block, approval path not exercised".into()); }

    std::fs::write(format!("{out_dir}/receipts-demo.json"), serde_json::to_string_pretty(&receipts)?)?;
    if let Ok(p) = std::env::var("OUT_JSON") { std::fs::write(p, serde_json::to_string_pretty(&ctx.rows)?)?; }
    let bad_rows = ctx.bad_rows.iter().filter(|&&i| i >= 1 && i <= ctx.rows.len()).count();
    let calls_after = jev_live_http::count_calls(&call_log).map_err(anyhow::Error::msg)?;
    println!("JEV DEMO RESULT: {}/{} rows as expected, {} mismatch line(s), jev_calls_this_run={} (from JEV_CALL_LOG), receipts={}", ctx.rows.len().saturating_sub(bad_rows),
        ctx.rows.len(), ctx.mismatches.len(), calls_after.saturating_sub(calls_before), receipts.len());
    if !ctx.mismatches.is_empty() {
        for m in &ctx.mismatches { println!("MISMATCH {m}"); }
        return Err(anyhow!("{} expectation mismatch(es)", ctx.mismatches.len()));
    }
    Ok(())
}
