/* ChopGate C1 verify page. Static, no build step. Relative paths only. */
(function () {
  "use strict";

  var ARCHIVAL = "https://archival-rpc.testnet.near.org";
  var EXPLORER = "https://testnet.nearblocks.io/txns/";
  var DATA_URL = "./data/scene-txs.json";
  var I18N = { en: "./i18n/en.json", ko: "./i18n/ko.json" };
  var B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  var TIMEOUT_MS = 15000;

  var state = {
    lang: "en",
    strings: null,
    recorded: null,
    source: "loading",
    liveRows: null,
    liveHashes: null
  };

  function $(id) { return document.getElementById(id); }

  function loadJson(url) {
    return fetch(url, { cache: "no-cache" }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
      return res.json();
    });
  }

  function sha256HexToBase58(hex) {
    if (!hex || !/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2) return "";
    var bytes = new Uint8Array(hex.length / 2);
    for (var i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    var zeros = 0;
    while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
    var digits = [0];
    for (var b = zeros; b < bytes.length; b++) {
      var carry = bytes[b];
      for (var j = 0; j < digits.length; j++) {
        carry += digits[j] << 8;
        digits[j] = carry % 58;
        carry = (carry / 58) | 0;
      }
      while (carry > 0) {
        digits.push(carry % 58);
        carry = (carry / 58) | 0;
      }
    }
    var out = "";
    for (var z = 0; z < zeros; z++) out += "1";
    for (var k = digits.length - 1; k >= 0; k--) out += B58[digits[k]];
    return out;
  }

  function yoctoToNear(yocto) {
    if (yocto == null || yocto === "") return "0";
    var s = String(yocto);
    if (!/^[0-9]+$/.test(s)) return s;
    if (s === "0") return "0";
    var pad = s.padStart(25, "0");
    var whole = pad.slice(0, pad.length - 24).replace(/^0+(?=\d)/, "");
    var frac = pad.slice(pad.length - 24).replace(/0+$/, "");
    return frac ? whole + "." + frac : whole;
  }

  function shortHash(h) {
    if (!h) return "";
    return h.length <= 12 ? h : h.slice(0, 8) + "…";
  }

  function explorerLink(hash) {
    var a = document.createElement("a");
    a.href = EXPLORER + hash;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = shortHash(hash);
    a.title = hash;
    return a;
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function rpcOnce(method, params) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
    return fetch(ARCHIVAL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "c1", method: method, params: params }),
      signal: ctrl.signal
    }).then(function (res) {
      if (!res.ok) throw new Error("RPC HTTP " + res.status);
      return res.json();
    }).then(function (body) {
      if (!body || body.error) throw new Error("RPC error");
      return body.result;
    }).finally(function () { clearTimeout(timer); });
  }

  function rpc(method, params) {
    var attempt = 0;
    function go() {
      return rpcOnce(method, params).catch(function (err) {
        attempt += 1;
        if (attempt >= 3) throw err;
        return delay(400 * attempt).then(go);
      });
    }
    return go();
  }

  function mapPool(items, limit, fn) {
    var i = 0;
    var out = new Array(items.length);
    function next() {
      if (i >= items.length) return Promise.resolve();
      var idx = i++;
      return Promise.resolve(fn(items[idx], idx)).then(function (val) {
        out[idx] = val;
      }).then(next);
    }
    var workers = [];
    for (var w = 0; w < Math.min(limit, items.length); w++) workers.push(next());
    return Promise.all(workers).then(function () { return out; });
  }

  function b64Json(s) {
    if (!s) return null;
    try {
      var bin = atob(s);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var text = new TextDecoder("utf-8").decode(bytes);
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  function parseMode(str) {
    var out = { present: false, mode: "none" };
    if (!str || typeof str !== "string") return out;
    var parts = str.split(";");
    var map = {};
    parts.forEach(function (p) {
      var i = p.indexOf("=");
      if (i === -1) {
        if (p && !map.mode) map.mode = p;
      } else {
        map[p.slice(0, i)] = p.slice(i + 1);
      }
    });
    if (map.mode === "jev-live" || str.indexOf("jev-live") === 0) {
      out.present = true;
      out.mode = "jev-live";
      if (map.model) out.model = map.model;
      if (map.p_yes) out.p_yes = String(map.p_yes).replace(/0+$/, "").replace(/\.$/, "") || map.p_yes;
      if (map.request_id) out.request_id = map.request_id;
    } else if (map.mode) {
      out.mode = map.mode;
    }
    return out;
  }

  function collectEvents(result) {
    var events = [];
    var outcomes = result.receipts_outcome || [];
    for (var i = 0; i < outcomes.length; i++) {
      var logs = (((outcomes[i] || {}).outcome) || {}).logs || [];
      for (var j = 0; j < logs.length; j++) {
        var line = logs[j];
        if (typeof line === "string" && line.indexOf("EVENT_JSON:") !== -1) {
          try { events.push(JSON.parse(line.split("EVENT_JSON:")[1])); }
          catch (e) { /* ignore malformed log line */ }
        }
      }
    }
    return events;
  }

  function firstEvent(events, name) {
    for (var i = 0; i < events.length; i++) {
      if (events[i] && events[i].event === name) return events[i];
    }
    return null;
  }

  function eventData(ev) {
    if (!ev) return null;
    var d = ev.data;
    if (Array.isArray(d) && d.length) return d[0];
    return d || null;
  }

  function payoutFromResult(result, events) {
    var settled = eventData(firstEvent(events, "payout_settled"));
    if (settled && settled.amount) {
      return { yocto: String(settled.amount), payee: settled.recipient || null };
    }
    var receipts = result.receipts || [];
    for (var i = 0; i < receipts.length; i++) {
      var r = receipts[i];
      var pred = r.predecessor_id;
      if (pred === "system") continue;
      var rec = r.receipt;
      var actions = rec && rec.Action && rec.Action.actions;
      if (!actions) continue;
      for (var j = 0; j < actions.length; j++) {
        if (actions[j].Transfer && actions[j].Transfer.deposit && actions[j].Transfer.deposit !== "0") {
          return { yocto: String(actions[j].Transfer.deposit), payee: r.receiver_id };
        }
      }
    }
    return { yocto: "0", payee: null };
  }

  function failureReason(status) {
    try {
      var err = status.Failure.ActionError.kind.FunctionCallError.ExecutionError || "";
      var m = /invalid pending signature/i.exec(err);
      if (m) return "invalid pending signature";
      return err.split("\n").pop() || "Failure";
    } catch (e) {
      return "Failure";
    }
  }

  function judgeModeFromTx(result) {
    try {
      var actions = (result.transaction || {}).actions || [];
      for (var i = 0; i < actions.length; i++) {
        var fc = actions[i].FunctionCall;
        if (!fc || !fc.args) continue;
        var args = b64Json(fc.args);
        if (args && args.judge_report && args.judge_report.mode) {
          return parseMode(args.judge_report.mode);
        }
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function parseLiveTx(meta, result) {
    var status = result.status || {};
    var events = collectEvents(result);
    var decoded = status.SuccessValue != null ? b64Json(status.SuccessValue) : null;
    var row = {
      id: meta.id,
      run: meta.run,
      scene: meta.scene,
      step: meta.step,
      hash: meta.hash,
      signer: (result.transaction && result.transaction.signer_id) || meta.signer,
      contract: meta.contract,
      method_name: meta.method_name,
      finality: result.final_execution_status || "",
      related: meta.related || [],
      jev: { present: false, mode: "none" }
    };

    if (status.Failure) {
      row.outcome = "Failure";
      row.verdict = "fail";
      row.reason_code = failureReason(status);
      row.payout_yocto = "0";
      row.payout_near = "0";
      row.payee = null;
    } else {
      row.outcome = "SuccessValue";
      var pay = payoutFromResult(result, events);
      row.payout_yocto = pay.yocto;
      row.payout_near = yoctoToNear(pay.yocto);
      row.payee = pay.payee;
      if (decoded && decoded.reason_code) {
        row.verdict = decoded.verdict || (decoded.reason_code === "allowed" ? "allow" : "block");
        row.reason_code = decoded.reason_code;
      } else if (firstEvent(events, "payout_settled")) {
        row.verdict = "approved";
        row.reason_code = "payout_settled";
      } else if (decoded) {
        row.verdict = decoded.verdict || "allow";
        row.reason_code = decoded.reason_code || decoded.reason || "—";
      } else {
        row.verdict = "allow";
        row.reason_code = "—";
      }
    }

    var t2 = eventData(firstEvent(events, "tier2_decision"));
    if (t2 && t2.mode) {
      var fromEvent = parseMode(t2.mode);
      if (t2.report_authenticated != null) fromEvent.report_authenticated = t2.report_authenticated;
      if (t2.source_q_permille != null) fromEvent.source_q_permille = t2.source_q_permille;
      if (t2.verdict) fromEvent.verdict = t2.verdict;
      if (t2.lock) fromEvent.lock = t2.lock;
      row.jev = fromEvent;
    } else {
      var fromArgs = judgeModeFromTx(result);
      if (fromArgs && fromArgs.present) {
        fromArgs.note = "No tier2_decision event on this transaction; JEV fields are from the judge_report.mode argument.";
        row.jev = fromArgs;
      } else if (meta.jev && !meta.jev.present) {
        row.jev = { present: false, mode: "none", detail: meta.jev.detail || "" };
      }
    }
    return row;
  }

  function applyI18n() {
    var s = state.strings;
    if (!s) return;
    document.documentElement.lang = s.htmlLang || state.lang;
    document.title = s.title;
    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var key = el.getAttribute("data-i18n");
      if (s[key] != null) el.textContent = s[key];
    });
    var btn = $("lang-btn");
    btn.textContent = s.langButton;
    btn.setAttribute("aria-label", s.langButtonAria);
    renderSourceBadge();
    renderHashTable();
    renderTxTable();
  }

  function renderSourceBadge() {
    var s = state.strings || {};
    var badge = $("source-badge");
    var label = $("source-label");
    badge.className = "badge";
    if (state.source === "live") {
      badge.classList.add("live");
      label.textContent = s.sourceLive || "Live from archival RPC";
    } else if (state.source === "loading") {
      label.textContent = s.sourceLoading || "Reading archival RPC…";
    } else {
      badge.classList.add("recorded");
      label.textContent = s.sourceRecorded || "Recorded copy";
    }
  }

  function verdictLabel(row) {
    var s = state.strings || {};
    if (row.reason_code === "tier2_escalate") return s.verdictHold || "held";
    var v = row.verdict;
    if (v === "allow") return s.verdictAllow || v;
    if (v === "block") return s.verdictBlock || v;
    if (v === "fail") return s.verdictFail || v;
    if (v === "approved") return s.verdictApproved || v;
    return v;
  }

  function stepLabel(row) {
    var s = state.strings || {};
    var key = "step" + row.id;
    return s[key] || row.step || "";
  }

  function renderHashTable() {
    var rec = state.recorded;
    var s = state.strings || {};
    var body = $("hash-body");
    body.textContent = "";
    if (!rec) return;
    rec.contracts.forEach(function (c) {
      var live = (state.liveHashes || {})[c.account];
      var computed = sha256HexToBase58(c.wasm_sha256);
      var repoB58 = c.code_hash_base58 || computed;
      var onchain = live || (state.source === "live" ? "" : c.code_hash_base58);
      var match, matchClass;
      if (live) {
        var ok = live === computed && computed === repoB58;
        match = ok ? (s.matchYes || "Match") : (s.matchNo || "Different");
        matchClass = ok ? "match-yes" : "match-no";
      } else if (state.source !== "live") {
        var okRec = computed === repoB58;
        match = okRec ? (s.matchYes || "Match") : (s.matchNo || "Different");
        matchClass = okRec ? "match-yes" : "match-no";
        onchain = c.code_hash_base58;
      } else {
        match = s.matchUnknown || "Not checked live";
        matchClass = "match-na";
        onchain = "—";
      }
      var art = document.createElement("article");
      art.className = "hash-card";
      var head = document.createElement("header");
      var run = document.createElement("strong");
      run.textContent = "Run " + c.run;
      var acc = document.createElement("span");
      acc.className = "mono";
      acc.textContent = c.account;
      head.appendChild(run);
      head.appendChild(acc);
      art.appendChild(head);
      var dl = document.createElement("dl");
      dl.className = "hash-dl";
      function row(label, value, cls) {
        var div = document.createElement("div");
        div.className = "hash-row";
        var k = document.createElement("dt");
        k.textContent = label;
        var v = document.createElement("dd");
        if (cls) v.className = cls;
        v.textContent = value;
        div.appendChild(k);
        div.appendChild(v);
        dl.appendChild(div);
      }
      var onchainLabel = (state.source === "live") ? (s.colOnchain || "On-chain code_hash") : (s.colOnchainRecorded || "Recorded code_hash");
      row(onchainLabel, onchain || "—", "mono");
      row(s.colRepoSha, c.wasm_sha256, "mono");
      row(s.colRepoB58, computed || repoB58, "mono");
      row(s.colMatch, match, matchClass);
      art.appendChild(dl);
      var note = document.createElement("p");
      note.className = "hash-note";
      note.textContent = c.run === "A" ? (s.runANote || c.code_hash_note) : (s.runBNote || c.code_hash_note);
      art.appendChild(note);
      body.appendChild(art);
    });
  }

  function renderJev(cell, jev) {
    var s = state.strings || {};
    cell.className = "jev";
    if (!jev || !jev.present) {
      var span = document.createElement("span");
      span.className = "muted";
      span.textContent = s.noJev || "No judge (rules only)";
      cell.appendChild(span);
      return;
    }
    var lines = [];
    lines.push(jev.mode || "jev-live");
    if (jev.model) lines.push(jev.model);
    if (jev.p_yes) lines.push("p_yes " + jev.p_yes);
    if (jev.verdict) lines.push("verdict " + jev.verdict);
    if (jev.report_authenticated === true) lines.push("authenticated");
    if (jev.report_authenticated === false) lines.push("not authenticated");
    cell.appendChild(document.createTextNode(lines.join(" · ")));
    if (jev.note) {
      var n = document.createElement("div");
      n.className = "jev-note";
      n.textContent = s.jevFromArgs || jev.note;
      cell.appendChild(n);
    }
  }

  function renderTxTable() {
    var rec = state.recorded;
    var s = state.strings || {};
    var body = $("tx-body");
    body.textContent = "";
    if (!rec) return;
    var rows = state.liveRows || rec.transactions;
    rows.forEach(function (row) {
      var tr = document.createElement("tr");
      var scene = document.createElement("td");
      scene.setAttribute("data-label", s.colScene);
      var step = stepLabel(row);
      scene.textContent = "Run " + row.run + " · " + row.scene + (step ? " — " + step : "");
      tr.appendChild(scene);

      var hash = document.createElement("td");
      hash.className = "hash";
      hash.setAttribute("data-label", s.colHash);
      hash.appendChild(explorerLink(row.hash));
      var ex = document.createElement("div");
      ex.className = "related";
      var expl = document.createElement("a");
      expl.href = EXPLORER + row.hash;
      expl.target = "_blank";
      expl.rel = "noopener noreferrer";
      expl.textContent = s.explorer || "Explorer";
      ex.appendChild(expl);
      if (row.related && row.related.length) {
        row.related.forEach(function (rel) {
          ex.appendChild(document.createTextNode(" · "));
          var label = rel.role === "hold" ? (s.relatedHold || rel.role) : (s.relatedFail || rel.role);
          ex.appendChild(document.createTextNode(label + " "));
          ex.appendChild(explorerLink(rel.hash));
        });
      }
      hash.appendChild(ex);
      tr.appendChild(hash);

      var signer = document.createElement("td");
      signer.className = "mono signer";
      signer.setAttribute("data-label", s.colSigner);
      signer.textContent = row.signer || "—";
      tr.appendChild(signer);

      var ver = document.createElement("td");
      var vclass = (row.reason_code === "tier2_escalate") ? "hold" : (row.verdict || "");
      ver.className = "verdict " + vclass;
      ver.setAttribute("data-label", s.colVerdict);
      ver.textContent = verdictLabel(row);
      tr.appendChild(ver);

      var reason = document.createElement("td");
      reason.className = "mono reason";
      reason.setAttribute("data-label", s.colReason);
      reason.textContent = row.reason_code || "—";
      tr.appendChild(reason);

      var pay = document.createElement("td");
      pay.className = "payout";
      pay.setAttribute("data-label", s.colPayout);
      var amount = row.payout_near != null ? String(row.payout_near) : yoctoToNear(row.payout_yocto);
      pay.textContent = amount === "0" ? (s.payoutZero || "0 NEAR") : (amount + " NEAR");
      tr.appendChild(pay);

      var jev = document.createElement("td");
      jev.setAttribute("data-label", s.colJev);
      renderJev(jev, row.jev);
      tr.appendChild(jev);

      body.appendChild(tr);
    });
  }

  function preferRecorded() {
    try {
      var q = new URLSearchParams(location.search);
      return q.get("source") === "recorded";
    } catch (e) {
      return false;
    }
  }

  function loadLive() {
    var rec = state.recorded;
    var txs = mapPool(rec.transactions, 3, function (meta) {
      return rpc("EXPERIMENTAL_tx_status", {
        tx_hash: meta.hash,
        sender_account_id: meta.signer,
        wait_until: "FINAL"
      }).then(function (result) {
        if (!result || result.final_execution_status !== "FINAL") throw new Error("not final");
        return parseLiveTx(meta, result);
      });
    });
    var accounts = mapPool(rec.contracts, 2, function (c) {
      return rpc("query", {
        request_type: "view_account",
        finality: "final",
        account_id: c.account
      }).then(function (result) {
        return { account: c.account, code_hash: result && result.code_hash };
      }).catch(function () {
        return { account: c.account, code_hash: null };
      });
    });
    return txs.then(function (rows) {
      if (!rows || rows.length !== rec.transactions.length) throw new Error("incomplete");
      return accounts.then(function (hashes) {
        var map = {};
        hashes.forEach(function (h) { if (h && h.code_hash) map[h.account] = h.code_hash; });
        return { rows: rows, hashes: map };
      });
    });
  }

  function setSource(kind) {
    state.source = kind;
    renderSourceBadge();
    renderHashTable();
    renderTxTable();
  }

  function toggleLang() {
    state.lang = state.lang === "en" ? "ko" : "en";
    try { localStorage.setItem("chopgate-c1-lang", state.lang); } catch (e) { /* ignore */ }
    return loadJson(I18N[state.lang]).then(function (s) {
      state.strings = s;
      applyI18n();
    });
  }

  function start() {
    var saved = null;
    try { saved = localStorage.getItem("chopgate-c1-lang"); } catch (e) { /* ignore */ }
    if (saved === "ko" || saved === "en") state.lang = saved;

    $("lang-btn").addEventListener("click", function () {
      toggleLang().catch(function () { /* keep current language if reload fails */ });
    });

    Promise.all([loadJson(I18N[state.lang]), loadJson(DATA_URL)]).then(function (pair) {
      state.strings = pair[0];
      state.recorded = pair[1];
      applyI18n();
      if (preferRecorded()) {
        state.liveRows = null;
        state.liveHashes = null;
        setSource("recorded");
        return;
      }
      return loadLive().then(function (live) {
        state.liveRows = live.rows;
        state.liveHashes = live.hashes;
        setSource("live");
      }).catch(function () {
        state.liveRows = null;
        state.liveHashes = null;
        setSource("recorded");
      });
    }).catch(function () {
      /* recorded or i18n missing: leave the static English markup */
      state.source = "recorded";
      renderSourceBadge();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
