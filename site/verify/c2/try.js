// Wires the four Try-it buttons. The FunctionCall is built inside runAttack on click.
// This file does not cache a signed payload. Completed results are kept as data
// (newest first, at most 8) and repainted when the language changes.
import { NearConnector, ed } from "../nc/near-connect-0.12.0.bundle.mjs";
import {
  runAttack,
  listOpenHolds,
  isBusy,
  RUNC,
  accountBalance,
  MIN_SEND_YOCTO,
  readRequiredDeposit,
  FALLBACK_TOTAL_NEAR,
  formatDepositNear,
  formatGateTotal,
} from "./chopgate-attacks.mjs";

const $ = (id) => document.getElementById(id);

let langPack = null;

function currentPack() {
  if (langPack && langPack.strings) return langPack;
  const live = document.documentElement && document.documentElement.chopgateLang;
  if (live && live.strings) {
    langPack = live;
    return live;
  }
  return null;
}

function strings() {
  const pack = currentPack();
  return (pack && pack.strings) || {};
}

function t(key, fallback) {
  const pack = currentPack();
  const s = (pack && pack.strings) || {};
  if (s[key] != null && s[key] !== "") return s[key];
  // Static English is only for the moment before i18n loads.
  if (pack && pack.lang && pack.lang !== "en") return "";
  return fallback;
}

function scrub(value) {
  return String(value ?? "")
    .replace(/ed25519:[1-9A-HJ-NP-Za-km-z]+/g, "ed25519:[redacted]")
    .replace(/\b[0-9a-f]{64,}\b/gi, "[redacted]")
    .slice(0, 400);
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function svgIcon(name) {
  const paths = {
    check: '<path d="M5 12.5 9.2 17 19 7"/>',
    cross: '<path d="M7 7l10 10M17 7 7 17"/>',
    hold: '<circle cx="12" cy="12" r="8"/><path d="M12 8v5l3 2"/>',
    alert: '<path d="M12 8v5"/><path d="M12 16.5h.01"/><path d="M12 3 3 20h18L12 3z"/>',
    live: '<circle cx="12" cy="12" r="4"/>',
    book: '<path d="M6 5h11a2 2 0 0 1 2 2v12H8a2 2 0 0 0-2 2V5z"/><path d="M6 19a2 2 0 0 1 2-2h11"/>',
    shield: '<path d="M12 3.5 5.5 6.2v5.3c0 3.6 2.7 6.2 6.5 7.5 3.8-1.3 6.5-3.9 6.5-7.5V6.2L12 3.5z"/>',
  };
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "ico");
  svg.setAttribute("data-icon", name);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.innerHTML = paths[name] || paths.alert;
  return svg;
}

function classify(text) {
  const m = String(text || "");
  if (/unknown or resolved pending/i.test(m)) return "resolved";
  if (/reject|denied|cancel|dismiss|user closed|closed by user/i.test(m)) return "wallet-reject";
  if (/insufficient|not enough|lack balance|enough balance|enough near/i.test(m)) return "insufficient";
  if (/rpc-unavailable|rpc http|could not read|failed to fetch|network|timed out|429/i.test(m)) return "rpc";
  return "generic";
}

const REASON_KEYS = {
  unknown_mandate: "reasonUnknownMandate",
  owner_impersonation: "reasonOwnerImpersonation",
  auto_frozen: "reasonAutoFrozen",
  wrong_caller: "reasonWrongCaller",
  "invalid pending signature": "reasonInvalidPending",
  "unknown or resolved pending": "reasonResolvedPending",
};

const REASON_FALLBACK = {
  unknown_mandate: "no such permission exists",
  owner_impersonation: "the stamp is not the owner's key",
  auto_frozen: "this permission is frozen after repeated misuse",
  wrong_caller: "this permission belongs to a different agent",
  "invalid pending signature": "the approval was not signed by the owner",
  "unknown or resolved pending": "no open held payment has this number.",
};

function reasonSentence(code) {
  const key = REASON_KEYS[code];
  if (key) return t(key, REASON_FALLBACK[code]);
  return t("reasonGeneric", "the gate returned this code");
}

