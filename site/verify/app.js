/* ChopGate verify page. Static, no build step. Relative paths only.
   Each scene transaction is read on its own: archival fastnear first, then one
   try on archival near.org. A finalized row is kept in sessionStorage.
   At most four RPC calls are in flight. Failures stay on the page. */
(function () {
  "use strict";

  var TX_PRIMARY = "https://archival-rpc.testnet.fastnear.com";
  var TX_FALLBACK = "https://archival-rpc.testnet.near.org";
  var EXPLORER = "https://testnet.nearblocks.io/txns/";
  var DATA_URL = "./data/scene-txs.json";
  var I18N = { en: "./i18n/en.json", ko: "./i18n/ko.json" };
  var B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  var TIMEOUT_MS = 12000;
  var MAX_INFLIGHT = 4;
  var TX_CACHE_KEY = "cg-c2-r2-final-tx-v1";

  var FAUCET_URL = "https://docs.near.org/getting-started/faucet";

  var inflightCount = 0;
  var slotWaiters = [];

  var state = {
    lang: "en",
    strings: null,
    recorded: null,
    source: "loading",
    unread: false,
    liveRows: null,
    liveHashes: null,
    liveCount: 0,
    recordedCount: 0
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
    return h.length <= 12 ? h : h.slice(0, 4) + "…" + h.slice(-4);
  }

  function explorerLink(hash, label) {
    var a = document.createElement("a");
    a.className = "hit";
    a.href = EXPLORER + hash;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.title = hash;
    if (label) {
      var name = document.createElement("span");
      name.textContent = label;
      a.appendChild(name);
      a.appendChild(document.createTextNode(" "));
    }
    var mark = document.createElement("span");
    mark.className = "hash-label";
    mark.textContent = shortHash(hash);
    a.appendChild(mark);
    return a;
  }

  function icon(name) {
    var paths = {
      check: "<path d=\"M5 12.5 9.2 17 19 7\"/>",
      cross: "<path d=\"M7 7l10 10M17 7 7 17\"/>",
      hold: "<circle cx=\"12\" cy=\"12\" r=\"8\"/><path d=\"M12 8v5l3 2\"/>",
      alert: "<path d=\"M12 8v5\"/><path d=\"M12 16.5h.01\"/><path d=\"M12 3 3 20h18L12 3z\"/>",
      live: "<circle cx=\"12\" cy=\"12\" r=\"4\"/>",
      book: "<path d=\"M6 5h11a2 2 0 0 1 2 2v12H8a2 2 0 0 0-2 2V5z\"/><path d=\"M6 19a2 2 0 0 1 2-2h11\"/>",
      shield: "<path d=\"M12 3.5 5.5 6.2v5.3c0 3.6 2.7 6.2 6.5 7.5 3.8-1.3 6.5-3.9 6.5-7.5V6.2L12 3.5z\"/>"
    };
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "ico");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.innerHTML = paths[name] || paths.alert;
    return svg;
  }

  function readTxCache() {
    try {
      var raw = sessionStorage.getItem(TX_CACHE_KEY);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function txCacheGet(hash) {
    var map = readTxCache();
    var row = map[hash];
    if (!row || row.sourceKind !== "live" || row.finality !== "FINAL") return null;
    return row;
  }

  function txCacheSet(row) {
    if (!row || !row.hash || row.sourceKind !== "live") return;
    try {
      var map = readTxCache();
      map[row.hash] = row;
      sessionStorage.setItem(TX_CACHE_KEY, JSON.stringify(map));
    } catch (e) { /* quota or private mode */ }
  }

  function acquireSlot() {
    if (inflightCount < MAX_INFLIGHT) {
      inflightCount += 1;
      return Promise.resolve();
    }
    return new Promise(function (resolve) { slotWaiters.push(resolve); });
  }

  function releaseSlot() {
    inflightCount -= 1;
    if (slotWaiters.length && inflightCount < MAX_INFLIGHT) {
      inflightCount += 1;
      slotWaiters.shift()();
    }
  }

  function rpcOnce(url, method, params) {
    return acquireSlot().then(function () {
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
      return fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "c2", method: method, params: params }),
        signal: ctrl.signal
      }).then(function (res) {
        if (!res.ok) throw new Error("RPC HTTP " + res.status);
        return res.json();
      }).then(function (body) {
        if (!body || body.error) {
          throw new Error("RPC " + ((body && body.error && body.error.name) || "error"));
        }
        return body.result;
      }).catch(function (err) {
        if (err && err.name === "AbortError") throw new Error("RPC timed out");
        throw err;
      }).finally(function () {
        clearTimeout(timer);
        releaseSlot();
      });
    });
  }

  function rpcPair(method, params, accept) {
    return rpcOnce(TX_PRIMARY, method, params).then(function (result) {
      if (accept && !accept(result)) throw new Error("rpc rejected result");
      return result;
    }).catch(function () {
      return rpcOnce(TX_FALLBACK, method, params).then(function (result) {
        if (accept && !accept(result)) throw new Error("rpc rejected result");
        return result;
      });
    });
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
    renderScene();
    renderCost();
    var track = $("demo-track");
    if (track && s.subtitleLabel) track.setAttribute("label", s.subtitleLabel);
    var pack = { lang: state.lang, strings: state.strings };
    document.documentElement.chopgateLang = pack;
    document.dispatchEvent(new CustomEvent("chopgate:lang", { detail: pack }));
  }

  function renderCost() {
    var s = state.strings || {};
    var faucet = $("faucet-line");
    var actions = $("faucet-actions");
    if (!faucet || !actions) return;
    actions.textContent = "";
    if (!FAUCET_URL) {
      faucet.hidden = true;
      return;
    }
    faucet.hidden = false;
    var a = document.createElement("a");
    a.className = "hit";
    a.id = "faucet-link";
    a.href = String(FAUCET_URL);
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = s.faucetLink || "NEAR docs faucet";
    actions.appendChild(a);
  }

  /* Five scene sentences. Autoplay pauses when the scene scrolls out of view.
     prefer-still shows the last sentence. */
  var sceneIndex = 0;
  var sceneTimer = null;
  var sceneUserPause = false;
  var sceneInView = true;
  var sceneReady = false;
  var preferStill = false;

  function sceneSteps() {
    var s = state.strings || {};
    return [
      { sentence: s.scene1 || "An AI agent wants to spend your money." },
      { sentence: s.scene2 || "You stamp (sign) each job it may pay for: who gets paid, how much, and the exact instruction." },
      { sentence: s.scene3 || "The agent asks for exactly that job, within your limit: paid." },
      { sentence: s.scene4 || "A different instruction, a fake owner, or a higher amount: refused, and recorded." },
      { sentence: s.scene5 || "Above the review amount you set, a payment waits for your approval." }
    ];
  }

  function stopSceneTimer() {
    if (sceneTimer) {
      clearInterval(sceneTimer);
      sceneTimer = null;
    }
  }

  function resumeSceneTimer() {
    stopSceneTimer();
    if (preferStill || sceneUserPause || !sceneInView) return;
    if (sceneIndex >= sceneSteps().length - 1) return;
    sceneTimer = setInterval(function () {
      if (sceneIndex >= sceneSteps().length - 1) {
        stopSceneTimer();
        renderScene();
        return;
      }
      sceneIndex += 1;
      if (sceneIndex >= sceneSteps().length - 1) stopSceneTimer();
      renderScene();
    }, 5000);
  }

  function renderScene() {
    var root = $("scene");
    if (!root) return;
    var s = state.strings || {};
    var steps = sceneSteps();
    if (preferStill) sceneIndex = steps.length - 1;
    if (sceneIndex < 0) sceneIndex = 0;
    if (sceneIndex > steps.length - 1) sceneIndex = steps.length - 1;
    var sentence = $("scene-sentence");
    if (sentence) sentence.textContent = steps[sceneIndex].sentence;
    var list = $("scene-steps");
    if (list) {
      list.textContent = "";
      steps.forEach(function (step, i) {
        var li = document.createElement("li");
        if (i === sceneIndex) li.className = "is-current";
        else if (i < sceneIndex) li.className = "is-done";
        var line = document.createElement("span");
        line.className = "status-line status-line-compact";
        var name = document.createElement("span");
        name.className = "status-name";
        name.textContent = (i === sceneIndex ? (s.sceneNow || "Now") : String(i + 1)) + ":";
        var val = document.createElement("span");
        val.className = "status-value";
        val.textContent = step.sentence;
        line.appendChild(name);
        line.appendChild(icon(i === sceneIndex ? "live" : i < sceneIndex ? "check" : "hold"));
        line.appendChild(val);
        li.appendChild(line);
        list.appendChild(li);
      });
    }
    var status = $("scene-status");
    if (status) {
      status.textContent = "";
      var playing = !preferStill && !sceneUserPause && !!sceneTimer;
      var modeVal = preferStill
        ? (s.sceneFinal || "Final step")
        : (playing ? (s.scenePlaying || "Playing") : (s.scenePaused || "Paused"));
      var line = document.createElement("span");
      line.className = "status-line";
      var vv = document.createElement("span");
      vv.className = "status-value";
      vv.textContent = modeVal;
      line.appendChild(icon(preferStill ? "book" : playing ? "live" : "hold"));
      line.appendChild(vv);
      status.appendChild(line);
    }
    var prev = $("scene-prev");
    var next = $("scene-next");
    var pause = $("scene-pause");
    if (prev) prev.textContent = s.scenePrev || "Previous";
    if (next) next.textContent = s.sceneNext || "Next";
    if (pause) {
      var showPlay = preferStill || sceneUserPause || !sceneTimer;
      pause.textContent = showPlay ? (s.scenePlay || "Play") : (s.scenePause || "Pause");
      pause.setAttribute("aria-pressed", showPlay ? "false" : "true");
    }
    root.setAttribute("data-scene", String(sceneIndex + 1));
    root.setAttribute("data-play", preferStill ? "off" : "on");
  }

  function stepScene(delta) {
    if (preferStill) {
      sceneIndex = sceneSteps().length - 1;
      renderScene();
      return;
    }
    sceneUserPause = true;
    stopSceneTimer();
    sceneIndex += delta;
    renderScene();
  }

  function toggleScenePause() {
    if (preferStill) {
      sceneIndex = sceneSteps().length - 1;
      renderScene();
      return;
    }
    if (!sceneUserPause && sceneTimer) {
      sceneUserPause = true;
      stopSceneTimer();
    } else {
      sceneUserPause = false;
      if (sceneIndex >= sceneSteps().length - 1) sceneIndex = 0;
      resumeSceneTimer();
    }
    renderScene();
  }

  function initScene() {
    var root = $("scene");
    if (!root) return;
    if (sceneReady) {
      renderScene();
      return;
    }
    sceneReady = true;
    try {
      preferStill = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (e) {
      preferStill = false;
    }
    if (preferStill) sceneIndex = sceneSteps().length - 1;
    var prev = $("scene-prev");
    var next = $("scene-next");
    var pause = $("scene-pause");
    if (prev) prev.addEventListener("click", function () { stepScene(-1); });
    if (next) next.addEventListener("click", function () { stepScene(1); });
    if (pause) pause.addEventListener("click", function () { toggleScenePause(); });
    root.addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); stepScene(1); }
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); stepScene(-1); }
      else if (e.key === " " || e.key === "Spacebar") { e.preventDefault(); toggleScenePause(); }
    });
    var rect = root.getBoundingClientRect();
    sceneInView = rect.bottom > 0 && rect.top < window.innerHeight;
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (entries) {
        sceneInView = entries.some(function (en) { return en.isIntersecting; });
        if (!sceneInView) stopSceneTimer();
        else resumeSceneTimer();
        renderScene();
      }, { threshold: 0.35 });
      io.observe(root);
    }
    if (sceneInView) resumeSceneTimer();
    renderScene();
  }

  function sourceCountText() {
    var s = state.strings || {};
    var tmpl = s.sourceCount || "Live {live} · Recorded {recorded}";
    return tmpl.replace("{live}", String(state.liveCount)).replace("{recorded}", String(state.recordedCount));
  }

  function renderSourceBadge() {
    var s = state.strings || {};
    var badge = $("source-badge");
    var label = $("source-label");
    var iconHost = $("source-icon");
    var title = $("verify-title");
    var unread = $("live-unread");
    if (!badge || !label) return;
    badge.className = "badge status-line";
    var recordedMode = state.source === "recorded" || state.source === "mixed";
    if (state.source === "loading") {
      label.textContent = s.sourceLoading || "Reading archival RPC…";
    } else {
      label.textContent = sourceCountText();
      badge.classList.add(state.source === "live" ? "live" : "recorded");
      if (state.source === "mixed") badge.classList.add("mixed");
    }
    if (iconHost) {
      iconHost.textContent = "";
      iconHost.appendChild(icon(state.source === "live" ? "live" : state.source === "loading" ? "hold" : "book"));
    }
    if (title) {
      if (state.source === "mixed") {
        title.textContent = s.verifyTitleMixed || "Scene transactions. Each row is live or from the recorded copy.";
      } else if (recordedMode) {
        title.textContent = s.verifyTitleRecorded || "Scene transactions, shown from the recorded copy.";
      } else if (state.source === "live") {
        title.textContent = s.verifyTitle || "Scene transactions, read live from public RPC.";
      }
    }
    if (unread) {
      unread.hidden = true;
      unread.textContent = "";
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
      var match, matchClass, iconName, matchLabel;
      var useRecordedCheck = state.source !== "live";
      if (!useRecordedCheck && live) {
        var ok = live === computed;
        match = ok ? (s.matchYes || "Match") : (s.matchNo || "Different");
        matchClass = ok ? "match-yes" : "match-no";
        iconName = ok ? "check" : "cross";
        matchLabel = s.colMatch || "Match";
      } else if (useRecordedCheck) {
        var okRec = computed === repoB58;
        match = okRec
          ? (s.matchRecorded || "Recorded match (wasm sha256 vs recorded code_hash)")
          : (s.matchRecordedNo || "Recorded mismatch (wasm sha256 vs recorded code_hash)");
        matchClass = okRec ? "match-yes" : "match-no";
        iconName = okRec ? "check" : "cross";
        matchLabel = s.colMatchRecorded || "Recorded check";
        onchain = c.code_hash_base58;
      } else {
        match = s.matchUnknown || "Not checked";
        matchClass = "match-na";
        iconName = "alert";
        matchLabel = s.colMatchPending || "Check";
        onchain = "—";
      }
      var art = document.createElement("article");
      art.className = "hash-card";
      var head = document.createElement("header");
      var run = document.createElement("strong");
      run.textContent = (s.runLabel || "Run") + " " + c.run;
      var acc = document.createElement("span");
      acc.className = "mono";
      acc.textContent = c.account;
      head.appendChild(run);
      head.appendChild(acc);
      art.appendChild(head);
      var dl = document.createElement("dl");
      dl.className = "hash-dl";
      function row(label, value, cls, withIcon) {
        var div = document.createElement("div");
        div.className = "hash-row";
        var k = document.createElement("dt");
        k.textContent = label;
        var v = document.createElement("dd");
        if (cls) v.className = cls;
        if (withIcon) {
          var line = document.createElement("span");
          line.className = "status-line status-line-compact";
          line.appendChild(icon(withIcon));
          var val = document.createElement("span");
          val.className = "status-value";
          val.textContent = value;
          line.appendChild(val);
          v.appendChild(line);
        } else {
          v.textContent = value;
        }
        div.appendChild(k);
        div.appendChild(v);
        dl.appendChild(div);
      }
      var onchainLabel = (state.source === "live") ? (s.colOnchain || "On-chain code_hash") : (s.colOnchainRecorded || "Recorded code_hash");
      row(onchainLabel, onchain || "—", "mono");
      row(s.colRepoSha, c.wasm_sha256, "mono");
      row(s.colRepoB58, computed || repoB58, "mono");
      row(matchLabel, match, matchClass, iconName);
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
    if (jev.mode) lines.push(jev.mode);
    if (jev.model) lines.push(jev.model);
    if (jev.p_yes) lines.push("p_yes " + jev.p_yes);
    if (jev.verdict) lines.push(String(jev.verdict));
    if (jev.report_authenticated === true) lines.push(s.jevAuth || "authenticated");
    if (jev.report_authenticated === false) lines.push(s.jevUnauth || "not authenticated");
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
      var sceneWrap = document.createElement("div");
      sceneWrap.className = "scene-cell";
      var sceneText = document.createElement("span");
      sceneText.textContent = (s.runLabel || "Run") + " " + row.run + " · " + row.scene + (step ? " — " + step : "");
      var mark = document.createElement("span");
      mark.className = "row-source " + (row.sourceKind === "live" ? "live" : "recorded");
      mark.textContent = row.sourceKind === "live" ? (s.rowLive || "Live") : (s.rowRecorded || "Recorded");
      sceneWrap.appendChild(sceneText);
      sceneWrap.appendChild(mark);
      scene.appendChild(sceneWrap);
      tr.appendChild(scene);

      var hash = document.createElement("td");
      hash.className = "hash";
      hash.setAttribute("data-label", s.colHash);
      var ex = document.createElement("div");
      ex.className = "related link-row";
      ex.appendChild(explorerLink(row.hash));
      ex.appendChild(explorerLink(row.hash, s.explorer || "Explorer"));
      if (row.related && row.related.length) {
        row.related.forEach(function (rel) {
          var label = rel.role === "hold" ? (s.relatedHold || rel.role) : (s.relatedFail || rel.role);
          ex.appendChild(explorerLink(rel.hash, label));
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
      var vline = document.createElement("span");
      vline.className = "status-line status-line-compact";
      var vname = document.createElement("span");
      vname.className = "status-name";
      vname.textContent = (s.colVerdict || "Verdict") + ":";
      var vicon = (vclass === "hold") ? "hold" : (vclass === "allow" || vclass === "approved") ? "check" : (vclass === "block" || vclass === "fail") ? "cross" : "alert";
      vline.appendChild(vname);
      vline.appendChild(icon(vicon));
      var vval = document.createElement("span");
      vval.className = "status-value";
      vval.textContent = verdictLabel(row);
      vline.appendChild(vval);
      ver.appendChild(vline);
      tr.appendChild(ver);

      var reason = document.createElement("td");
      reason.className = "mono reason";
      reason.setAttribute("data-label", s.colReason);
      reason.textContent = row.reason_code || "—";
      tr.appendChild(reason);

      var pay = document.createElement("td");
      pay.className = "payout num";
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

  function recordedRow(meta) {
    var row = Object.assign({}, meta);
    row.sourceKind = "recorded";
    return row;
  }

  function loadOneTx(meta) {
    var cached = txCacheGet(meta.hash);
    if (cached) return Promise.resolve(cached);
    var params = {
      tx_hash: meta.hash,
      sender_account_id: meta.signer,
      wait_until: "FINAL"
    };
    return rpcPair("EXPERIMENTAL_tx_status", params, function (result) {
      return result && result.final_execution_status === "FINAL";
    }).then(function (result) {
      var row = parseLiveTx(meta, result);
      row.sourceKind = "live";
      txCacheSet(row);
      return row;
    }).catch(function () {
      return recordedRow(meta);
    });
  }

  function loadHash(account) {
    var params = { request_type: "view_account", finality: "final", account_id: account };
    return rpcPair("query", params, function (result) {
      return result && result.code_hash;
    }).then(function (result) {
      return { account: account, code_hash: result.code_hash };
    }).catch(function () {
      return { account: account, code_hash: null };
    });
  }

  function loadLive() {
    var rec = state.recorded;
    var jobs = rec.transactions.map(function (meta) {
      return loadOneTx(meta).catch(function () { return recordedRow(meta); });
    });
    return Promise.all(jobs).then(function (rows) {
      var allLive = rows.every(function (row) { return row && row.sourceKind === "live"; });
      if (!allLive) return { rows: rows, hashes: {} };
      return Promise.all(rec.contracts.map(function (c) { return loadHash(c.account); })).then(function (hashes) {
        var map = {};
        hashes.forEach(function (h) { if (h && h.code_hash) map[h.account] = h.code_hash; });
        return { rows: rows, hashes: map };
      }).catch(function () {
        return { rows: rows, hashes: {} };
      });
    });
  }

  function countsFrom(rows) {
    var live = 0;
    (rows || []).forEach(function (row) { if (row && row.sourceKind === "live") live += 1; });
    state.liveCount = live;
    state.recordedCount = (rows || []).length - live;
  }

  function sourceFromCounts() {
    if (!state.recordedCount) return "live";
    if (!state.liveCount) return "recorded";
    return "mixed";
  }

  function setSource(kind, opts) {
    state.source = kind;
    state.unread = Boolean(opts && opts.unread);
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
    initScene();

    Promise.all([loadJson(I18N[state.lang]), loadJson(DATA_URL)]).then(function (pair) {
      state.strings = pair[0];
      state.recorded = pair[1];
      applyI18n();
      if (preferRecorded()) {
        state.liveRows = state.recorded.transactions.map(recordedRow);
        state.liveHashes = null;
        countsFrom(state.liveRows);
        setSource("recorded");
        return;
      }
      return loadLive().then(function (live) {
        state.liveRows = live.rows;
        state.liveHashes = live.hashes;
        countsFrom(live.rows);
        setSource(sourceFromCounts());
      }).catch(function () {
        state.liveRows = state.recorded.transactions.map(recordedRow);
        state.liveHashes = null;
        countsFrom(state.liveRows);
        setSource("recorded");
      });
    }).catch(function () {
      /* recorded or i18n missing: leave the static English markup */
      state.source = "recorded";
      state.unread = true;
      renderSourceBadge();
    });
  }

  function pressMs() {
    var raw = "";
    try { raw = getComputedStyle(document.documentElement).getPropertyValue("--press-ms"); } catch (e) { raw = ""; }
    var n = parseFloat(raw);
    if (!n) return 120;
    return n > 10 ? n : n * 1000;
  }

  function showPressed(el) {
    if (!el || !el.classList) return;
    el.classList.add("is-pressed");
    setTimeout(function () { el.classList.remove("is-pressed"); }, pressMs());
  }

  document.addEventListener("pointerdown", function (e) {
    var el = e.target && e.target.closest && e.target.closest("a, button");
    if (el) showPressed(el);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    var el = e.target && e.target.closest && e.target.closest("a, button");
    if (el) showPressed(el);
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