function notSentText(code, extra) {
  if (code === "connect") return t("notSentConnect", "Not sent. Connect a testnet wallet first.");
  if (code === "cancel" || code === "wallet-reject") return t("notSentCancel", "Not sent. You cancelled in the wallet.");
  if (code === "balance" || code === "insufficient") return t("notSentBalance", "Not sent. This account needs at least 0.003 testnet NEAR for the prepaid gas. The wallet window stays closed.");
  if (code === "no-account") return t("notSentNoAccount", "Not sent. This wallet has no account yet.");
  if (code === "mainnet-meteor") return t("walletMainnetMeteor", "This demo runs on NEAR testnet. Mainnet accounts (.near) cannot be used here. If you have no testnet account, you can make one in Intear (about 1 minute).");
  if (code === "connect-cancel") return t("walletConnectCancelled", "Wallet connection cancelled. Nothing was sent.");
  if (code === "mainnet") return t("walletMainnet", "This demo runs on NEAR testnet. Mainnet accounts (.near) cannot be used here.");
  if (code === "attack4-rpc") return t("notSentAttack4Rpc", "Not sent. The test gate could not be read, so no fake approval was built. The wallet stays closed.");
  if (code === "rpc-detail") {
    const tmpl = t("notSentRpcDetail", "Not sent. The public RPC said: {message}");
    return tmpl.replace("{message}", extra || "");
  }
  if (code === "busy") return t("notSentBusy", "Not sent. Another try is still running.");
  if (code === "rpc") return t("notSentRpc", "Not sent. The public RPC could not be reached.");
  return t("notSentGeneric", "Not sent. The call did not finish.");
}

function verdictText(kind, reason) {
  if (kind === "paid") return t("verdictPaid", "Paid.");
  if (kind === "held") return t("verdictHeld", "Held. Waiting for the owner.");
  if (kind === "resolved") return t("verdictResolved", "Refused. The hold is already closed and the transaction failed.");
  if (kind === "failed" && reason === "invalid pending signature") {
    return t("verdictFailed", "Refused. The gate rejected the fake stamp and the transaction failed.");
  }
  if (kind === "failed") return t("verdictFailedOther", "Refused. The transaction failed.");
  if (kind === "refused") return t("verdictRefused", "Refused. The gate blocked it.");
  return t("verdictUnread", "Sent. The outcome could not be read.");
}

function verdictIcon(kind) {
  if (kind === "paid") return "check";
  if (kind === "held") return "hold";
  if (kind === "refused" || kind === "failed" || kind === "resolved") return "shield";
  return "alert";
}

function shortHash(h) {
  if (!h) return "";
  if (h.length <= 12) return h;
  return h.slice(0, 4) + "…" + h.slice(-4);
}

function formatWhen(ms) {
  const date = new Date(ms);
  const parts = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(date);
  const pick = (type) => {
    const found = parts.find((p) => p.type === type);
    return found ? found.value : "";
  };
  const hour = pick("hour").replace(/[^\d]/g, "").padStart(2, "0");
  const minute = pick("minute").replace(/[^\d]/g, "").padStart(2, "0");
  let tz = pick("timeZoneName").replace(/\u2212/g, "-").trim();
  if (!/^[A-Z0-9:+\-]+$/.test(tz)) {
    const off = -date.getTimezoneOffset();
    const sign = off >= 0 ? "+" : "-";
    const abs = Math.abs(off);
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    tz = m ? "GMT" + sign + h + ":" + String(m).padStart(2, "0") : "GMT" + sign + h;
  }
  return { clock: hour + ":" + minute, tz };
}

function txLink(hash) {
  const a = el("a", "hit");
  a.href = RUNC.explorer(hash);
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.title = hash;
  const mark = el("span", "hash-label", shortHash(hash));
  a.appendChild(mark);
  return a;
}

let wallet = null;
let visitor = null;
let walletMode = "off";
let balanceLocked = false;
let balanceProblem = "ok";
let restoreGen = 0;
let walletErrorCode = null;
let holdState = { mode: "loading", count: 0 };
let knownHoldId = null;
let lastPreview = null;
let view = null;
let results = [];
const MAX_RESULTS = 8;
let faucetYocto = null;
let faucetState = "none";
let gateReady = false;
let gateYocto = null;
let gateLoadStarted = false;

function nearStringToYocto(raw) {
  const m = /^(\d+)(?:\.(\d{1,24}))?$/.exec(String(raw == null ? "" : raw).trim());
  if (!m) return null;
  const frac = (m[2] || "").padEnd(24, "0");
  return BigInt(m[1]) * (10n ** 24n) + BigInt(frac);
}

function formatCeilTenth(deltaYocto) {
  const tenth = 10n ** 23n;
  const tenths = (deltaYocto + tenth - 1n) / tenth;
  return (tenths / 10n).toString() + "." + (tenths % 10n).toString();
}

function shownGateTotal() {
  const node = $("cost-line");
  if (node && node.dataset && node.dataset.x) return node.dataset.x;
  return null;
}

function publishCostMode(mode) {
  const root = document.documentElement;
  const section = $("try");
  if (mode) {
    root.dataset.costMode = mode;
    if (section) section.dataset.costMode = mode;
  } else {
    delete root.dataset.costMode;
    if (section) delete section.dataset.costMode;
  }
}

function paintCost() {
  const node = $("cost-line");
  if (!node) return;
  if (!gateReady) {
    node.textContent = "";
    delete node.dataset.mode;
    delete node.dataset.x;
    delete node.dataset.y;
    publishCostMode("");
    return;
  }
  const y = gateYocto != null ? formatDepositNear(gateYocto) : null;
  const total = gateYocto != null ? formatGateTotal(gateYocto) : null;
  if (y != null && total != null) {
    const tmpl = t("costLine", "Making one gate costs about {x} testnet NEAR ({y} locked in the new gate + gas).");
    node.textContent = tmpl.replace("{x}", total).replace("{y}", y);
    node.dataset.mode = "live";
    node.dataset.x = total;
    node.dataset.y = y;
  } else {
    const tmpl = t("costFallback", "about {x} testnet NEAR");
    node.textContent = tmpl.replace("{x}", FALLBACK_TOTAL_NEAR);
    node.dataset.mode = "fallback";
    node.dataset.x = FALLBACK_TOTAL_NEAR;
    delete node.dataset.y;
  }
  publishCostMode(node.dataset.mode);
  paintFaucetNeed();
}

async function loadGateCost() {
  if (gateLoadStarted) return;
  gateLoadStarted = true;
  try {
    const yocto = await readRequiredDeposit();
    if (yocto != null && formatDepositNear(yocto) != null && formatGateTotal(yocto) != null) gateYocto = yocto;
    else gateYocto = null;
  } catch (e) {
    gateYocto = null;
  }
  gateReady = true;
  paintCost();
}

function faucetNeedSentence() {
  if (walletMode !== "on" || !visitor) {
    return t("faucetNeedNone", "One faucet request gives 5 testnet NEAR.");
  }
  if (!gateReady) return t("faucetNeedPending", "Reading the wallet balance.");
  if (faucetState !== "ready" || faucetYocto == null) {
    if (faucetState === "unread") return t("faucetNeedUnread", "The wallet balance could not be read.");
    return t("faucetNeedPending", "Reading the wallet balance.");
  }
  const need = nearStringToYocto(shownGateTotal());
  let have = null;
  try { have = BigInt(faucetYocto); } catch (e) { have = null; }
  if (need == null || have == null) return t("faucetNeedUnread", "The wallet balance could not be read.");
  const delta = need - have;
  if (delta <= 0n) return t("faucetNeedEnough", "Your wallet has enough testnet NEAR for one gate.");
  const x = formatCeilTenth(delta);
  return t("faucetNeedMore", "You need about {x} more testnet NEAR. One faucet request gives 5.").replace("{x}", x);
}

function paintFaucetNeed() {
  const node = $("faucet-need");
  if (!node) return;
  if (walletMode === "on" && visitor && faucetState === "ready" && faucetYocto != null) {
    node.dataset.state = "ready";
    node.dataset.yocto = faucetYocto;
  } else if (walletMode === "on" && visitor && faucetState === "unread") {
    node.dataset.state = "unread";
    delete node.dataset.yocto;
  } else if (walletMode === "on" && visitor) {
    node.dataset.state = "pending";
    delete node.dataset.yocto;
  } else {
    node.dataset.state = "none";
    delete node.dataset.yocto;
  }
  node.textContent = faucetNeedSentence();
}

function paintWallet(mode, account) {
  const wasOn = walletMode === "on";
  if (mode === "on" && !(account || visitor)) mode = "off";
  walletMode = mode;
  const iconHost = $("wallet-icon");
  const value = $("wallet-value");
  const line = $("wallet-status");
  if (iconHost) {
    iconHost.textContent = "";
    iconHost.appendChild(svgIcon(mode === "on" ? "live" : mode === "connecting" ? "hold" : "cross"));
  }
  if (value) {
    if (mode === "on") value.textContent = t("walletOn", "connected");
    else if (mode === "connecting") value.textContent = t("walletConnecting", "connecting");
    else value.textContent = t("walletOff", "not connected");
  }
  if (line) line.dataset.state = mode === "on" ? "success" : mode === "connecting" ? "loading" : "empty";
  if (mode !== "on") {
    faucetYocto = null;
    faucetState = "none";
  } else if (!wasOn && faucetState !== "ready") {
    faucetState = "pending";
  }
  paintFaucetNeed();
}

function holdLine() {
  const { mode, count } = holdState;
  if (mode === "loading") return t("holdsChecking", "Held payments on the gate: …");
  if (mode === "fail") return t("holdsFail", "Held payments on the gate: unreadable");
  if (!count) return t("holdsNone", "Held payments on the gate: none");
  return t("holdsCount", "Held payments on the gate: {n}").replace("{n}", String(count));
}

function attack4Label() {
  if (knownHoldId == null || knownHoldId === "") return t("attack4", "Send a fake approval stamp (hold)");
  return t("attack4Hold", "Send a fake approval stamp (hold #{id})").replace("{id}", String(knownHoldId));
}

function paintAttack4() {
  const attack4 = $("attack-4");
  if (!attack4) return;
  attack4.textContent = attack4Label();
}

function paintPreview(info) {
  const node = $("attack-preview");
  if (!node) return;
  if (!info) {
    node.hidden = true;
    node.textContent = "";
    return;
  }
  const amount = info.requestedNear ? info.requestedNear : t("attackAmountNone", "none");
  let text = t("attackPreview", "Method {method}. Contract {contract}. Attached NEAR: {attached}. Requested amount: {amount}.")
    .replace("{method}", info.method)
    .replace("{contract}", info.contract)
    .replace("{attached}", info.attachedNear)
    .replace("{amount}", amount);
  if (info.noOpenHold) text += " " + t("attackPreviewNoHold", "no open hold");
  else if (info.holdId) text += " " + t("attackPreviewHold", "Hold {id}.").replace("{id}", info.holdId);
  node.hidden = false;
  node.textContent = text;
}

function paintHolds() {
  const node = $("hold-status");
  if (node) node.textContent = holdLine();
  const attack4 = $("attack-4");
  if (attack4) {
    attack4.hidden = false;
    attack4.disabled = balanceLocked || isBusy();
  }
  paintAttack4();
}

function showConnect() {
  const connect = $("connect-btn");
  const disconnect = $("disconnect-btn");
  if (connect) connect.hidden = false;
  if (disconnect) disconnect.hidden = true;
}

function showDisconnect(account) {
  const connect = $("connect-btn");
  const disconnect = $("disconnect-btn");
  const name = $("disconnect-account");
  if (name) name.textContent = account || visitor || "";
  if (connect) connect.hidden = true;
  if (disconnect) disconnect.hidden = false;
}

function lockAttacks(message) {
  balanceLocked = true;
  const note = $("gas-lock");
  if (note) {
    note.hidden = false;
    note.textContent = message || t("gasLock", "This account needs at least 0.003 testnet NEAR for the prepaid gas. The wallet window stays closed.");
  }
  ["attack-1", "attack-2", "attack-3", "attack-4"].forEach((id) => {
    const button = $(id);
    if (button) button.disabled = true;
  });
}

function unlockAttacks() {
  balanceLocked = false;
  balanceProblem = "ok";
  const note = $("gas-lock");
  if (note) {
    note.hidden = true;
    note.textContent = "";
  }
  setBusy(isBusy());
}

async function guardBalance() {
  if (!visitor) return false;
  try {
    const amount = await accountBalance(visitor);
    faucetYocto = String(amount);
    faucetState = "ready";
    paintFaucetNeed();
    if (BigInt(amount) >= MIN_SEND_YOCTO) {
      unlockAttacks();
      return true;
    }
    balanceProblem = "low";
    lockAttacks(t("gasLock", "This account needs at least 0.003 testnet NEAR for the prepaid gas. The wallet window stays closed."));
    return false;
  } catch (e) {
    faucetYocto = null;
    faucetState = "unread";
    paintFaucetNeed();
    balanceProblem = "rpc";
    lockAttacks(t("notSentRpc", "Not sent. The public RPC could not be reached."));
    return false;
  }
}

function paintWalletError() {
  const node = $("wallet-error");
  if (!node) return;
  if (!walletErrorCode) {
    node.hidden = true;
    node.textContent = "";
    delete node.dataset.failure;
    return;
  }
  node.hidden = false;
  node.dataset.state = "failure";
  node.dataset.failure = walletErrorCode;
  node.textContent = notSentText(walletErrorCode === "wallet-reject" ? "cancel" : walletErrorCode);
}

function showWalletError(kind) {
  walletErrorCode = kind;
  paintWalletError();
}

function clearWalletError() {
  walletErrorCode = null;
  paintWalletError();
}

function show(next) {
  if (!next) {
    view = null;
    paintView();
    return;
  }
  if (next.kind === "busy") {
    view = next;
    paintView();
    return;
  }
  view = null;
  results.unshift(next);
  if (results.length > MAX_RESULTS) results.length = MAX_RESULTS;
  paintView();
}

function paintView() {
  const list = $("result-list");
  if (!list) return;
  list.textContent = "";
  if (view && view.kind === "busy") {
    list.appendChild(renderView(view));
  }
  results.forEach((state, index) => {
    const card = renderView(state);
    if (index === 0 && !(view && view.kind === "busy")) card.id = "cg-state-card";
    list.appendChild(card);
  });
}

function attackLine(state) {
  if (!state.attack) return null;
  return el("p", "result-attack", t("attackCard", "Attack {n}").replace("{n}", String(state.attack)));
}

function renderView(state) {
  if (state.kind === "busy") {
    const card = el("article", "result-card");
    card.dataset.state = "loading";
    card.dataset.verdict = "busy";
    if (state.attack) card.dataset.attack = String(state.attack);
    const heading = attackLine(state);
    if (heading) card.appendChild(heading);
    card.appendChild(el("p", "result-note", t("running", "Running…")));
    return card;
  }
  if (state.kind === "not-sent") {
    const card = el("article", "result-card");
    card.dataset.state = "empty";
    card.dataset.verdict = "none";
    card.dataset.failure = state.code || "generic";
    if (state.attack) card.dataset.attack = String(state.attack);
    const heading = attackLine(state);
    if (heading) card.appendChild(heading);
    card.appendChild(el("p", "result-note", notSentText(state.code, state.rpcMessage)));
    const when = formatWhen(state.at || Date.now());
    const meta = el("p", "result-meta");
    meta.appendChild(el("span", null, when.clock + " "));
    meta.appendChild(el("span", "tz", when.tz));
    if (state.tx) meta.appendChild(txLink(state.tx));
    card.appendChild(meta);
    return card;
  }
  const kind = state.verdict || "unknown";
  const card = el("article", "result-card");
  card.dataset.state = kind === "paid" ? "success" : kind === "held" ? "loading" : "failure";
  card.dataset.verdict = kind;
  if (state.attack) card.dataset.attack = String(state.attack);
  const heading = attackLine(state);
  if (heading) card.appendChild(heading);
  if (state.attack === 4 && state.reason === "invalid pending signature") {
    const line = el("p", "verdict-line");
    line.appendChild(svgIcon(verdictIcon(kind)));
    line.appendChild(el("span", null, t("attack4Result", "The gate refused it because the approval stamp is fake (invalid pending signature). Paid 0 NEAR.")));
    card.appendChild(line);
    if (typeof state.rawError === "string" && state.rawError !== "") {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = t("viewRaw", "View raw");
      const raw = document.createElement("p");
      raw.className = "mono";
      raw.appendChild(document.createTextNode(state.rawError));
      details.appendChild(summary);
      details.appendChild(raw);
      card.appendChild(details);
    }
    if (state.tx) {
      const meta = el("p", "result-meta");
      meta.appendChild(txLink(state.tx));
      card.appendChild(meta);
    }
    return card;
  }
  const line = el("p", "verdict-line");
  line.appendChild(svgIcon(verdictIcon(kind)));
  line.appendChild(el("span", null, verdictText(kind, state.reason)));
  card.appendChild(line);
  const reason = el("p", "result-reason");
  const label = t("reasonLabel", "Reason");
  reason.appendChild(document.createTextNode(label + ": "));
  if (state.reason) {
    reason.appendChild(el("span", "mono", state.reason));
    reason.appendChild(document.createTextNode(" \u2014 " + reasonSentence(state.reason)));
  } else {
    reason.appendChild(document.createTextNode("\u2014 " + reasonSentence("")));
  }
  card.appendChild(reason);
  if (typeof state.rawError === "string" && state.rawError !== "") {
    const rawLine = el("p", "result-raw");
    rawLine.appendChild(document.createTextNode(t("nodeSaidLabel", "The node returned") + ": "));
    rawLine.appendChild(el("span", "mono", state.rawError));
    card.appendChild(rawLine);
  }
  const paid = el("p", "result-paid");
  const amount = state.paidNear == null
    ? t("paidUnread", "Paid: not read")
    : t("paidLine", "Paid: {amount} NEAR").replace("{amount}", state.paidNear);
  paid.appendChild(el("span", null, amount));
  if (state.tx) paid.appendChild(txLink(state.tx));
  const when = formatWhen(state.at || Date.now());
  const meta = el("span", "result-meta");
  const fromTpl = t("fromLine", "from {account}");
  if (fromTpl.indexOf("{account}") !== -1) {
    const bits = fromTpl.split("{account}");
    if (bits[0]) meta.appendChild(document.createTextNode(bits[0]));
    meta.appendChild(el("span", "acct", state.sender || ""));
    if (bits[1]) meta.appendChild(document.createTextNode(bits[1]));
  } else {
    meta.appendChild(el("span", "acct", state.sender || ""));
    meta.appendChild(document.createTextNode(fromTpl));
  }
  meta.appendChild(document.createTextNode(" · "));
  meta.appendChild(el("span", null, when.clock + " "));
  meta.appendChild(el("span", "tz", when.tz));
  paid.appendChild(meta);
  card.appendChild(paid);
  return card;
}

function setBusy(on) {
  ["attack-1", "attack-2", "attack-3", "attack-4"].forEach((id) => {
    const button = $(id);
    if (button) {
      button.hidden = false;
      button.disabled = on || balanceLocked;
    }
  });
}

async function ensureVisitor() {
  if (visitor) return visitor;
  if (wallet && typeof wallet.getAccounts === "function") {
    const accounts = await wallet.getAccounts();
    visitor = accounts && accounts[0] && accounts[0].accountId;
  }
  return visitor || null;
}

async function refreshHolds() {
  holdState = { mode: "loading", count: holdState.count || 0 };
  paintHolds();
  try {
    const items = await listOpenHolds();
    const open = Array.isArray(items) ? items : [];
    const first = open.length ? open[0] : null;
    knownHoldId = first && first.id != null && first.id !== "" ? first.id : null;
    holdState = { mode: open.length ? "ready" : "empty", count: open.length };
    paintHolds();
  } catch (e) {
    holdState = { mode: "fail", count: 0 };
    paintHolds();
  }
}

async function onAttack(n) {
  const at = Date.now();
  if (isBusy()) {
    show({ kind: "not-sent", code: "busy", attack: n, at });
    return;
  }
  lastPreview = null;
  paintPreview(null);
  clearWalletError();
  if (!wallet) {
    show({ kind: "not-sent", code: "connect", attack: n, at });
    return;
  }
  try {
    await ensureVisitor();
  } catch (e) {
    visitor = null;
  }
  if (!visitor) {
    show({ kind: "not-sent", code: "no-account", attack: n, at });
    return;
  }
  const enough = await guardBalance();
  if (!enough) {
    show({ kind: "not-sent", code: !visitor ? "no-account" : balanceProblem === "rpc" ? "rpc" : "balance", attack: n, at });
    return;
  }
  show({ kind: "busy", attack: n, at });
  setBusy(true);
  try {
    const row = await runAttack(n, wallet, ed, visitor, (info) => {
      if (n === 4) {
        if (info && info.noOpenHold) knownHoldId = null;
        else if (info && info.holdId) knownHoldId = info.holdId;
        else knownHoldId = null;
      }
      lastPreview = info || null;
      paintAttack4();
      paintPreview(info);
    });
    if (!row || row.notSent || !row.tx) {
      const code = (row && row.notSent) || "generic";
      show({
        kind: "not-sent",
        code,
        rpcMessage: (row && row.rpcMessage) || "",
        attack: n,
        at: Date.now(),
        tx: (row && row.tx) || "",
      });
    } else {
      show({
        kind: "sent",
        verdict: row.verdictKind || "unknown",
        reason: row.reason || "",
        paidNear: row.paidNear,
        tx: row.tx,
        sender: visitor || row.account || "",
        at: Date.now(),
        rawError: row.rawError || "",
        attack: n,
      });
    }
    if (n === 4) await refreshHolds();
  } catch (e) {
    const message = scrub(e && (e.message || e));
    const kind = classify(message);
    if (kind === "rpc") show({ kind: "not-sent", code: "rpc-detail", rpcMessage: message, attack: n, at: Date.now() });
    else {
      const code = kind === "wallet-reject" ? "cancel" : kind === "insufficient" ? "balance" : "generic";
      show({ kind: "not-sent", code, attack: n, at: Date.now() });
    }
  } finally {
    setBusy(false);
  }
}

const WALLET_IDS = ["meteor-wallet", "intear-wallet", "ledger", "nightly-wallet", "ethereum-wallets", "near-cli"];

async function confirmedManifest() {
  const res = await fetch("./c2/near-connect-wallets-testnet.json", { cache: "no-cache" });
  if (!res.ok) throw new Error("wallet list HTTP " + res.status);
  const listed = await res.json();
  const allow = new Set(WALLET_IDS);
  const wallets = (listed.wallets || []).filter((item) => item && allow.has(item.id) && item.features && item.features.testnet === true);
  if (!wallets.length) throw new Error("confirmed wallet missing");
  return { version: listed.version || "1.0.0", wallets };
}

function walletIdOf(w) {
  return String((w && w.manifest && w.manifest.id) || (w && w.id) || "");
}

// testnet named accounts end in .testnet; implicit (64 hex) and 0x accounts exist on testnet too.
function isTestnetAccount(id) {
  const value = String(id || "");
  return /\.testnet$/.test(value) || /^[0-9a-f]{64}$/.test(value) || /^0x[0-9a-f]{40}$/.test(value);
}

let noticeTimer = 0;
let frameWatch = null;

function noticeNode() {
  let node = $("wallet-notice");
  if (node) return node;
  node = el("div", "wallet-notice");
  node.id = "wallet-notice";
  node.setAttribute("role", "status");
  node.setAttribute("aria-live", "polite");
  node.hidden = true;
  document.body.appendChild(node);
  return node;
}

function hideNotice() {
  window.clearTimeout(noticeTimer);
  const node = $("wallet-notice");
  if (node) { node.hidden = true; node.textContent = ""; delete node.dataset.kind; }
}

// The wallet's own window (for example Intear Web) can stay blank for about 10 s after it opens.
function onBlurWhileLoading() {
  const node = $("wallet-notice");
  if (!node || node.dataset.kind !== "loading") return;
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => { if (node.dataset.kind === "loading") hideNotice(); }, 15000);
}

function showLoading() {
  if (!frameWatch && typeof MutationObserver !== "undefined") {
    frameWatch = new MutationObserver((records) => {
      const node = $("wallet-notice");
      if (!node || node.dataset.kind !== "loading") return;
      const added = records.some((r) => Array.from(r.addedNodes).some((n) => n.nodeName === "IFRAME" || (n.querySelector && n.querySelector("iframe"))));
      if (!added) return;
      window.clearTimeout(noticeTimer);
      noticeTimer = window.setTimeout(() => { if (node.dataset.kind === "loading") hideNotice(); }, 12000);
    });
    frameWatch.observe(document.body, { childList: true, subtree: true });
  }
  window.removeEventListener("blur", onBlurWhileLoading);
  window.addEventListener("blur", onBlurWhileLoading);
  const node = noticeNode();
  node.dataset.kind = "loading";
  node.textContent = "";
  node.appendChild(el("p", null, t("walletLoading", "Loading the wallet (this can take about 10 seconds)")));
  node.hidden = false;
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => { if (node.dataset.kind === "loading") hideNotice(); }, 15000);
}

function showRefused(id, walletId) {
  const meteor = walletId === "meteor-wallet";
  const node = noticeNode();
  node.dataset.kind = "mainnet";
  node.dataset.wallet = walletId || "";
  node.textContent = "";
  node.appendChild(el("p", null, meteor
    ? t("walletMainnetMeteor", "This demo runs on NEAR testnet. Mainnet accounts (.near) cannot be used here. If you have no testnet account, you can make one in Intear (about 1 minute).")
    : t("walletMainnet", "This demo runs on NEAR testnet. Mainnet accounts (.near) cannot be used here.")));
  node.appendChild(el("p", "sub", t("walletMainnetAccount", "Connected account: {account}. The page disconnected it.").replace("{account}", () => id)));
  if (!meteor) node.appendChild(el("p", "sub", t("walletMainnetHow", "Make a testnet account in Intear first. It is free. When the Intear window asks, choose Web.")));
  const row = el("div", "row");
  const outLink = (href, text) => {
    const a = el("a", "btn", text);
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
  };
  row.appendChild(outLink("https://wallet.intear.tech/", t("walletMainnetCreate", "Create a testnet account (Intear)")));
  const close = el("button", "btn", t("walletNoticeClose", "Close"));
  close.type = "button";
  close.addEventListener("click", hideNotice);
  row.appendChild(close);
  node.appendChild(row);
  node.hidden = false;
  window.clearTimeout(noticeTimer);
}

function bind() {
  const connect = $("connect-btn");
  if (!connect || connect.dataset.bound === "1") return;
  connect.dataset.bound = "1";
  paintWallet("off");
  showConnect();
  paintHolds();

  let connector = null;
  let connectorReady = Promise.resolve();
  let sessionChain = Promise.resolve();
  let connectBusy = false;

  function enqueue(fn) {
    const run = sessionChain.then(fn, fn);
    sessionChain = run.then(() => {}, () => {});
    return run;
  }

  function accountFromList(accounts) {
    const first = accounts && accounts[0];
    if (!first) return "";
    if (typeof first === "string") return first;
    return first.accountId || "";
  }

  async function liveAccount(nextWallet) {
    if (!nextWallet || typeof nextWallet.getAccounts !== "function") return "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const id = accountFromList(await nextWallet.getAccounts());
        if (id) return id;
      } catch (e) { /* the first executor iframe can return before the session is stored */ }
    }
    return "";
  }

  async function refuse(account, walletId, signedWallet) {
    wallet = null;
    visitor = null;
    restoreGen += 1;
    try {
      if (connector && typeof connector.disconnect === "function") await connector.disconnect(signedWallet);
    } catch (e) { /* local session ends either way */ }
    paintWallet("off");
    showConnect();
    clearWalletError();
    showRefused(account, walletId);
  }

  async function applyAccount(nextWallet, account) {
    if (!account) {
      visitor = null;
      paintWallet("off");
      showConnect();
      return;
    }
    if (!isTestnetAccount(account)) {
      await refuse(account, walletIdOf(nextWallet), nextWallet);
      return;
    }
    if (nextWallet) wallet = nextWallet;
    visitor = account;
    paintWallet("on", visitor);
    showDisconnect(visitor);
    clearWalletError();
    await guardBalance();
  }

  async function restoreSession() {
    if (!connector || typeof connector.getConnectedWallet !== "function") {
      paintWallet("off");
      showConnect();
      return;
    }
    const gen = ++restoreGen;
    await enqueue(async () => {
      if (gen !== restoreGen) return;
      let got = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          got = await connector.getConnectedWallet();
          break;
        } catch (e) {
          got = null;
          const message = String((e && (e.message || e)) || "");
          if (attempt === 1 || !/no accounts found/i.test(message)) break;
        }
      }
      if (gen !== restoreGen) return;
      const account = got && accountFromList(got.accounts);
      if (got && got.wallet && account) {
        await applyAccount(got.wallet, account);
        return;
      }
      if (!visitor) {
        paintWallet("off");
        showConnect();
      }
    });
  }

  async function setupConnector() {
    try {
      const manifest = await confirmedManifest();
      connector = new NearConnector({
        network: "testnet",
        footerBranding: null,
        autoConnect: true,
        manifest,
      });
    } catch (e) {
      showWalletError("generic");
      connector = null;
      return;
    }
    if (connector && typeof connector.on === "function") {
      connector.on("wallet:signIn", (payload) => {
        const nextWallet = (payload && payload.wallet) || null;
        if (nextWallet) wallet = nextWallet;
        if (connectBusy) return;
        const gen = restoreGen;
        enqueue(async () => {
          if (gen !== restoreGen) return;
          const id = await liveAccount(nextWallet || wallet);
          if (gen !== restoreGen) return;
          await applyAccount(nextWallet || wallet, id);
        }).catch(() => {
          if (gen === restoreGen && !visitor) {
            paintWallet("off");
            showConnect();
          }
        });
      });
      connector.on("wallet:signOut", () => {
        wallet = null;
        visitor = null;
        restoreGen += 1;
        unlockAttacks();
        paintWallet("off");
        showConnect();
      });
    }
    try {
      await restoreSession();
    } catch (e) {
      if (!visitor) {
        paintWallet("off");
        showConnect();
      }
    }
  }

  connect.addEventListener("click", async () => {
    try { await connectorReady; } catch (e) { /* setup already reported the error */ }
    if (!connector) {
      showWalletError("generic");
      return;
    }
    restoreGen += 1;
    const gen = restoreGen;
    visitor = null;
    paintWallet("connecting");
    clearWalletError();
    hideNotice();
    showLoading();
    connectBusy = true;
    try {
      await enqueue(async () => {
        if (gen !== restoreGen) return;
        let next = null;
        try {
          next = await connector.connect();
        } catch (e) {
          const message = String((e && (e.message || e)) || "");
          if (/failed to sign in/i.test(message) && typeof connector.getConnectedWallet === "function") {
            try {
              const got = await connector.getConnectedWallet();
              const id = got && accountFromList(got.accounts);
              if (gen !== restoreGen) return;
              if (got && got.wallet && id) {
                await applyAccount(got.wallet, id);
                return;
              }
            } catch (err) { /* the original sign-in error is shown below */ }
          }
          throw e;
        } finally {
          const node = $("wallet-notice");
          if (node && node.dataset.kind === "loading") hideNotice();
        }
        if (gen !== restoreGen) return;
        if (next) wallet = next;
        const id = await liveAccount(next || wallet);
        if (gen !== restoreGen) return;
        await applyAccount(next || wallet, id);
      });
    } catch (e) {
      if (gen !== restoreGen) return;
      visitor = null;
      paintWallet("off");
      showConnect();
      const kind = classify(scrub(e && (e.message || e)));
      const closed = /wallet closed|no wallet selected|user rejected|failed to sign in/i.test(String((e && (e.message || e)) || ""));
      showWalletError(closed || kind === "wallet-reject" || kind === "cancel" ? "connect-cancel" : kind);
    } finally {
      connectBusy = false;
    }
  });

  const disconnect = $("disconnect-btn");
  if (disconnect) {
    disconnect.addEventListener("click", async () => {
      try { await connectorReady; } catch (e) { /* setup already reported the error */ }
      if (!connector || typeof connector.disconnect !== "function") {
        showWalletError("generic");
        return;
      }
      paintWallet("connecting");
      try {
        await connector.disconnect();
        wallet = null;
        visitor = null;
        restoreGen += 1;
        unlockAttacks();
        paintWallet("off");
        showConnect();
        clearWalletError();
      } catch (e) {
        if (visitor) {
          paintWallet("on", visitor);
          showDisconnect(visitor);
        } else {
          paintWallet("off");
          showConnect();
        }
        const kind = classify(scrub(e && (e.message || e)));
        showWalletError(kind === "generic" ? "wallet-reject" : kind);
      }
    });
  }

  document.querySelectorAll("[data-attack]").forEach((button) => {
    button.addEventListener("click", () => {
      const n = Number(button.getAttribute("data-attack"));
      if (n >= 1 && n <= 4) onAttack(n);
    });
  });

  document.addEventListener("chopgate:lang", (ev) => {
    if (ev.detail && ev.detail.strings) langPack = ev.detail;
    paintWallet(walletMode, visitor);
    if (walletMode === "on") showDisconnect(visitor);
    else if (walletMode !== "connecting") showConnect();
    paintHolds();
    paintWalletError();
    if (balanceLocked) {
      const note = $("gas-lock");
      if (note && !note.hidden) {
        note.textContent = balanceProblem === "rpc"
          ? t("notSentRpc", "Not sent. The public RPC could not be reached.")
          : t("gasLock", "This account needs at least 0.003 testnet NEAR for the prepaid gas. The wallet window stays closed.");
      }
    }
    paintView();
    paintCost();
    paintAttack4();
    paintPreview(lastPreview);
  });

  connectorReady = setupConnector().catch(() => {
    paintWallet("off");
    showConnect();
  });
  refreshHolds();
  loadGateCost();
  document.documentElement.dataset.tryReady = "1";
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
else bind();
