import { loadI18n, t, toggleLang, currentLang } from "./i18n.mjs";
import { sprite } from "./icons.mjs";
import { el, icon, field, copyText, reasonLine, skeleton, failureState } from "./dom.mjs";
import { mountChrome, walletCreateHint } from "./shell.mjs";
import { walletAccount, connectWallet, disconnectWallet, sendActions, sendCall, walletSendCount } from "./wallet.mjs";
import { createAgentKey, createStamp, downloadBackup, importStamp, stampFromRecord, verifiedStamp } from "./keys.mjs";
import { loadDevice, patchDevice, readLastWithdrawNonce, readStampSlot, rememberGate, rememberMandate, rememberedOwner, writeLastWithdrawNonce } from "./store.mjs";
import { isCancelError, runSigningFlow, failureKey, bumpOnRetry } from "./flow.mjs";
import {
  GAS_CALL, GAS_HEAVY, GAS_LIGHT, U128_MAX, U32_MAX,
  accountOf, availableBalance, factoryState, finishTx, isEmptyCode, loadHistory, loadWithdrawNonceMax, lookupOwnerGate, mandatePayload,
  nextWithdrawNonce, ownerSignature, probeOutcome, readPending, readRemaining, readRules, reloadHistoryRow, rulesPayload, signatureDomain,
  tier2Payload, u128, pendingPayload, clearCache, verifyGateForOwner, withdrawCallParts, withdrawPayload,
} from "./chain.mjs";
import { flowView, historyView, pendingView, rulesView, unconfirmedPanel } from "./panels.mjs";
import {
  REREAD_MS, SILENT_MS, decideOutcome, depositLanded, lockView, partialRulesKey, rulesEqual, tier2Equal,
} from "./confirm.mjs";
import {
  countdown, formatKst, nearToYocto, nowNs, rawInt, validAccount, yoctoToNear,
} from "./format.mjs";
import { withdrawalSlack } from "./storage.mjs";
import {
  AGENT_ACCOUNT_FUNDING_NEAR, AGENT_METHOD_NAMES, FAUCET_URL,
  FEATURE_CREATE_AGENT_ACCOUNT, FALLBACK_TOTAL_NEAR, GAS_MARGIN_NEAR, TESTNET, explorerAddressUrl, explorerTxUrl,
} from "./network.mjs";
import {
  MIN_SEND_YOCTO, createGatePlan, createdGateView, findGateAgain, formatNeed, gateAccountId, gateAmount, stampKeyMatch,
} from "./gateplan.mjs";
import { sha256hex } from "./encoder.mjs";
import { authorizationBytes } from "./encoder.mjs";
import { chainEntries, withJobIds } from "./original.mjs";

const STEPS = ["wallet", "key", "gate", "funds", "rules", "mandates", "approvals", "history"];
const state = {
  step: "wallet",
  stamp: null,
  derivedStamp: null,
  stampSlot: "missing",
  stampCheck: "",
  gateId: "",
  busy: false,
  phase: "idle",
  notice: "",
  noticeKey: "",
  understand: false,
  factory: undefined,
  factoryError: null,
  balance: null,
  computedGate: "",
  viewGate: "",
  gateMismatch: false,
  gateFromFactory: false,
  txUrl: "",
  pendingTxUrl: "",
  escrow: null,
  storageSlack: null,
  storageUnread: false,
  rules: null,
  tier2: null,
  pending: null,
  history: null,
  readError: null,
  fieldError: "",
  label: "",
  paste: "",
  checkNote: "",
  amount: "",
  recipient: "",
  recipientEdited: false,
  withdrawAmount: "",
  withdrawNonce: "",
  withdrawNonceUsed: false,
  withdrawPanic: "",
  withdrawResult: false,
  withdrawing: false,
  agent: "",
  budget: "",
  expiry: "",
  jobs: [{ target: "", max: "", instruction: "" }],
  agentName: "agent",
  agentKey: null,
  payees: [{ alias: "", account: "" }],
  ruleDraft: null,
  review: "",
  lockFor: "",
  lastAction: "",
  lastDecide: null,
  holdRetry: false,
  importSlotTaken: false,
  importReplaceArmed: false,
  importUnreadable: false,
  confirm: null,
};

/** File text for the replace-key step only. Cleared after replace, cancel, or leaving the key step. */
let pendingImportText = "";
let showAgentSecret = false;

const ACTION_STEP = {
  deposit: "funds",
  withdraw: "funds",
  storage: "funds",
  rules: "rules",
  create: "gate",
  mandate: "mandates",
  agent: "mandates",
  approve: "approvals",
  reject: "approvals",
  expire: "approvals",
};

function backupReady() {
  const key = state.derivedStamp?.publicKey || "";
  if (!key) return false;
  return loadDevice().backupFor === key;
}

function clearActionNotice() {
  if (state.confirm?.locked) return;
  state.noticeKey = "";
  state.notice = "";
  state.lastAction = "";
  state.lastDecide = null;
  state.withdrawResult = false;
}

function lockReason(id) {
  const device = loadDevice();
  if (id === "gate" && !state.stamp) return t("lock.gate");
  if (["funds", "rules", "mandates", "approvals", "history"].includes(id) && !state.gateId) return t("lock.needGate");
  if (id === "funds" && state.gateId && !device.backupDownloaded) return "";
  return "";
}

const OWNER_STEPS = ["funds", "rules", "mandates", "approvals"];

function stepStatus(id) {
  if (lockReason(id)) return "locked";
  if (state.step === id) return "active";
  // Label only: these steps stay viewable, but their owner buttons are disabled while the stamp check does not pass.
  if (OWNER_STEPS.includes(id) && ownerLockText()) return "locked";
  if (id === "wallet" && walletAccount()) return "done";
  if (id === "key" && state.stamp && backupReady()) return "done";
  if (id === "gate" && state.gateId && state.stampCheck === "match") return "done";
  return "open";
}

function statusLabel(kind) {
  return t(`step.${kind === "locked" ? "locked" : kind === "done" ? "done" : kind === "active" ? "active" : "open"}`);
}

function stepButton(id) {
  const kind = stepStatus(id);
  const button = el("button", {
    type: "button",
    class: "tap",
    "data-act": `step-${id}`,
    "data-state": kind,
    "aria-current": state.step === id ? "step" : null,
  }, icon(kind === "done" ? "check" : kind === "locked" ? "lock" : "dot"), el("span", {}, t(`step.${id}`)), el("span", {}, statusLabel(kind)));
  button.addEventListener("click", () => {
    if (lockReason(id)) {
      state.lockFor = id;
      state.noticeKey = "";
      renderMain();
      return;
    }
    location.hash = id;
  });
  return button;
}

function input(act, value, onValue, type = "text") {
  const node = el("input", { id: act, type, "data-act": act, value: value ?? "" });
  node.addEventListener("input", () => onValue(node.value));
  return node;
}

function area(act, value, onValue) {
  const node = el("textarea", { id: act, "data-act": act }, value || "");
  node.addEventListener("input", () => onValue(node.value));
  return node;
}

function checkControl(act, role, checked, label, onToggle) {
  const button = el("button", {
    type: "button",
    class: "tap check",
    role,
    "data-act": act,
    "aria-checked": checked ? "true" : "false",
  }, icon(checked ? "check" : "dot"), el("span", {}, label));
  button.addEventListener("click", onToggle);
  return button;
}

const CONTROL_ACTION = {
  "create-gate": "create",
  deposit: "deposit",
  withdraw: "withdraw",
  "storage-transfer": "storage",
  "save-rules": "rules",
  "issue-mandate": "mandate",
  "create-agent": "agent",
};

let lastSentAt = 0;
let confirmTimers = [];
let confirmGen = 0;

// One confirmation slot: while any sent transaction is unconfirmed, every send stays locked,
// so a second action cannot replace the first watch and unlock it.
function actionHeld(action) {
  return !!action && !!state.confirm?.locked;
}

function buttonHeld(button) {
  const action = CONTROL_ACTION[button?.getAttribute?.("data-act") || ""] || "";
  return !!action && actionHeld(action);
}

function disable(button, why) {
  const held = buttonHeld(button);
  if (!why && !state.busy && !held) return button;
  button.disabled = true;
  if (why) button.dataset.disabledReason = why;
  else if (held) button.dataset.disabledReason = t("tx.pendingLock");
  else if (!button.dataset.disabledReason) button.dataset.disabledReason = t("flow.working");
  return button;
}

function clearConfirmTimers() {
  for (let i = 0; i < confirmTimers.length; i += 1) clearTimeout(confirmTimers[i]);
  confirmTimers = [];
}

function armConfirmTimers(sentAt) {
  clearConfirmTimers();
  const origin = sentAt || Date.now();
  for (let i = 0; i < REREAD_MS.length; i += 1) {
    const index = i;
    const wait = Math.max(0, origin + REREAD_MS[i] - Date.now());
    confirmTimers.push(setTimeout(() => { confirmTick({ scheduledIndex: index }).catch(() => {}); }, wait));
  }
  const silentWait = Math.max(0, origin + SILENT_MS - Date.now());
  confirmTimers.push(setTimeout(() => { refreshSilence(); }, silentWait));
}

function refreshSilence() {
  const ctx = state.confirm;
  if (!ctx?.locked) return;
  const view = lockView({
    outcome: "unconfirmed",
    elapsedMs: Date.now() - ctx.sentAt,
    // Without a tx hash nothing can prove the tx absent, so the 2 minute explorer button is offered.
    anyRpcAnswered: ctx.txHash ? ctx.anyRpcAnswered : false,
  });
  ctx.offerOverride = view.offerOverride;
  renderMain();
}

async function applySettle(outcome, ctx) {
  if (outcome === "success") {
    state.phase = "confirmed";
    state.noticeKey = "";
    state.notice = "";
    state.lastAction = "";
    state.lastDecide = null;
    if (ctx.onSuccess) await ctx.onSuccess();
    return;
  }
  if (outcome === "failed") {
    state.phase = "idle";
    state.noticeKey = "flow.failed";
    state.notice = "";
    state.lastAction = ctx.action || state.lastAction;
    if (ctx.onFailure) await ctx.onFailure();
    return;
  }
  state.phase = "idle";
  state.noticeKey = "";
  state.notice = "";
  state.lastAction = ctx.action || "";
  if (ctx.onAbsent) await ctx.onAbsent();
}

async function confirmTick({ scheduledIndex = -1, manual = false } = {}) {
  const ctx = state.confirm;
  if (!ctx?.locked) return;
  const gen = ctx.gen;
  const elapsed = Date.now() - ctx.sentAt;
  const last = scheduledIndex === REREAD_MS.length - 1 || (manual && elapsed >= REREAD_MS[REREAD_MS.length - 1]);
  let attempts = [];
  if (ctx.txHash && ctx.signer) {
    const probed = await probeOutcome(ctx.txHash, ctx.signer);
    if (!state.confirm || state.confirm.gen !== gen) return;
    attempts = probed.attempts;
    if (probed.anyAnswered) state.confirm.anyRpcAnswered = true;
  }
  let effect = null;
  if (ctx.readEffect) {
    try { effect = await ctx.readEffect(); } catch { effect = null; }
    if (!state.confirm || state.confirm.gen !== gen) return;
    if (effect === true || effect === false) state.confirm.anyRpcAnswered = true;
  }
  if (state.confirm?.terminalKey) {
    const key = state.confirm.terminalKey;
    clearConfirmTimers();
    state.confirm = null;
    state.phase = "idle";
    state.noticeKey = key;
    state.notice = "";
    renderMain();
    return;
  }
  const decision = decideOutcome({
    attempts,
    effect,
    action: ctx.action,
    isScheduledLast: last,
  });
  if (!state.confirm || state.confirm.gen !== gen) return;
  if (decision.anyAnswered) state.confirm.anyRpcAnswered = true;
  if (decision.outcome === "success" || decision.outcome === "failed" || decision.outcome === "absent") {
    const claimed = state.confirm;
    state.confirm = null;
    clearConfirmTimers();
    await applySettle(decision.outcome, claimed);
    renderMain();
    return;
  }
  const view = lockView({
    outcome: "unconfirmed",
    elapsedMs: Date.now() - ctx.sentAt,
    anyRpcAnswered: ctx.txHash ? state.confirm.anyRpcAnswered : false,
  });
  state.confirm.locked = true;
  state.confirm.offerOverride = view.offerOverride;
  renderMain();
}

async function beginWatch(ctx) {
  const gen = ++confirmGen;
  const sentAt = ctx.sentAt || lastSentAt || Date.now();
  state.confirm = {
    gen,
    action: ctx.action,
    txHash: ctx.txHash || "",
    signer: ctx.signer || "",
    sentAt,
    locked: true,
    offerOverride: false,
    anyRpcAnswered: false,
    terminalKey: "",
    readEffect: ctx.readEffect || null,
    onSuccess: ctx.onSuccess || null,
    onFailure: ctx.onFailure || null,
    onAbsent: ctx.onAbsent || null,
  };
  state.phase = "idle";
  state.noticeKey = "tx.unconfirmed";
  state.notice = ctx.notice || "";
  state.lastAction = ctx.action || state.lastAction;
  if (ctx.txHash) state.txUrl = explorerTxUrl(ctx.txHash);
  state.pendingTxUrl = ctx.txHash ? explorerTxUrl(ctx.txHash) : "";
  armConfirmTimers(sentAt);
  await confirmTick({ manual: true, scheduledIndex: -1 });
}

function acceptExplorerOverride() {
  if (!state.confirm?.offerOverride) return;
  clearConfirmTimers();
  state.confirm = null;
  state.noticeKey = "";
  state.notice = "";
  renderMain();
}

async function depositWatchEffect(gateId, before, sent) {
  try {
    const data = await readRules(gateId, { fresh: true });
    return depositLanded(before, sent, data?.escrow);
  } catch {
    return null;
  }
}

async function spendWatchEffect(gateId, sent) {
  try {
    const data = await readRules(gateId, { fresh: true });
    return rulesEqual(data?.rules, sent);
  } catch {
    return null;
  }
}

async function tier2WatchEffect(gateId, sent) {
  try {
    const data = await readRules(gateId, { fresh: true });
    return tier2Equal(data?.tier2, sent);
  } catch {
    return null;
  }
}

/** Keep public stamp fields only. The seed bytes are wiped here and never stored on state. */
function rememberStamp(stamp) {
  if (stamp?.seed && typeof stamp.seed.fill === "function") stamp.seed.fill(0);
  const pub = stamp ? {
    publicKey: stamp.publicKey || "",
    storedPublicKey: stamp.storedPublicKey || "",
    storedMatches: !!stamp.storedMatches,
  } : null;
  state.derivedStamp = pub;
  state.stamp = pub ? pub.publicKey : null;
  return pub;
}

async function refreshStamp() {
  const slot = await readStampSlot();
  state.stampSlot = slot.status;
  const live = slot.status === "present" ? await stampFromRecord(slot.record) : null;
  if (slot.status === "present" && !live) state.stampSlot = "corrupt";
  const stamp = rememberStamp(live);
  if (!state.gateId) return;
  if (!stamp) state.stampCheck = "no-stamp";
  else if (!stamp.storedMatches) state.stampCheck = "tampered";
  else if (state.stampCheck === "no-stamp" || state.stampCheck === "tampered") state.stampCheck = "";
}

function ownerLockText() {
  if (!state.gateId) return "";
  if (state.stampCheck === "match") return "";
  if (state.stampCheck === "unread") return t("state.fail");
  if (state.stampCheck === "bad-chain") return t("gate.badChain");
  if (state.stampCheck === "no-stamp" || state.stampCheck === "different-key" || state.stampCheck === "tampered") {
    return t("gate.stampMismatch");
  }
  if (!state.derivedStamp || !state.derivedStamp.storedMatches) return t("gate.stampMismatch");
  return t("state.loading");
}

function stampMismatchNodes() {
  const why = ownerLockText();
  if (state.stampCheck === "bad-chain") return [reasonLine(why)];
  if (why !== t("gate.stampMismatch")) return [];
  return [reasonLine(why), importBackupButton()];
}

async function readOwnerMatch(gateId) {
  const live = await verifiedStamp();
  const stamp = rememberStamp(live);
  let domain = null;
  let domainRead = false;
  if (stamp?.storedMatches && gateId) {
    try {
      domain = await signatureDomain(gateId);
      domainRead = true;
    } catch (error) {
      if (error?.kind === "domain") {
        return {
          stamp,
          domain: null,
          unlocked: false,
          mismatch: false,
          reason: "bad-chain",
          sentenceKey: "gate.badChain",
        };
      }
      domainRead = false;
    }
  } else {
    domainRead = true;
  }
  const match = stampKeyMatch({
    gateOwner: domain?.owner || "",
    derivedPublicKey: stamp?.publicKey || "",
    storedPublicKey: stamp?.storedPublicKey || "",
    domainRead,
  });
  return { stamp, domain, ...match };
}

async function ensureOwnerStamp() {
  if (!state.gateId) {
    await refreshStamp();
    return null;
  }
  const match = await readOwnerMatch(state.gateId);
  state.stampCheck = match.reason;
  return match;
}

function applyStampResult(match) {
  state.stampCheck = match.reason;
  if (match.unlocked) return;
  state.checkNote = t(match.sentenceKey || "gate.stampMismatch");
}

function selectedGate() {
  const saved = loadDevice().gates || [];
  if (state.gateId) return state.gateId;
  if (saved[0]?.id) state.gateId = saved[0].id;
  return state.gateId;
}

async function bootData() {
  selectedGate();
  await refreshStamp();
  const hash = location.hash.replace("#", "");
  state.step = STEPS.includes(hash) ? hash : "wallet";
  if (lockReason(state.step)) state.lockFor = state.step;
}

function noticeBox() {
  if (state.confirm?.locked || state.noticeKey === "tx.unconfirmed") {
    const extra = state.notice ? reasonLine(state.notice) : null;
    return el("div", { class: "stack" },
      extra,
      unconfirmedPanel({
        txUrl: state.pendingTxUrl,
        offerOverride: !!state.confirm?.offerOverride,
        onCheck: () => { confirmTick({ manual: true, scheduledIndex: -1 }).catch(() => {}); },
        onOverride: () => { acceptExplorerOverride(); },
      }),
    );
  }
  if (state.noticeKey) return reasonLine(t(state.noticeKey));
  if (state.notice) return reasonLine(state.notice);
  return null;
}

function noteTx(parsed) {
  if (parsed?.ok === true) {
    state.phase = "confirmed";
    state.noticeKey = "";
    state.notice = parsed.txHash || "";
    state.lastAction = "";
    state.lastDecide = null;
    return "confirmed";
  }
  if (parsed == null || parsed.ok == null) {
    state.phase = "idle";
    state.noticeKey = "tx.unconfirmed";
    state.notice = "";
    if (parsed?.txHash) state.txUrl = explorerTxUrl(parsed.txHash);
    state.pendingTxUrl = parsed?.txHash ? explorerTxUrl(parsed.txHash) : "";
    return "unconfirmed";
  }
  state.phase = "idle";
  state.noticeKey = failureKey(parsed);
  state.notice = parsed.panic || "";
  return "failed";
}

/** NEAR Connect rejects with these when the selector or the wallet window is closed. */
function isConnectClosed(error) {
  return /wallet closed|no wallet selected|user rejected|failed to sign in|selector closed/i.test(String(error?.message || error || ""));
}

async function connectFromAnywhere() {
  document.querySelectorAll("[data-act=wallet], [data-act=connect]").forEach((button) => { button.disabled = true; });
  try {
    await connectWallet();
    state.noticeKey = "";
    state.notice = "";
    state.lastAction = "";
  } catch (error) {
    state.noticeKey = error?.kind === "mainnet" ? (error.walletId === "meteor-wallet" ? "wallet.mainnetMeteor" : "wallet.mainnet") : (isCancelError(error) || isConnectClosed(error)) ? "wallet.connectCancelled" : "wallet.connectFailed";
    state.notice = "";
    state.lastAction = "";
  }
  if (!walletAccount()) {
    state.balance = null;
    state.computedGate = "";
  }
  try { chromePaint(); } catch { /* header mounts with the page */ }
  renderMain();
  if (walletAccount() && (state.step === "gate" || state.step === "funds")) ensureGate(true).catch(() => {});
}

async function disconnectFromAnywhere() {
  try { await disconnectWallet(); } catch { /* local session still ends */ }
  state.noticeKey = "";
  state.notice = "";
  state.lastAction = "";
  state.balance = null;
  state.computedGate = "";
  try { chromePaint(); } catch { /* header mounts with the page */ }
  renderMain();
}

/** a way to look around before any wallet works. Tour and Proof need no wallet. */
function noWalletPath() {
  return el("div", { class: "stack", "data-part": "no-wallet" },
    el("h3", {}, t("wallet.noWallet")),
    el("p", { class: "help" }, t("wallet.noWalletHelp")),
    el("div", { class: "row" },
      el("a", { class: "tap", href: "../tour/", "data-act": "no-wallet-tour" }, t("wallet.noWalletTour")),
      el("a", { class: "tap", href: "../verify/", "data-act": "no-wallet-proof" }, t("wallet.noWalletProof")),
    ),
  );
}

function walletStep() {
  return el("section", { class: "step-panel stack", id: "panel-wallet" },
    el("h2", {}, t("step.wallet")),
    el("p", {}, t("wallet.line")),
    noWalletPath(),
    el("h3", {}, t("wallet.g1")),
    el("p", { class: "help" }, t("wallet.g1help")),
    el("a", { class: "tap", href: TESTNET.walletCreate, target: "_blank", rel: "noopener", "data-act": "guide-wallet" }, t("wallet.g1link")),
    el("p", { class: "help" }, t("wallet.chooseWeb")),
    el("h3", {}, t("wallet.g2")),
    el("p", { class: "help" }, t("wallet.g2help")),
    FAUCET_URL ? el("a", { class: "tap", href: FAUCET_URL, target: "_blank", rel: "noopener", "data-act": "guide-faucet" }, t("wallet.g2link")) : null,
    el("h3", {}, t("wallet.g3")),
    el("p", { class: "help" }, t("wallet.g3help")),
    walletAccount()
      ? el("div", { class: "row" },
        el("span", { class: "chip" }, walletAccount()),
        el("button", {
          type: "button",
          class: "tap",
          "data-act": "disconnect",
          onClick: () => disconnectFromAnywhere(),
        }, t("nav.disconnect")),
      )
      : el("button", {
        type: "button",
        class: "tap primary",
        "data-act": "connect",
        onClick: () => connectFromAnywhere(),
      }, t("nav.connect")),
    walletAccount() ? null : el("p", { class: "help", "data-part": "intear-wait" }, t("wallet.intearWait")),
    walletCreateHint(),
    noticeBox(),
  );
}

async function selectedGateOwner() {
  if (!state.gateId) return "";
  try { return (await signatureDomain(state.gateId)).owner || ""; }
  catch (error) {
    if (error?.kind === "domain") return null;
    if (error?.kind === "rate") return { kind: "rate" };
    return undefined;
  }
}

function noteImportResult(result) {
  pendingImportText = "";
  state.importSlotTaken = false;
  state.importReplaceArmed = false;
  state.importUnreadable = false;
  if (!result.ok) {
    state.fieldError = result.error === "backup.notOwner" ? t("backup.notOwner") : t("key.badFile");
    return;
  }
  state.fieldError = "";
  state.noticeKey = "key.imported";
  state.stampCheck = "";
}

function importBackupButton() {
  const importer = el("button", { type: "button", class: "tap", "data-act": "import-backup" }, t("key.import"));
  importer.addEventListener("click", () => {
    const picker = document.createElement("input");
    picker.type = "file";
    picker.accept = "application/json,.json";
    picker.hidden = true;
    picker.addEventListener("change", async () => {
      const file = picker.files && picker.files[0];
      picker.remove();
      if (!file) return;
      const text = await file.text();
      const gateOwner = await selectedGateOwner();
      if (typeof gateOwner !== "string") {
        state.fieldError = gateOwner === null ? t("gate.badChain") : t(gateOwner?.kind === "rate" ? "state.rate" : "state.fail");
        state.noticeKey = "";
        state.notice = "";
        renderMain();
        return;
      }
      const result = await importStamp(text, { gateOwner, requireOwner: Boolean(state.gateId) });
      if (result.ok) {
        noteImportResult(result);
        await refreshStamp();
        if (state.gateId) await ensureOwnerStamp();
      } else if (result.error === "backup.slotTaken" || result.error === "backup.unreadable") {
        pendingImportText = text;
        state.importSlotTaken = true;
        state.importUnreadable = result.error === "backup.unreadable";
        state.importReplaceArmed = false;
        state.fieldError = "";
        state.notice = t(state.importUnreadable ? "backup.unreadable" : "backup.slotTaken");
        state.noticeKey = "";
      } else if (result.error === "backup.notOwner") {
        pendingImportText = "";
        state.importSlotTaken = false;
        state.importReplaceArmed = false;
        state.importUnreadable = false;
        state.fieldError = t("backup.notOwner");
      } else {
        noteImportResult(result);
      }
      renderMain();
    });
    document.body.append(picker);
    picker.click();
  });
  return importer;
}

function replaceStampNodes() {
  if (!state.importSlotTaken) return [];
  const unreadable = state.importUnreadable;
  const download = unreadable ? null : el("button", {
    type: "button",
    class: "tap",
    "data-act": "download-current-stamp",
    onClick: async () => {
      const live = await verifiedStamp();
      if (!live?.record) return;
      downloadBackup({ ...live.record, public_key: live.publicKey });
      if (live.seed) live.seed.fill(0);
      state.importReplaceArmed = true;
      renderMain();
    },
  }, t("key.download"));
  const confirm = unreadable && !state.importReplaceArmed ? el("button", {
    type: "button",
    class: "tap",
    "data-act": "confirm-replace-stamp",
    onClick: () => {
      state.importReplaceArmed = true;
      renderMain();
    },
  }, t("backup.confirm")) : null;
  const replace = state.importReplaceArmed ? el("button", {
    type: "button",
    class: "tap",
    "data-act": "replace-stamp",
    onClick: async () => {
      const text = pendingImportText;
      if (!text) return;
      const gateOwner = await selectedGateOwner();
      if (typeof gateOwner !== "string") {
        state.fieldError = gateOwner === null ? t("gate.badChain") : t(gateOwner?.kind === "rate" ? "state.rate" : "state.fail");
        state.noticeKey = "";
        state.notice = "";
        renderMain();
        return;
      }
      const result = await importStamp(text, { replace: true, gateOwner, requireOwner: Boolean(state.gateId) });
      noteImportResult(result);
      if (result.ok) {
        await refreshStamp();
        if (state.gateId) await ensureOwnerStamp();
      }
      renderMain();
    },
  }, t("backup.replace")) : null;
  const message = unreadable ? t("backup.unreadable") : t("backup.slotTaken");
  return [reasonLine(message), el("div", { class: "row" }, download, confirm, replace)];
}

function keyStep() {
  const copy = el("button", { type: "button", class: "tap", "data-act": "copy-key" }, t("copy"));
  disable(copy, state.stamp ? "" : t("key.none"));
  copy.addEventListener("click", async () => {
    if (!state.stamp) return;
    try {
      await copyText(state.stamp);
      copy.textContent = t("copied");
      window.setTimeout(() => { copy.textContent = t("copy"); }, 2000);
    } catch { /* clipboard permission is required */ }
  });
  const download = el("button", { type: "button", class: "tap", "data-act": "download-backup" }, t("key.download"));
  disable(download, state.stamp ? "" : t("key.downloadNeed"));
  download.addEventListener("click", async () => {
    const live = await verifiedStamp();
    if (!live) return;
    downloadBackup({ ...live.record, public_key: live.publicKey });
    patchDevice({ backupDownloaded: true, backupFor: live.publicKey });
    if (live.seed) live.seed.fill(0);
    state.noticeKey = "key.downloaded";
    renderMain();
  });
  const create = el("button", { type: "button", class: "tap primary", "data-act": "create-key" }, t("key.create"));
  const createWhy = state.stampSlot === "missing" ? "" : (state.stamp ? t("key.warn") : t("key.unreadable"));
  disable(create, createWhy);
  create.addEventListener("click", async () => {
    if (state.stampSlot !== "missing") return;
    const made = await createStamp();
    if (!made?.ok) {
      state.stampSlot = made?.error === "exists" ? "present" : (made?.error || "error");
      state.fieldError = t("key.unreadable");
      renderMain();
      return;
    }
    await refreshStamp();
    state.notice = "";
    state.fieldError = "";
    renderMain();
  });
  const importer = importBackupButton();
  return el("section", { class: "step-panel stack", id: "panel-key" },
    el("h2", {}, t("step.key")),
    el("p", { class: "warn card", "data-stamp-lose": "1" }, t("key.loseEscrow")),
    stampNotice(),
    el("p", { class: "warn card" }, t("key.warn")),
    el("p", { class: "card", "data-stamp-origin": "1" }, t("key.perOrigin")),
    el("p", { class: state.stamp ? "break" : "" }, state.stamp ? state.stamp : t("key.none")),
    el("p", {}, `${t("key.backup")}: ${backupReady() ? t("key.downloaded") : t("key.notYet")}`),
    el("div", { class: "row" }, create, copy, download, importer),
    ...replaceStampNodes(),
    state.stampSlot === "corrupt" || state.stampSlot === "error" ? reasonLine(t("key.unreadable")) : null,
    state.stamp ? null : reasonLine(t("key.downloadNeed")),
    state.fieldError ? el("p", { class: "field-error", role: "alert" }, state.fieldError) : null,
    noticeBox(),
  );
}

function planInputs() {
  return {
    hasStamp: !!state.stamp,
    backupReady: backupReady(),
    factoryKnown: state.factory !== undefined,
    factoryDeployed: state.factory?.deployed === true,
    factoryError: !!state.factoryError,
    requiredDeposit: state.factory?.required || null,
    requiredTotalNear: FALLBACK_TOTAL_NEAR,
    gasMarginNear: GAS_MARGIN_NEAR,
    balanceYocto: state.balance,
    walletConnected: !!walletAccount(),
    understood: !!state.understand,
    alreadyHasGate: !!state.gateFromFactory,
  };
}

function gateReasonText(plan) {
  const code = plan.reasons[0];
  if (!code) return "";
  if (code === "low-balance") {
    return t("gate.low", {
      need: formatNeed(plan.needed, FALLBACK_TOTAL_NEAR),
      have: plan.have == null ? "0" : yoctoToNear(plan.have),
    });
  }
  const keys = {
    already: "gate.already",
    "need-key": "gate.needKey",
    "need-backup": "funds.backup",
    loading: "state.loading",
    "factory-error": "state.fail",
    "factory-locked": "gate.factoryReason",
    "deposit-unread": "gate.needTotal",
    "need-wallet": "gate.balanceNeed",
    "balance-unread": "gate.balanceWait",
    "need-total": "gate.needTotal",
    "need-check": "gate.needCheck",
  };
  return t(keys[code] || "flow.failed");
}

function gateAmountLine() {
  const deposit = state.factory?.deployed === true && state.factory?.required ? state.factory.required : null;
  const parts = gateAmount(deposit);
  if (!parts.readable) return t("gate.amountFallback", { x: parts.x });
  return t("gate.amountLive", { x: parts.x, y: parts.y });
}

function gateStep() {
  const plan = createGatePlan(planInputs());
  const locked = state.factory && state.factory.deployed === false;
  const create = el("button", { type: "button", class: "tap primary", "data-act": "create-gate" }, state.busy ? t("flow.working") : t("gate.create"));
  const backupWhy = backupReady() ? "" : t("funds.backup");
  const why = gateReasonText(plan);
  disable(create, why);
  create.addEventListener("click", () => {
    if (!backupReady()) return;
    if (gateReasonText(createGatePlan(planInputs()))) return;
    createGate();
  });
  const recheck = el("button", { type: "button", class: "tap", "data-act": "check-balance" }, t("gate.recheck"));
  recheck.addEventListener("click", () => { refreshBalance(true).catch(() => {}); });
  const needLabel = plan.needed != null ? formatNeed(plan.needed, FALLBACK_TOTAL_NEAR) : gateAmount(null).x;
  const haveLabel = state.balance == null ? "" : yoctoToNear(state.balance);
  return el("section", { class: "step-panel stack", id: "panel-gate" },
    el("h2", {}, t("step.gate")),
    el("p", { class: "warn card" }, gateAmountLine()),
    el("p", {}, t("net.mainnet")),
    el("p", { class: "warn card" }, t("gate.notice")),
    state.factory === undefined ? skeleton(2, t("state.loading")) : null,
    state.factoryError ? failureState(state.factoryError, () => loadGateStep()) : null,
    locked ? el("h3", {}, t("gate.factoryLocked")) : null,
    locked ? reasonLine(t("gate.factoryReason")) : null,
    el("p", {}, `${t("gate.balance")}: ${state.balance == null ? t("gate.balanceNeed") : `${haveLabel} ${t("common.near")}`}`),
    el("p", {}, `${t("gate.required")}: ${state.factory?.required ? yoctoToNear(state.factory.required) : t("common.none")}`),
    el("p", { class: "help" }, t("gate.noList")),
    state.computedGate ? el("p", {}, el("span", { class: "lbl" }, t("gate.computed")), " ", el("span", { class: "break" }, state.computedGate)) : null,
    state.gateMismatch ? reasonLine(t("gate.mismatch")) : null,
    plan.shortfall ? el("p", {}, t("gate.low", { need: needLabel, have: haveLabel })) : null,
    plan.shortfall ? el("p", {}, t("gate.more", { x: plan.shortfall })) : null,
    plan.shortfall && FAUCET_URL ? el("a", { class: "tap", href: FAUCET_URL, target: "_blank", rel: "noopener", "data-act": "guide-faucet" }, t("gate.faucet")) : null,
    plan.shortfall ? el("p", { class: "help" }, t("gate.faucetLimit")) : null,
    recheck,
    el("div", { class: "row" },
      checkControl("understand", "checkbox", state.understand, t("gate.understand"), () => { state.understand = !state.understand; renderMain(); }),
      create,
    ),
    why ? reasonLine(why) : null,
    backupWhy && why !== backupWhy ? reasonLine(backupWhy) : null,
    backupWhy ? el("a", { class: "tap", href: "#key", "data-act": "funds-backup" }, t("funds.backupLink")) : null,
    ...stampMismatchNodes(),
    state.checkNote && !(ownerLockText() === t("gate.stampMismatch") && state.checkNote === t("gate.stampMismatch")) ? el("p", {}, state.checkNote) : null,
    field(t("gate.paste"), input("paste-gate", state.paste, (value) => { state.paste = value; })),
    el("button", {
      type: "button",
      class: "tap",
      "data-act": "use-gate",
      disabled: state.busy || null,
      onClick: () => { if (!state.busy) usePasted(); },
    }, t("gate.use")),
    state.fieldError ? el("p", { class: "field-error", role: "alert" }, state.fieldError) : null,
    ...savedGateButtons(),
    state.gateId ? el("p", { class: "break" }, state.gateId) : null,
    state.gateId ? el("button", {
      type: "button", class: "tap", "data-act": "copy-gate",
      onClick: async (event) => {
        const button = event.currentTarget;
        try {
          await copyText(state.gateId);
          button.textContent = t("copied");
          window.setTimeout(() => { button.textContent = t("gate.copy"); }, 2000);
        } catch { /* clipboard */ }
      },
    }, t("gate.copy")) : null,
    state.txUrl ? el("a", { class: "tap", href: state.txUrl, target: "_blank", rel: "noopener", "data-act": "gate-tx" }, t("gate.tx")) : null,
    flowView(state.phase),
    noticeBox(),
    tryAgainButton(),
  );
}

function savedGateButtons() {
  return (loadDevice().gates || []).filter((row) => row.id !== state.gateId).map((row) => el("button", {
    type: "button",
    class: "tap break",
    "data-act": "use-saved",
    "data-id": row.id,
    disabled: state.busy || state.confirm?.locked || null,
    onClick: () => {
      if (state.busy || state.confirm?.locked) return;
      state.gateId = row.id;
      location.hash = "funds";
    },
  }, row.id));
}

async function refreshBalance(fresh) {
  const id = walletAccount();
  if (!id) {
    state.balance = null;
    if (fresh) state.noticeKey = "gate.balanceNeed";
    if (state.step === "gate" || state.step === "funds") renderMain();
    return;
  }
  try {
    const amount = await availableBalance(id, { fresh: !!fresh });
    state.balance = amount == null ? null : amount.toString();
    if (fresh) state.noticeKey = "";
  } catch (error) {
    if (fresh) state.noticeKey = error?.kind === "rate" ? "state.rate" : "state.fail";
  }
  if (state.step === "gate" || state.step === "funds") renderMain();
}

let gateTask = null;
let gateFresh = false;
let gateGen = 0;

function ensureGate(force) {
  if (force) {
    gateFresh = false;
    gateTask = null;
  }
  if (!force && gateFresh) return Promise.resolve();
  if (!force && gateTask) return gateTask;
  const task = loadGateStep().finally(() => {
    if (gateTask === task) gateTask = null;
  });
  gateTask = task;
  return task;
}

async function loadGateStep() {
  const gen = ++gateGen;
  state.factory = undefined;
  state.factoryError = null;
  renderMain();
  try {
    const owner = walletAccount() || rememberedOwner();
    let factory;
    let localId = "";
    let viewId = "";
    let mismatch = false;
    let exists = false;
    let existsId = "";
    let found = null;
    if (owner) {
      localId = await gateAccountId(owner, TESTNET.factoryAccountId);
      found = await lookupOwnerGate(owner, localId);
      factory = found.factory;
      viewId = found.viewId;
      mismatch = found.mismatch;
      exists = found.exists;
      existsId = found.id;
    } else {
      factory = await factoryState();
    }
    let balance = null;
    if (walletAccount()) {
      const amount = await availableBalance(walletAccount());
      balance = amount == null ? null : amount.toString();
    }
    if (gen !== gateGen) return;
    state.factory = factory;
    state.computedGate = localId;
    state.viewGate = viewId;
    state.gateMismatch = mismatch;
    state.balance = balance;
    if (exists && existsId) {
      const live = await verifiedStamp();
      const stamp = rememberStamp(live);
      let owner = "";
      let domainRead = false;
      let domainKind = "";
      if (stamp?.storedMatches) {
        try {
          owner = (await signatureDomain(existsId)).owner;
          domainRead = true;
        } catch (error) {
          domainKind = error?.kind || "";
          domainRead = false;
        }
      } else {
        domainRead = true;
      }
      if (domainKind === "domain") {
        state.gateFromFactory = true;
        state.stampCheck = "bad-chain";
        state.checkNote = state.gateId ? "" : t("gate.badChain");
      } else {
        state.gateId = existsId;
        state.gateFromFactory = true;
        rememberGate({ id: existsId, label: existsId.split(".")[0] });
        const again = findGateAgain({
          localId,
          viewId,
          account: found.account,
          emptyCodeHash: TESTNET.emptyCodeHash,
          gateOwner: owner,
          derivedPublicKey: stamp?.publicKey || "",
          storedPublicKey: stamp?.storedPublicKey || "",
          domainRead,
        });
        state.stampCheck = again.stepDone ? "match" : again.reason;
        state.checkNote = again.stepDone ? t("gate.foundChain") : t(again.sentenceKey || "state.fail");
      }
    }
  } catch (error) {
    if (gen !== gateGen) return;
    state.factoryError = error;
    state.factory = null;
  }
  if (gen !== gateGen) return;
  gateFresh = true;
  renderMain();
}

async function usePasted() {
  const id = state.paste.trim();
  if (!validAccount(id)) { state.fieldError = t("gate.badId"); renderMain(); return; }
  state.fieldError = "";
  const check = await verifyGateForOwner(id, walletAccount() || "");
  if (!check.ok) {
    state.checkNote = t(check.reason);
    renderMain();
    return;
  }
  try {
    const account = await accountOf(id);
    if (!account) { state.checkNote = t("gate.notFound"); renderMain(); return; }
    const domain = await signatureDomain(id);
    const live = await verifiedStamp();
    const stamp = rememberStamp(live);
    const match = stampKeyMatch({
      gateOwner: domain.owner,
      derivedPublicKey: stamp?.publicKey || "",
      storedPublicKey: stamp?.storedPublicKey || "",
      domainRead: true,
    });
    state.gateId = id;
    rememberGate({ id, label: id.split(".")[0] });
    if (!match.unlocked) {
      applyStampResult(match);
      renderMain();
      return;
    }
    state.stampCheck = "match";
    state.checkNote = t("gate.found");
  } catch (error) {
    const kind = error?.kind;
    state.checkNote = kind === "domain" ? t("gate.badChain") : kind === "rate" ? t("state.rate") : t("state.fail");
  }
  renderMain();
}

function applyCreated(localId, txHash) {
  const view = createdGateView({
    gateId: localId,
    txHash: txHash || "",
    explorerTx: TESTNET.explorerTx,
  });
  state.txUrl = view.txUrl;
  state.computedGate = localId;
  state.gateId = localId;
  state.gateFromFactory = true;
  state.stampCheck = "match";
  state.phase = "confirmed";
  state.noticeKey = "";
  state.notice = "";
  rememberCreated(localId);
}

async function createWatchEffect(localId) {
  if (!localId) return null;
  const matched = await confirmCreatedGate(localId);
  if (matched === true) return true;
  if (matched === "bad-chain") {
    if (state.confirm) state.confirm.terminalKey = "gate.badChain";
    return false;
  }
  return null;
}

async function createGate() {
  if (state.busy || actionHeld("create")) return;
  const opSends = walletSendCount();
  state.busy = true;
  renderMain();
  let localId = "";
  try {
  state.lastAction = "create";
  if (!backupReady()) { state.noticeKey = "funds.backup"; return; }
  const first = createGatePlan(planInputs());
  const blocked = gateReasonText(first);
  if (blocked) { state.notice = blocked; return; }
  const live = await verifiedStamp();
  const stamp = rememberStamp(live);
  if (!stamp?.publicKey) { state.noticeKey = "gate.needKey"; return; }
  let factory;
  try { factory = await factoryState(); }
  catch { state.noticeKey = "state.fail"; return; }
  state.factory = factory;
  const amount = walletAccount() ? await availableBalance(walletAccount(), { fresh: true }).catch(() => null) : null;
  state.balance = amount == null ? null : amount.toString();
  const plan = createGatePlan(planInputs());
  if (!plan.unlock || !plan.depositToAttach || plan.depositToAttach !== String(factory.required)) {
    state.notice = gateReasonText(plan) || t("gate.needTotal");
    return;
  }
  const owner = walletAccount();
  localId = owner ? await gateAccountId(owner, TESTNET.factoryAccountId) : "";
  state.phase = "wallet";
  renderMain();
    const sent = await sendCall({
      receiverId: TESTNET.factoryAccountId,
      methodName: "create_gate",
      args: { owner_public_key: stamp.publicKey },
      gas: GAS_HEAVY,
      deposit: plan.depositToAttach,
    });
    lastSentAt = Date.now();
    state.phase = "chain";
    const parsed = await finishTx(sent, walletAccount(), TESTNET.factoryAccountId);
    const outcome = noteTx(parsed);
    const txHash = parsed?.txHash || sent?.txHash || "";
    if (outcome === "failed") return;
    if (outcome === "confirmed" && localId) {
      const matched = await confirmCreatedGate(localId);
      if (matched === true) {
        applyCreated(localId, txHash);
        return;
      }
      if (matched === "bad-chain") {
        state.stampCheck = "";
        state.phase = "idle";
        state.noticeKey = "gate.badChain";
        state.notice = "";
        return;
      }
    }
    await beginWatch({
      action: "create",
      txHash,
      signer: walletAccount() || "",
      sentAt: lastSentAt,
      readEffect: () => createWatchEffect(localId),
      onSuccess: async () => {
        const matched = await confirmCreatedGate(localId);
        if (matched === true) applyCreated(localId, txHash);
        else if (matched === "bad-chain") {
          state.noticeKey = "gate.badChain";
          state.notice = "";
          state.phase = "idle";
        }
      },
    });
  } catch (error) {
    state.phase = "idle";
    if (isCancelError(error)) {
      state.noticeKey = "flow.cancelled";
      state.notice = "";
    } else if (error?.walletOpened !== true && !error?.txHash && walletSendCount() === opSends) {
      state.noticeKey = "";
      state.notice = `${t("tx.notSent")} ${String(error?.message || error || "")}`.trim();
    } else {
      lastSentAt = Date.now();
      await beginWatch({
        action: "create",
        txHash: error?.txHash || "",
        signer: walletAccount() || "",
        sentAt: lastSentAt,
        readEffect: () => createWatchEffect(localId),
        onSuccess: async () => {
          const matched = await confirmCreatedGate(localId);
          if (matched === true) applyCreated(localId, error?.txHash || "");
        },
      });
    }
  } finally {
    state.busy = false;
    renderMain();
  }
}

async function spendLock(extraDeposit) {
  const id = walletAccount();
  if (!id) return t("gate.balanceNeed");
  let available;
  try { available = await availableBalance(id, { fresh: true }); }
  catch (error) { return error?.kind === "rate" ? t("state.rate") : t("state.fail"); }
  if (available == null) return t("gate.balanceWait");
  let extra = 0n;
  try { extra = BigInt(extraDeposit || "0"); } catch { extra = 0n; }
  if (extra < 0n) extra = 0n;
  state.balance = available.toString();
  if (available < MIN_SEND_YOCTO + extra) return t("gate.gasLock");
  return "";
}

function rememberCreated(id) {
  rememberGate({ id, label: id.split(".")[0] });
}

async function confirmCreatedGate(id) {
  clearCache();
  let account = null;
  try { account = await accountOf(id, { fresh: true }); } catch { return false; }
  if (!account || isEmptyCode(account.code_hash)) return false;
  let owner = "";
  try { owner = (await signatureDomain(id)).owner; }
  catch (error) { return error?.kind === "domain" ? "bad-chain" : false; }
  const live = await verifiedStamp();
  const stamp = rememberStamp(live);
  return !!(stamp?.publicKey && stamp.storedMatches && owner === stamp.publicKey);
}

function stampNotice() {
  return el("p", { class: "warn card", "data-stamp-notice": "1" }, t("stamp.storedUnencrypted"));
}

function holdStillRetryable() {
  if (state.noticeKey === "panic.resolved") return false;
  const id = state.lastDecide?.id;
  if (id == null) return false;
  return (state.pending || []).some((row) => String(row.id) === String(id));
}

function retryLast() {
  const action = state.lastAction;
  if (action === "deposit") return doDeposit();
  if (action === "withdraw") return doWithdraw();
  if (action === "storage") return doStorageTopUp();
  if (action === "rules") return saveRules();
  if (action === "create") return createGate();
  if (action === "mandate") return issueMandate();
  if (action === "agent") return createAgentAccount();
  if (action === "approve" || action === "reject" || action === "expire") {
    if (!holdStillRetryable()) {
      state.noticeKey = "panic.resolved";
      state.lastAction = "";
      renderMain();
      return null;
    }
    const fresh = (state.pending || []).find((row) => String(row.id) === String(state.lastDecide?.id));
    if (!fresh) {
      state.noticeKey = "panic.resolved";
      state.lastAction = "";
      renderMain();
      return null;
    }
    if (action === "expire") return expireHold(fresh);
    return decide(fresh, action === "approve");
  }
  return null;
}

function tryAgainButton() {
  if (state.holdRetry || state.confirm?.locked) return null;
  const key = state.noticeKey || "";
  const failed = key === "flow.failed" || key.startsWith("panic.") || key.startsWith("reason.");
  if (!failed || !state.lastAction) return null;
  if (ACTION_STEP[state.lastAction] !== state.step) return null;
  if ((state.lastAction === "approve" || state.lastAction === "reject" || state.lastAction === "expire") && !holdStillRetryable()) {
    return null;
  }
  const again = el("button", {
    type: "button",
    class: "tap",
    "data-act": "try-again",
    "data-last-action": state.lastAction,
    onClick: () => { if (!state.busy) retryLast(); },
  }, t("flow.try"));
  if (state.busy) again.disabled = true;
  return again;
}

function recipientValue() {
  if (state.recipientEdited) return state.recipient;
  return walletAccount() || "";
}

function withdrawResultNodes() {
  if (!state.withdrawResult) return [];
  return [
    el("p", { "data-withdraw-result": "1" }, t("funds.withdrew")),
    state.txUrl ? el("a", {
      class: "tap",
      href: state.txUrl,
      target: "_blank",
      rel: "noopener",
      "data-act": "withdraw-tx",
    }, t("flow.tx")) : null,
  ];
}

function storageSendRow() {
  const slack = state.storageSlack;
  if (!slack?.blocked) return null;
  const amount = slack.topUpNear;
  const button = el("button", {
    type: "button",
    class: "tap",
    "data-act": "storage-transfer",
  }, state.busy ? t("flow.working") : t("funds.storageSend", { amount }));
  disable(button, walletAccount() ? "" : t("funds.needWallet"));
  button.addEventListener("click", () => { doStorageTopUp(); });
  return el("div", { class: "row" }, button);
}

function fundsStep() {
  const stampWhy = ownerLockText();
  const backupWhy = backupReady() ? "" : t("funds.backup");
  const walletWhy = walletAccount() ? "" : t("funds.needWallet");
  const keyWhy = state.stamp ? "" : t("flow.needKey");
  const deposit = el("button", { type: "button", class: "tap primary", "data-act": "deposit" }, state.busy ? t("flow.working") : t("funds.deposit"));
  disable(deposit, stampWhy || backupWhy || walletWhy);
  deposit.addEventListener("click", () => doDeposit());
  const canWithdraw = state.storageSlack != null && state.storageSlack.blocked === false;
  const blocked = state.storageSlack?.blocked === true;
  let withdrawRow = null;
  if (canWithdraw) {
    const withdraw = el("button", { type: "button", class: "tap", "data-act": "withdraw" }, state.busy ? t("flow.working") : t("funds.withdraw"));
    disable(withdraw, stampWhy || keyWhy || backupWhy || walletWhy);
    withdraw.addEventListener("click", () => { doWithdraw(); });
    withdrawRow = el("div", { class: "row" }, withdraw);
  }
  const storageNote = blocked
    ? el("p", { class: "warn card", "data-storage-block": "1" }, t("funds.storageBlock", { amount: state.storageSlack.topUpNear }))
    : null;
  const storageSend = blocked ? storageSendRow() : null;
  const storageUnread = state.storageUnread
    ? el("div", { class: "row", "data-storage-unread": "1" },
      el("p", { class: "warn card" }, t("funds.storageUnread")),
      el("button", {
        type: "button",
        class: "tap",
        "data-act": "read-storage",
        disabled: state.busy || null,
        onClick: () => { if (!state.busy) loadFunds().catch(() => {}); },
      }, t("funds.readAgain")),
    )
    : null;
  return el("section", { class: "step-panel stack", id: "panel-funds" },
    el("h2", {}, t("step.funds")),
    state.escrow == null && !state.readError ? skeleton(5, t("state.loading")) : null,
    state.readError ? failureState(state.readError, () => loadFunds()) : null,
    el("p", { class: "amount num" }, `${t("funds.escrow")}: ${state.escrow == null ? "" : `${yoctoToNear(state.escrow)} ${t("common.near")}`}`),
    field(t("funds.amount"), input("fund-amount", state.amount, (value) => { state.amount = value; })),
    el("div", { class: "row" }, deposit),
    field(t("funds.recipient"), input("fund-recipient", recipientValue(), (value) => {
      state.recipientEdited = true;
      state.recipient = value;
    })),
    field(t("funds.withdrawAmount"), input("withdraw-amount", state.withdrawAmount, (value) => { state.withdrawAmount = value; })),
    withdrawRow,
    storageNote,
    storageSend,
    storageUnread,
    stampNotice(),
    ...stampMismatchNodes(),
    backupWhy ? reasonLine(backupWhy) : null,
    backupWhy ? el("a", { class: "tap", href: "#key", "data-act": "funds-backup" }, t("funds.backupLink")) : null,
    !stampWhy && !state.stamp ? reasonLine(t("flow.needKey")) : null,
    !stampWhy && !backupWhy && !keyWhy && walletWhy ? reasonLine(walletWhy) : null,
    ...withdrawResultNodes(),
    state.fieldError ? el("p", { class: "field-error", role: "alert" }, state.fieldError) : null,
    flowView(state.phase),
    noticeBox(),
    tryAgainButton(),
  );
}

async function loadFunds() {
  state.readError = null;
  state.storageUnread = false;
  state.escrow = null;
  state.storageSlack = null;
  renderMain();
  try {
    await ensureOwnerStamp();
    const data = await readRules(state.gateId);
    state.escrow = data.escrow;
    state.rules = data.rules;
    state.tier2 = data.tier2;
    try {
      const account = await accountOf(state.gateId, { fresh: true });
      if (!account || account.amount == null || account.storage_usage == null) {
        const error = new Error("account");
        error.kind = "rpc";
        throw error;
      }
      state.storageSlack = withdrawalSlack({
        amount: account.amount,
        storageUsage: account.storage_usage,
        escrow: data.escrow,
      });
    } catch {
      state.storageSlack = null;
      state.storageUnread = true;
    }
    if (walletAccount()) {
      const amount = await availableBalance(walletAccount());
      state.balance = amount == null ? null : amount.toString();
    }
  } catch (error) { state.readError = error; }
  renderMain();
}

async function requireRealGate() {
  const check = await verifyGateForOwner(state.gateId, walletAccount() || "");
  if (check.ok) return true;
  state.phase = "idle";
  if (check.reason === "state.rate" || check.reason === "state.fail") {
    state.noticeKey = check.reason;
    state.notice = "";
  } else {
    state.noticeKey = "";
    state.notice = t(check.reason);
  }
  return false;
}

/** Gate check plus the stamp match. A refused gate never reaches the wallet. */
async function signedDomain(stamp) {
  const check = await verifyGateForOwner(state.gateId, walletAccount() || "");
  if (!check.ok) return { refused: check.reason };
  let domain;
  try {
    domain = await signatureDomain(state.gateId);
  } catch (error) {
    if (error?.kind === "domain") return { refused: "gate.badChain" };
    throw error;
  }
  const match = stampKeyMatch({
    gateOwner: domain.owner,
    derivedPublicKey: stamp?.publicKey || "",
    storedPublicKey: stamp?.storedPublicKey || "",
    domainRead: true,
  });
  if (!match.unlocked) return { mismatch: true };
  return { domain };
}

async function doDeposit() {
  if (state.busy || actionHeld("deposit")) return;
  const opSends = walletSendCount();
  state.busy = true;
  renderMain();
  let gateId = "";
  let escrowBefore = null;
  let depositYocto = "";
  try {
    state.withdrawResult = false;
    state.lastAction = "deposit";
    await ensureOwnerStamp();
    const blocked = ownerLockText();
    if (blocked) { state.notice = blocked; return; }
    if (!backupReady()) { state.noticeKey = "funds.backup"; return; }
    const yocto = nearToYocto(state.amount);
    if (!yocto || yocto <= 0n) { state.fieldError = t("funds.positive"); return; }
    if (state.balance != null && yocto > BigInt(state.balance)) { state.fieldError = t("funds.overWallet"); return; }
    if (!(await requireRealGate())) return;
    gateId = state.gateId;
    escrowBefore = state.escrow;
    depositYocto = yocto.toString();
    const poor = await spendLock(depositYocto);
    if (poor) { state.notice = poor; return; }
    state.phase = "wallet";
    state.fieldError = "";
    renderMain();
    const sent = await sendCall({
      receiverId: gateId,
      methodName: "deposit",
      args: {},
      gas: GAS_LIGHT,
      deposit: depositYocto,
    });
    lastSentAt = Date.now();
    state.phase = "chain";
    const parsed = await finishTx(sent, walletAccount(), gateId);
    const outcome = noteTx(parsed);
    if (outcome === "unconfirmed") {
      await beginWatch({
        action: "deposit",
        txHash: parsed?.txHash || sent?.txHash || "",
        signer: walletAccount() || "",
        sentAt: lastSentAt,
        readEffect: () => depositWatchEffect(gateId, escrowBefore, depositYocto),
        onSuccess: async () => { clearCache(); await loadFunds(); },
      });
    }
    clearCache();
    await loadFunds();
  } catch (error) {
    state.phase = "idle";
    if (isCancelError(error)) {
      state.noticeKey = "flow.cancelled";
      state.notice = "";
    } else if (error?.walletOpened !== true && !error?.txHash && walletSendCount() === opSends) {
      state.noticeKey = "";
      state.notice = `${t("tx.notSent")} ${String(error?.message || error || "")}`.trim();
    } else {
      lastSentAt = Date.now();
      await beginWatch({
        action: "deposit",
        txHash: error?.txHash || "",
        signer: walletAccount() || "",
        sentAt: lastSentAt,
        readEffect: () => depositWatchEffect(gateId, escrowBefore, depositYocto),
        onSuccess: async () => { clearCache(); await loadFunds(); },
      });
    }
  } finally {
    state.busy = false;
    renderMain();
  }
}

function showWithdrawLock(notice, noticeKey, fieldError) {
  state.withdrawResult = false;
  state.notice = notice || "";
  state.noticeKey = noticeKey || "";
  state.fieldError = fieldError || "";
  renderMain();
}

async function doWithdraw() {
  if (state.busy || actionHeld("withdraw")) return;
  state.busy = true;
  renderMain();
  state.withdrawing = true;
  try {
    state.withdrawResult = false;
    await ensureOwnerStamp();
    const blocked = ownerLockText();
    if (blocked) {
      showWithdrawLock(blocked === t("gate.stampMismatch") ? "" : blocked, "", "");
      return;
    }
    if (!state.stamp) { showWithdrawLock("", "flow.needKey", ""); return; }
    if (!backupReady()) { showWithdrawLock("", "", ""); return; }
    if (!walletAccount()) { showWithdrawLock("", "", ""); return; }
    const yocto = nearToYocto(state.withdrawAmount);
    if (yocto == null || yocto <= 0n) { showWithdrawLock("", "", t("funds.positive")); return; }
    if (state.escrow == null) { showWithdrawLock("", "state.fail", ""); return; }
    let escrowYocto;
    try { escrowYocto = BigInt(state.escrow); } catch { showWithdrawLock("", "state.fail", ""); return; }
    if (yocto > escrowYocto) { showWithdrawLock("", "", t("funds.over")); return; }
    let account;
    try { account = await accountOf(state.gateId, { fresh: true }); }
    catch (error) { showWithdrawLock("", error?.kind === "rate" ? "state.rate" : "state.fail", ""); return; }
    if (!account || account.amount == null || account.storage_usage == null) {
      showWithdrawLock("", "state.fail", "");
      return;
    }
    let slack;
    try {
      slack = withdrawalSlack({
        amount: account.amount,
        storageUsage: account.storage_usage,
        escrow: escrowYocto,
      });
    } catch { showWithdrawLock("", "state.fail", ""); return; }
    state.storageSlack = slack;
    if (slack.blocked) { showWithdrawLock("", "", ""); return; }
    const recipient = recipientValue().trim();
    if (!validAccount(recipient)) { showWithdrawLock("", "", t("gate.badId")); return; }
    if (!(await requireRealGate())) return;
    state.withdrawResult = false;
    state.fieldError = "";
    state.notice = "";
    state.noticeKey = "";
    renderMain();
    let indexerMax;
    try {
      indexerMax = await loadWithdrawNonceMax(state.gateId);
    } catch (error) {
      showWithdrawLock("", error?.kind === "rate" ? "state.rate" : "state.fail", "");
      return;
    }
    let nonceText = nextWithdrawNonce(
      indexerMax,
      readLastWithdrawNonce(state.gateId),
      state.withdrawNonce,
      state.withdrawNonceUsed,
      bumpOnRetry({ panic: state.withdrawPanic || "" }),
    );
    if (BigInt(nonceText) <= indexerMax) nonceText = (indexerMax + 1n).toString();
    const amountText = yocto.toString();
    state.withdrawNonce = nonceText;
    state.withdrawNonceUsed = false;
    state.withdrawPanic = "";
    state.lastAction = "withdraw";
    const result = await runOwner({
      build: async (stamp) => {
        const ready = await signedDomain(stamp);
        if (ready.refused || ready.mismatch) return ready;
        const domain = ready.domain;
        const call = withdrawCallParts(state.gateId, amountText, recipient, nonceText);
        if (call.amountText !== amountText || call.nonceText !== nonceText || call.args.amount !== amountText || typeof call.args.amount !== "string") {
          throw new Error("withdraw text drifted");
        }
        const inner = withdrawPayload(state.gateId, call.amountText, recipient, call.nonceText);
        return {
          payload: authorizationBytes(domain.chainId, domain.deploymentId, stamp.publicKey, inner),
          receiverId: state.gateId,
          method: "withdraw_escrow",
          args: call.args,
          gas: GAS_CALL,
          deposit: "0",
        };
      },
    });
    const gateId = state.gateId;
    if (result?.outcome === "confirmed") {
      state.withdrawNonceUsed = true;
      state.withdrawPanic = "";
      state.notice = "";
      state.noticeKey = "";
      state.withdrawResult = true;
      state.txUrl = result.txHash ? explorerTxUrl(result.txHash) : "";
      writeLastWithdrawNonce(gateId, nonceText);
      clearCache();
      await loadFunds();
      return;
    }
    if (result?.outcome === "unconfirmed") {
      state.withdrawNonceUsed = false;
      state.withdrawPanic = "";
      await beginWatch({
        action: "withdraw",
        txHash: result.txHash || "",
        signer: walletAccount() || "",
        sentAt: lastSentAt,
        onSuccess: async () => {
          state.withdrawNonceUsed = true;
          state.withdrawPanic = "";
          state.withdrawResult = true;
          state.txUrl = result.txHash ? explorerTxUrl(result.txHash) : state.txUrl;
          writeLastWithdrawNonce(gateId, nonceText);
          clearCache();
          await loadFunds();
        },
        onFailure: async () => {
          state.withdrawNonceUsed = false;
          state.withdrawPanic = result?.panic || "";
        },
        onAbsent: async () => { state.withdrawNonceUsed = false; },
      });
      return;
    }
    state.withdrawNonceUsed = false;
    state.withdrawPanic = result?.panic || "";
  } finally {
    state.withdrawing = false;
    state.busy = false;
    renderMain();
  }
}

async function doStorageTopUp() {
  if (state.busy || actionHeld("storage")) return;
  const opSends = walletSendCount();
  state.busy = true;
  renderMain();
  let gateId = "";
  try {
    state.withdrawResult = false;
    state.lastAction = "storage";
    if (!walletAccount()) { state.noticeKey = "funds.needWallet"; return; }
    const plan = state.storageSlack;
    if (!plan?.blocked || !(plan.topUpYocto > 0n)) return;
    if (!(await requireRealGate())) return;
    gateId = state.gateId;
    let fresh = null;
    try {
      const data = await readRules(gateId);
      const account = await accountOf(gateId, { fresh: true });
      if (!account || account.amount == null || account.storage_usage == null) {
        const error = new Error("account");
        error.kind = "rpc";
        throw error;
      }
      fresh = withdrawalSlack({
        amount: account.amount,
        storageUsage: account.storage_usage,
        escrow: data.escrow,
      });
      state.escrow = data.escrow;
      state.storageSlack = fresh;
      state.storageUnread = false;
    } catch {
      state.storageSlack = null;
      state.storageUnread = true;
      return;
    }
    if (!fresh.blocked || !(fresh.topUpYocto > 0n)) return;
    const deposit = fresh.topUpYocto.toString();
    const poor = await spendLock(deposit);
    if (poor) { state.notice = poor; return; }
    state.phase = "wallet";
    state.fieldError = "";
    state.notice = "";
    state.noticeKey = "";
    renderMain();
    const sent = await sendActions({
      receiverId: gateId,
      actions: [
        { type: "Transfer", params: { deposit } },
      ],
    });
    lastSentAt = Date.now();
    state.phase = "chain";
    const parsed = await finishTx(sent, walletAccount(), gateId);
    const outcome = noteTx(parsed);
    if (outcome === "unconfirmed") {
      await beginWatch({
        action: "storage",
        txHash: parsed?.txHash || sent?.txHash || "",
        signer: walletAccount() || "",
        sentAt: lastSentAt,
        onSuccess: async () => { clearCache(); await loadFunds(); },
      });
    }
    clearCache();
    await loadFunds();
  } catch (error) {
    state.phase = "idle";
    if (isCancelError(error)) {
      state.noticeKey = "flow.cancelled";
      state.notice = "";
    } else if (error?.walletOpened !== true && !error?.txHash && walletSendCount() === opSends) {
      state.noticeKey = "";
      state.notice = `${t("tx.notSent")} ${String(error?.message || error || "")}`.trim();
    } else {
      lastSentAt = Date.now();
      await beginWatch({
        action: "storage",
        txHash: error?.txHash || "",
        signer: walletAccount() || "",
        sentAt: lastSentAt,
        onSuccess: async () => { clearCache(); await loadFunds(); },
      });
    }
  } finally {
    state.busy = false;
    renderMain();
  }
}

async function runOwner(job) {
  state.phase = "stamping";
  state.notice = "";
  state.noticeKey = "";
  let sentReceiver = state.gateId;
  renderMain();
  const result = await runSigningFlow({
    getStamp: async () => {
      const live = await verifiedStamp();
      const stamp = rememberStamp(live);
      if (!stamp) {
        if (state.gateId) state.stampCheck = "no-stamp";
        return null;
      }
      return stamp;
    },
    sign: async (payload) => {
      state.phase = "stamping";
      const { signBytes } = await import("./keys.mjs");
      const live = await verifiedStamp();
      if (!live?.seed) throw new Error("no stamp");
      try {
        return await signBytes(live.seed, payload);
      } finally {
        live.seed.fill(0);
      }
    },
    send: async (built, signature) => {
      const poor = await spendLock(built.deposit || "0");
      if (poor) {
        const error = new Error(poor);
        error.kind = "balance";
        throw error;
      }
      state.phase = "wallet";
      sentReceiver = built.receiverId || state.gateId;
      renderMain();
      try {
        const sent = await sendCall({
          receiverId: built.receiverId,
          methodName: built.method,
          args: { ...built.args, signature },
          gas: built.gas,
          deposit: built.deposit || "0",
        });
        lastSentAt = Date.now();
        return sent;
      } catch (error) {
        lastSentAt = Date.now();
        throw error;
      }
    },
    readResult: async (sent) => {
      state.phase = "chain";
      renderMain();
      return finishTx(sent, walletAccount(), sentReceiver);
    },
  }, job);
  state.phase = result.outcome === "confirmed" ? "confirmed" : "idle";
  if (result.outcome === "confirmed") {
    state.notice = result.txHash ? explorerTxUrl(result.txHash) : "";
    state.noticeKey = "";
    state.lastAction = "";
    state.lastDecide = null;
  } else if (result.outcome === "unconfirmed") {
    state.noticeKey = "tx.unconfirmed";
    state.notice = "";
    state.txUrl = result.txHash ? explorerTxUrl(result.txHash) : state.txUrl;
    state.pendingTxUrl = result.txHash ? explorerTxUrl(result.txHash) : "";
  } else if (result.outcome === "notsent") {
    state.noticeKey = "";
    state.notice = `${t("tx.notSent")} ${result.panic || ""}`.trim();
  } else if (result.kind === "balance") {
    state.notice = result.panic || t("gate.gasLock");
    state.noticeKey = "";
  } else if (result.outcome === "mismatch" || result.kind === "mismatch") {
    state.stampCheck = state.stampCheck === "match" ? "different-key" : (state.stampCheck || "different-key");
    state.noticeKey = "gate.stampMismatch";
    state.notice = "";
  } else if (result.kind === "gate") {
    state.noticeKey = "";
    state.notice = t(result.panic || "flow.failed");
  } else {
    state.noticeKey = failureKey(result);
    state.notice = result.panic || "";
    if (result.outcome === "need-key") state.noticeKey = "flow.needKey";
  }
  renderMain();
  return result;
}

function blankLimit(value) {
  const raw = u128(value);
  return raw === U128_MAX ? "" : yoctoToNear(raw);
}

function rulesStep() {
  if (state.rules == null && !state.readError) {
    return el("section", { class: "step-panel stack", id: "panel-rules" },
      el("h2", {}, t("step.rules")),
      skeleton(5, t("state.loading")),
    );
  }
  if (state.readError) {
    return el("section", { class: "step-panel stack", id: "panel-rules" },
      el("h2", {}, t("step.rules")),
      failureState(state.readError, () => loadFunds()),
    );
  }
  const draft = ensureDraft();
  const stampWhy = ownerLockText();
  const save = el("button", { type: "button", class: "tap primary", "data-act": "save-rules" }, state.busy ? t("flow.working") : t("rules.save"));
  disable(save, stampWhy || (state.stamp ? "" : t("flow.needKey")));
  save.addEventListener("click", () => saveRules(false));
  return el("section", { class: "step-panel stack", id: "panel-rules" },
    el("h2", {}, t("step.rules")),
    state.rules == null && !state.readError ? skeleton(5, t("state.loading")) : null,
    state.readError ? failureState(state.readError, () => loadFunds()) : null,
    checkControl("rules-enabled", "switch", draft.enabled, t("rules.apply"), () => { draft.enabled = !draft.enabled; renderMain(); }),
    field(t("rules.perTx"), input("rules-pertx", draft.perTx, (value) => { draft.perTx = value; }), t("rules.perTxHelp")),
    field(t("rules.perDay"), input("rules-perday", draft.perDay, (value) => { draft.perDay = value; }), t("rules.perDayHelp")),
    field(t("rules.count"), input("rules-count", draft.count, (value) => { draft.count = value; })),
    field(t("rules.tz"), input("rules-tz", draft.tz, (value) => { draft.tz = value; })),
    field(t("rules.winStart"), input("rules-start", draft.winStart, (value) => { draft.winStart = value; })),
    field(t("rules.winEnd"), input("rules-end", draft.winEnd, (value) => { draft.winEnd = value; })),
    field(t("rules.cats"), input("rules-cats", draft.cats, (value) => { draft.cats = value; }), t("rules.catsHelp")),
    field(t("rules.jevQ"), input("rules-jevq", draft.jevQ, (value) => { draft.jevQ = value; })),
    checkControl("rules-jevreq", "checkbox", draft.jevReq, t("rules.jevReq"), () => { draft.jevReq = !draft.jevReq; renderMain(); }),
    el("p", { class: "help" }, t("rules.jevReqHelp")),
    el("p", { class: "lbl" }, t("rules.jev")),
    el("p", { class: "help" }, t("rules.jevHelp")),
    field(t("rules.review"), input("rules-review", state.review, (value) => { state.review = value; }), t("rules.reviewHelp")),
    el("p", { class: "help", "data-help": "payees" }, t("rules.payeeHelp")),
    ...draft.payees.map((row, index) => el("div", { class: "stack" },
      field(t("rules.payeeAlias"), input(`rules-alias-${index}`, row.alias, (value) => { row.alias = value; })),
      field(t("rules.payeeAccount"), input(`rules-account-${index}`, row.account, (value) => { row.account = value; })),
    )),
    el("div", { class: "row" },
      el("button", { type: "button", class: "tap", "data-act": "add-payee", onClick: () => { draft.payees.push({ alias: "", account: "" }); renderMain(); } }, t("rules.addPayee")),
      el("button", { type: "button", class: "tap", "data-act": "remove-payee", onClick: () => { if (draft.payees.length) draft.payees.pop(); renderMain(); } }, t("rules.removePayee")),
      save,
    ),
    ...stampMismatchNodes(),
    !stampWhy && !state.stamp ? reasonLine(t("flow.needKey")) : null,
    state.fieldError ? el("p", { class: "field-error", role: "alert" }, state.fieldError) : null,
    flowView(state.phase),
    noticeBox(),
    tryAgainButton(),
  );
}

function ensureDraft() {
  if (state.ruleDraft) return state.ruleDraft;
  const rules = state.rules || {};
  state.ruleDraft = {
    enabled: !!rules.enabled,
    perTx: blankLimit(rules.per_tx_limit ?? U128_MAX),
    perDay: blankLimit(rules.per_day_limit ?? U128_MAX),
    count: rules.max_tx_per_day == null || Number(rules.max_tx_per_day) === U32_MAX ? "" : String(rules.max_tx_per_day),
    tz: String(rules.tz_offset_min ?? "0"),
    winStart: String(rules.window_start_min ?? "0"),
    winEnd: String(rules.window_end_min ?? "0"),
    cats: (rules.allowed_categories || []).join(", "),
    jevQ: String(rules.jev_threshold_permille ?? "900"),
    jevReq: !!rules.jev_required,
    payees: (rules.payees && rules.payees.length) ? rules.payees.map((row) => ({ alias: row.alias, account: row.account })) : [{ alias: "", account: "" }],
  };
  if (state.tier2 && state.review === "") state.review = blankLimit(state.tier2.amount_threshold);
  return state.ruleDraft;
}

function limitOrMax(text) {
  if (!String(text || "").trim()) return U128_MAX;
  const yocto = nearToYocto(text);
  return yocto == null ? null : yocto.toString();
}

async function saveRules() {
  if (state.busy || actionHeld("rules")) return;
  state.busy = true;
  renderMain();
  try {
  state.lastAction = "rules";
  await ensureOwnerStamp();
  const blocked = ownerLockText();
  if (blocked) { state.notice = blocked; return; }
  const draft = ensureDraft();
  const perTx = limitOrMax(draft.perTx);
  const perDay = limitOrMax(draft.perDay);
  const review = limitOrMax(state.review);
  if (!perTx || !perDay || !review) { state.fieldError = t("rules.bad"); return; }
  const count = String(draft.count || "").trim() ? Number(draft.count) : U32_MAX;
  const tz = Number(draft.tz || "0");
  const winStart = Number(draft.winStart || "0");
  const winEnd = Number(draft.winEnd || "0");
  const jevQ = Number(draft.jevQ || "900");
  if ([count, tz, winStart, winEnd, jevQ].some((n) => Number.isNaN(n))) { state.fieldError = t("rules.bad"); return; }
  const payees = draft.payees.filter((row) => row.alias || row.account);
  if (payees.some((row) => !row.alias || !validAccount(row.account))) { state.fieldError = t("rules.bad"); return; }
  if (draft.enabled && payees.length === 0) { state.fieldError = t("rules.needPayee"); return; }
  state.fieldError = "";
  const rulesNonce = (BigInt(state.rules?.rules_nonce || 0) + 1n).toString();
  const configNonce = (BigInt(state.tier2?.config_nonce || 0) + 1n).toString();
  const rules = {
    rules_nonce: String(rulesNonce),
    enabled: draft.enabled,
    per_tx_limit: perTx,
    per_day_limit: perDay,
    payees,
    tz_offset_min: tz,
    window_start_min: winStart,
    window_end_min: winEnd,
    max_tx_per_day: count,
    allowed_categories: draft.cats.split(",").map((item) => item.trim()).filter(Boolean),
    jev_threshold_permille: jevQ,
    jev_required: draft.jevReq,
  };
  const chainRules = { ...rules, rules_nonce: rawInt(rulesNonce) };
  const currentReview = state.tier2 ? u128(state.tier2.amount_threshold) : U128_MAX;
  const rulesChanged = !sameSpendRules(state.rules, rules);
  const reviewChanged = review !== currentReview;
  if (!rulesChanged && !reviewChanged) {
    state.lastAction = "";
    state.noticeKey = "rules.unchanged";
    return;
  }
  if (!(await requireRealGate())) return;
  const gateId = state.gateId;
  let spendSaved = false;
  const settleRules = async () => {
    state.lastAction = "";
    state.ruleDraft = null;
    clearCache();
    await loadFunds();
  };
  const sendTier2 = async (savedSpend) => {
    const nested = state.busy;
    if (!nested) {
      state.busy = true;
      state.holdRetry = true;
      renderMain();
    }
    try {
      if (!(reviewChanged && state.tier2)) {
        await settleRules();
        return;
      }
      const tier2 = state.tier2;
      const config = {
        config_nonce: String(configNonce),
        amount_threshold: review,
        pending_ttl_ns: String(tier2.pending_ttl_ns ?? "3600000000000"),
        new_payee_check: !!tier2.new_payee_check,
        trusted_sources: tier2.trusted_sources || [],
        known_payees: tier2.known_payees || [],
        denied_targets: tier2.denied_targets || [],
      };
      const chainConfig = { ...config, config_nonce: rawInt(configNonce), pending_ttl_ns: rawInt(config.pending_ttl_ns) };
      state.holdRetry = true;
      const reviewResult = await runOwner({
        build: async (stamp) => {
          const ready = await signedDomain(stamp);
          if (ready.refused || ready.mismatch) return ready;
          const domain = ready.domain;
          const inner = tier2Payload(gateId, config);
          return {
            payload: authorizationBytes(domain.chainId, domain.deploymentId, stamp.publicKey, inner),
            receiverId: gateId,
            method: "set_tier2_config",
            args: { config: chainConfig },
            gas: GAS_CALL,
            deposit: "0",
          };
        },
      });
      if (reviewResult?.outcome === "unconfirmed") {
        await recoverRulesNonce();
        await beginWatch({
          action: "rules",
          txHash: reviewResult.txHash || "",
          signer: walletAccount() || "",
          sentAt: lastSentAt,
          notice: savedSpend ? t(partialRulesKey("unconfirmed")) : "",
          readEffect: () => tier2WatchEffect(gateId, config),
          onSuccess: async () => { await settleRules(); },
          onFailure: async () => {
            if (!savedSpend) return;
            state.noticeKey = "";
            state.notice = t("rules.partial", { reason: t("flow.failed") });
            state.lastAction = "rules";
          },
        });
        return;
      }
      if (reviewResult?.outcome !== "confirmed") {
        const rawReason = reviewResult?.panic || failureKey(reviewResult || {});
        const reason = t(rawReason);
        await recoverRulesNonce();
        if (savedSpend) {
          state.noticeKey = "";
          state.notice = t("rules.partial", { reason });
          state.lastAction = "rules";
        }
        return;
      }
      await settleRules();
    } finally {
      if (!nested) {
        state.holdRetry = false;
        state.busy = false;
        renderMain();
      }
    }
  };
  if (rulesChanged) {
    state.holdRetry = true;
    const result = await runOwner({
      build: async (stamp) => {
        const ready = await signedDomain(stamp);
        if (ready.refused || ready.mismatch) return ready;
        const domain = ready.domain;
        const inner = rulesPayload(gateId, rules);
        return {
          payload: authorizationBytes(domain.chainId, domain.deploymentId, stamp.publicKey, inner),
          receiverId: gateId,
          method: "set_spend_rules",
          args: { rules: chainRules },
          gas: GAS_CALL,
          deposit: "0",
        };
      },
    });
    if (result.outcome === "unconfirmed") {
      await beginWatch({
        action: "rules",
        txHash: result.txHash || "",
        signer: walletAccount() || "",
        sentAt: lastSentAt,
        readEffect: () => spendWatchEffect(gateId, rules),
        onSuccess: async () => { await sendTier2(true); },
        onFailure: async () => { await recoverRulesNonce(); },
      });
      return;
    }
    if (result.outcome !== "confirmed") {
      await recoverRulesNonce();
      return;
    }
    spendSaved = true;
    state.holdRetry = false;
  }
  await sendTier2(spendSaved);
  } finally {
    state.holdRetry = false;
    state.busy = false;
    renderMain();
  }
}

function sameSpendRules(current, next) {
  if (!current) return false;
  const cats = (current.allowed_categories || []).map((item) => String(item).trim()).filter(Boolean).join(",");
  const nextCats = (next.allowed_categories || []).join(",");
  const payees = JSON.stringify((current.payees || []).map((row) => ({ alias: row.alias, account: row.account })));
  const nextPayees = JSON.stringify(next.payees || []);
  return !!current.enabled === !!next.enabled
    && u128(current.per_tx_limit) === String(next.per_tx_limit)
    && u128(current.per_day_limit) === String(next.per_day_limit)
    && Number(current.max_tx_per_day) === Number(next.max_tx_per_day)
    && Number(current.tz_offset_min || 0) === Number(next.tz_offset_min)
    && Number(current.window_start_min || 0) === Number(next.window_start_min)
    && Number(current.window_end_min || 0) === Number(next.window_end_min)
    && Number(current.jev_threshold_permille) === Number(next.jev_threshold_permille)
    && !!current.jev_required === !!next.jev_required
    && cats === nextCats
    && payees === nextPayees;
}

async function recoverRulesNonce() {
  try {
    clearCache();
    const data = await readRules(state.gateId);
    state.rules = data.rules;
    state.tier2 = data.tier2;
    if (data.escrow != null) state.escrow = data.escrow;
  } catch {
    state.lastAction = "";
    if (!state.confirm?.locked) state.noticeKey = "state.fail";
  }
  state.holdRetry = false;
  renderMain();
}

function mandateRecords() {
  return (loadDevice().mandates || []).filter((row) => row.gate === state.gateId);
}

function validAgentName(name) {
  return /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/.test(String(name || ""));
}

function agentBlockReason() {
  if (!state.gateId) return t("man.agentNeedGate");
  if (!walletAccount()) return t("man.agentNeedWallet");
  if (!validAgentName(state.agentName)) return t("man.agentBadName");
  return "";
}

function downloadAgentFile(record) {
  const blob = new Blob([JSON.stringify({
    type: "chopgate-agent-key",
    version: 1,
    account_id: record.account_id,
    public_key: record.public_key,
    secret_key: record.secret_key,
  }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "chopgate-agent-key.json";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function createAgentAccount() {
  if (state.busy || actionHeld("agent")) return;
  const opSends = walletSendCount();
  state.busy = true;
  renderMain();
  let key = null;
  let accountId = "";
  try {
    state.lastAction = "agent";
    const why = agentBlockReason();
    if (why) { state.notice = why; return; }
    if (!(await requireRealGate())) return;
    accountId = `${state.agentName}.${walletAccount()}`;
    const deposit = nearToYocto(AGENT_ACCOUNT_FUNDING_NEAR);
    if (!deposit) { state.noticeKey = "flow.failed"; return; }
    const poor = await spendLock(deposit.toString());
    if (poor) { state.notice = poor; return; }
    try { key = await createAgentKey(); }
    catch { state.noticeKey = "flow.failed"; return; }
    state.noticeKey = "";
    const sent = await sendActions({
      receiverId: accountId,
      actions: [
        { type: "CreateAccount" },
        { type: "Transfer", params: { deposit: deposit.toString() } },
        { type: "AddKey", params: {
          publicKey: key.public_key,
          accessKey: { nonce: 0, permission: { receiverId: state.gateId, methodNames: [...AGENT_METHOD_NAMES] } },
        } },
      ],
    });
    lastSentAt = Date.now();
    const parsed = await finishTx(sent, walletAccount(), accountId);
    const kept = { account_id: accountId, public_key: key.public_key, secret_key: key.secret_key };
    if (parsed?.ok === true) {
      showAgentSecret = false;
      state.agent = accountId;
      state.agentKey = kept;
      noteTx(parsed);
    } else if (parsed == null || parsed.ok == null) {
      noteTx(parsed);
      await beginWatch({
        action: "agent",
        txHash: parsed?.txHash || sent?.txHash || "",
        signer: walletAccount() || "",
        sentAt: lastSentAt,
        onSuccess: async () => {
          showAgentSecret = false;
          state.agent = accountId;
          state.agentKey = kept;
        },
        onFailure: async () => { kept.secret_key = ""; wipeAgentKey(); },
        onAbsent: async () => { kept.secret_key = ""; wipeAgentKey(); },
      });
    } else {
      key.secret_key = "";
      wipeAgentKey();
      noteTx(parsed);
    }
  } catch (error) {
    state.phase = "idle";
    if (isCancelError(error)) {
      if (key) key.secret_key = "";
      wipeAgentKey();
      state.noticeKey = "flow.cancelled";
      state.notice = "";
    } else if (error?.walletOpened !== true && !error?.txHash && walletSendCount() === opSends) {
      if (key) key.secret_key = "";
      wipeAgentKey();
      state.noticeKey = "";
      state.notice = `${t("tx.notSent")} ${String(error?.message || error || "")}`.trim();
    } else {
      lastSentAt = Date.now();
      const kept = key ? { account_id: accountId, public_key: key.public_key, secret_key: key.secret_key } : null;
      await beginWatch({
        action: "agent",
        txHash: error?.txHash || "",
        signer: walletAccount() || "",
        sentAt: lastSentAt,
        onSuccess: async () => {
          if (!kept?.secret_key) return;
          showAgentSecret = false;
          state.agent = kept.account_id;
          state.agentKey = kept;
        },
        onFailure: async () => { if (kept) kept.secret_key = ""; wipeAgentKey(); },
        onAbsent: async () => { if (kept) kept.secret_key = ""; wipeAgentKey(); },
      });
    }
  } finally {
    state.busy = false;
    renderMain();
  }
}

function agentKeyPanel() {
  const record = state.agentKey;
  if (!record?.secret_key) return null;
  const secret = showAgentSecret
    ? el("p", { "data-agent-secret": "shown" }, record.secret_key)
    : null;
  return el("div", { class: "card stack", id: "agent-key-panel" },
    el("p", { class: "warn" }, t("man.agentOnce")),
    el("p", {}, record.account_id),
    el("p", {}, record.public_key),
    secret,
    el("div", { class: "row" },
      el("button", {
        type: "button",
        class: "tap",
        "data-act": "show-agent-key",
        "aria-pressed": showAgentSecret ? "true" : "false",
        onClick: () => { showAgentSecret = !showAgentSecret; renderMain(); },
      }, showAgentSecret ? t("man.hideKey") : t("man.showKey")),
      el("button", {
        type: "button", class: "tap", "data-act": "copy-agent-key",
        onClick: async (event) => {
          const button = event.currentTarget;
          const hidden = state.agentKey?.secret_key;
          if (!hidden) return;
          try {
            await copyText(hidden);
            button.textContent = t("copied");
          } catch { /* clipboard permission is required */ }
        },
      }, t("man.copyKey")),
      el("button", {
        type: "button", class: "tap", "data-act": "save-agent-key",
        onClick: () => { if (state.agentKey?.secret_key) downloadAgentFile(state.agentKey); },
      }, t("man.saveKey")),
      el("button", {
        type: "button", class: "tap", "data-act": "close-agent-key",
        onClick: () => { wipeAgentKey(); renderMain(); },
      }, t("man.closeKey")),
    ),
  );
}

function mandateStep() {
  const stampWhy = ownerLockText();
  const issue = el("button", { type: "button", class: "tap primary", "data-act": "issue-mandate" }, state.busy ? t("flow.working") : t("man.issue"));
  disable(issue, stampWhy || (state.stamp ? "" : t("flow.needKey")));
  issue.addEventListener("click", () => issueMandate());
  const agentWhy = FEATURE_CREATE_AGENT_ACCOUNT ? (state.busy ? t("flow.working") : agentBlockReason()) : "";
  const createAgent = el("button", { type: "button", class: "tap", "data-act": "create-agent" }, t("man.createAgent"));
  disable(createAgent, agentWhy);
  createAgent.addEventListener("click", () => { if (!agentBlockReason() && !state.busy) createAgentAccount(); });
  return el("section", { class: "step-panel stack", id: "panel-mandates" },
    el("h2", {}, t("step.mandates")),
    el("p", { class: "warn card", "data-mandate-spare": "1" }, t("man.spare")),
    el("p", { class: "warn card" }, t("man.freeze")),
    el("p", { class: "help" }, t("man.limitFreeze")),
    el("p", { class: "help" }, t("man.limitStorage")),
    el("p", { class: "help" }, t("man.noView")),
    el("p", { class: "help" }, t("man.serialHelp")),
    el("p", { class: "help" }, t("man.rounded")),
    field(t("man.agent"), input("man-agent", state.agent, (value) => { state.agent = value; })),
    FEATURE_CREATE_AGENT_ACCOUNT ? field(t("man.agentName"), input("agent-name", state.agentName, (value) => { state.agentName = value; })) : null,
    FEATURE_CREATE_AGENT_ACCOUNT ? createAgent : null,
    FEATURE_CREATE_AGENT_ACCOUNT && agentWhy ? reasonLine(agentWhy) : null,
    agentKeyPanel(),
    field(t("man.budget"), input("man-budget", state.budget, (value) => { state.budget = value; })),
    field(t("man.expiry"), input("man-expiry", state.expiry, (value) => { state.expiry = value; }, "datetime-local")),
    ...state.jobs.map((job, index) => el("div", { class: "card stack" },
      field(t("man.target"), input(`man-target-${index}`, job.target, (value) => { job.target = value; })),
      field(t("man.max"), input(`man-max-${index}`, job.max, (value) => { job.max = value; }), t("man.maxHelp")),
      field(t("man.instruction"), area(`man-instruction-${index}`, job.instruction, (value) => { job.instruction = value; })),
      el("p", { class: "help" }, t("man.once")),
      el("p", { class: "help" }, t("man.once1")),
      el("p", { class: "help" }, t("man.once2")),
    )),
    el("div", { class: "row" },
      el("button", { type: "button", class: "tap", "data-act": "add-job", onClick: () => { state.jobs.push({ target: "", max: "", instruction: "" }); renderMain(); } }, t("man.add")),
      el("button", { type: "button", class: "tap", "data-act": "remove-job", onClick: () => { if (state.jobs.length > 1) state.jobs.pop(); renderMain(); } }, t("man.remove")),
      issue,
    ),
    ...stampMismatchNodes(),
    !stampWhy && !state.stamp ? reasonLine(t("flow.needKey")) : null,
    state.fieldError ? el("p", { class: "field-error", role: "alert" }, state.fieldError) : null,
    flowView(state.phase),
    noticeBox(),
    tryAgainButton(),
    mandateRecords().length ? null : el("p", { "data-state": "empty" }, t("man.empty")),
    ...mandateRecords().map((row) => mandateCard(row)),
  );
}

function mandateCard(row) {
  const expired = BigInt(row.expires_at || "0") <= nowNs();
  const kind = row.frozen ? "frozen" : expired ? "expired" : row.used ? "used" : "active";
  return el("article", { class: "card stack", "data-mandate": String(row.serial) },
    el("p", {}, `${t(`man.${kind}`)} · ${row.serial}`),
    el("p", { class: "break" }, row.agent),
    el("p", { class: "num" }, `${t("man.budget")}: ${yoctoToNear(row.budget)} ${t("common.near")}`),
    row.frozen ? el("p", {}, t("man.frozenHelp")) : null,
    row.frozen ? el("button", {
      type: "button",
      class: "tap",
      "data-act": "issue-new",
      onClick: () => {
        state.agent = row.agent;
        state.step = "mandates";
        location.hash = "mandates";
        renderMain();
      },
    }, t("man.issueNew")) : null,
    el("button", {
      type: "button",
      class: "tap",
      "data-act": "copy-mandate",
      onClick: async (event) => {
        const button = event.currentTarget;
        try {
          await copyText(JSON.stringify(agentJson(row), null, 2));
          button.textContent = t("copied");
          window.setTimeout(() => { button.textContent = t("man.copyJson"); }, 2000);
        } catch { /* clipboard permission is required */ }
      },
    }, t("man.copyJson")),
    ...(row.entries || []).map((entry) => el("div", { class: "stack" },
      el("p", {}, entry.instruction),
      el("button", {
        type: "button",
        class: "tap",
        "data-act": "copy-instruction",
        onClick: async (event) => {
          const button = event.currentTarget;
          try {
            await copyText(entry.instruction);
            button.textContent = t("copied");
            window.setTimeout(() => { button.textContent = t("man.copyJob"); }, 2000);
          } catch { /* clipboard permission is required */ }
        },
      }, t("man.copyJob")),
    )),
  );
}

function agentJson(row) {
  return {
    network: "testnet",
    gate: row.gate,
    agent: row.agent,
    serial: Number(row.serial),
    budget: String(row.budget),
    expires_at: String(row.expires_at),
    entries: (row.entries || []).map((entry) => ({
      action: "transfer",
      target: entry.target,
      max_amount: String(entry.max_amount),
      instruction: entry.instruction,
      instruction_hash: entry.instruction_hash,
    })),
  };
}

function nextSerial() {
  let max = 0;
  for (const row of mandateRecords()) max = Math.max(max, Number(row.serial) || 0);
  if (!max) return Date.now();
  return max + 1;
}

async function issueMandate() {
  if (state.busy || actionHeld("mandate")) return;
  state.busy = true;
  renderMain();
  try {
  state.lastAction = "mandate";
  await ensureOwnerStamp();
  const blocked = ownerLockText();
  if (blocked) { state.notice = blocked; return; }
  if (!validAccount(state.agent)) { state.fieldError = t("man.badAccount"); return; }
  const budget = nearToYocto(state.budget);
  if (!budget || budget <= 0n) { state.fieldError = t("rules.empty"); return; }
  if (!state.jobs.length) { state.fieldError = t("man.needJob"); return; }
  if (!state.expiry) { state.fieldError = t("man.past"); return; }
  const when = new Date(state.expiry).getTime();
  if (!when || when <= Date.now()) { state.fieldError = t("man.past"); return; }
  const expires = BigInt(Math.floor(when / 1000)) * 1000000000n;
  const entries = [];
  for (const job of state.jobs) {
    if (!validAccount(job.target) || !job.instruction.trim()) { state.fieldError = t("man.badAccount"); return; }
    const max = nearToYocto(job.max);
    if (!max || max <= 0n || max > budget) { state.fieldError = t("man.overBudget"); return; }
    entries.push({
      action: "transfer",
      target: job.target.trim(),
      max_amount: max.toString(),
      instruction: job.instruction,
      instruction_hash: await sha256hex(job.instruction),
    });
  }
  let liveRules = null;
  try { liveRules = (await readRules(state.gateId)).rules || null; } catch { state.fieldError = t("man.rulesUnread"); return; }
  if (liveRules?.enabled) {
    const listed = new Set((liveRules.payees || []).map((row) => String(row.account || "")));
    const off = entries.find((entry) => !listed.has(entry.target));
    if (off) { state.fieldError = t("man.payeeOff", { account: off.target }); return; }
  }
  if (!(await requireRealGate())) return;
  state.fieldError = "";
  const serial = nextSerial();
  const storedEntries = withJobIds(entries);
  const mandate = {
    serial: String(serial),
    agent: state.agent.trim(),
    entries: chainEntries(storedEntries),
    budget: budget.toString(),
    expires_at: expires.toString(),
    parent_serial: null,
  };
  const result = await runOwner({
    build: async (stamp) => {
      const ready = await signedDomain(stamp);
      if (ready.refused || ready.mismatch) return ready;
      const domain = ready.domain;
      const inner = mandatePayload(state.gateId, mandate);
      return {
        payload: authorizationBytes(domain.chainId, domain.deploymentId, stamp.publicKey, inner),
        receiverId: state.gateId,
        method: "register",
        args: {
          mandate: { ...mandate, serial: rawInt(serial), expires_at: rawInt(expires), entries: mandate.entries },
          signer_public_key: stamp.publicKey,
        },
        gas: GAS_CALL,
        deposit: "0",
      };
    },
  });
  const remembered = {
    gate: state.gateId,
    serial,
    agent: state.agent.trim(),
    budget: budget.toString(),
    expires_at: expires.toString(),
    entries: storedEntries,
    frozen: false,
    used: false,
  };
  if (result?.outcome === "confirmed") {
    rememberMandate(remembered);
  } else if (result?.outcome === "unconfirmed") {
    await beginWatch({
      action: "mandate",
      txHash: result.txHash || "",
      signer: walletAccount() || "",
      sentAt: lastSentAt,
      onSuccess: async () => { rememberMandate(remembered); },
    });
  } else if (result?.reasonCode === "auto_frozen" || result?.reasonCode === "owner_impersonation") {
    state.noticeKey = `reason.${result.reasonCode}`;
  }
  } finally {
    state.busy = false;
    renderMain();
  }
}

function approvalsStep() {
  const why = ownerLockText();
  return el("section", { class: "step-panel stack", id: "panel-approvals" },
    el("h2", {}, t("step.approvals")),
    ...stampMismatchNodes(),
    state.readError ? failureState(state.readError, () => loadHolds()) : pendingView(state.pending, {
      readOnly: false,
      gate: state.gateId,
      lockReason: why,
      busy: state.busy,
      heldAction: state.confirm?.locked ? state.confirm.action : "",
      onApprove: (item) => { if (!state.busy && !actionHeld("approve") && !ownerLockText()) decide(item, true); },
      onReject: (item) => { if (!state.busy && !actionHeld("reject") && !ownerLockText()) decide(item, false); },
      onExpire: (item) => { if (!state.busy && !actionHeld("expire")) expireHold(item); },
    }),
    flowView(state.phase),
    noticeBox(),
    tryAgainButton(),
  );
}

async function loadHolds() {
  state.pending = null;
  state.readError = null;
  renderMain();
  try {
    await ensureOwnerStamp();
    state.pending = await readPending(state.gateId);
  } catch (error) { state.readError = error; state.pending = null; }
  renderMain();
}

async function decide(item, approve) {
  if (state.busy || actionHeld(approve ? "approve" : "reject")) return;
  state.busy = true;
  renderMain();
  try {
  state.lastAction = approve ? "approve" : "reject";
  state.lastDecide = { id: item.id, approve };
  await ensureOwnerStamp();
  const blocked = ownerLockText();
  if (blocked) { state.notice = blocked; return; }
  if (!(await requireRealGate())) return;
  const fresh = state.pending?.find((row) => String(row.id) === String(item.id)) || item;
  const result = await runOwner({
    build: async (stamp) => {
      const ready = await signedDomain(stamp);
      if (ready.refused || ready.mismatch) return ready;
      const domain = ready.domain;
      const inner = await pendingPayload(state.gateId, fresh, approve);
      return {
        payload: authorizationBytes(domain.chainId, domain.deploymentId, stamp.publicKey, inner),
        receiverId: state.gateId,
        method: approve ? "approve_pending" : "reject_pending",
        args: { id: rawInt(fresh.id) },
        gas: GAS_CALL,
        deposit: "0",
      };
    },
  });
  if (result?.outcome === "unconfirmed") {
    await beginWatch({
      action: approve ? "approve" : "reject",
      txHash: result.txHash || "",
      signer: walletAccount() || "",
      sentAt: lastSentAt,
      onSuccess: async () => { clearCache(); await loadHolds(); },
    });
  }
  clearCache();
  await loadHolds();
  } finally {
    state.busy = false;
    renderMain();
  }
}

function holdExpired(item) {
  const deadline = item?.deadline ?? item?.deadline_ns;
  try { return BigInt(deadline || 0) <= BigInt(Date.now()) * 1000000n; }
  catch { return false; }
}

async function expireHold(item) {
  if (state.busy || actionHeld("expire")) return;
  const opSends = walletSendCount();
  if (!holdExpired(item)) return;
  state.busy = true;
  renderMain();
  let gateId = "";
  try {
    state.lastAction = "expire";
    state.lastDecide = { id: item.id };
    if (!(await requireRealGate())) return;
    gateId = state.gateId;
    state.phase = "wallet";
    renderMain();
    const sent = await sendCall({
      receiverId: gateId,
      methodName: "expire_pending",
      args: { id: rawInt(item.id) },
      gas: GAS_CALL,
      deposit: "0",
    });
    lastSentAt = Date.now();
    state.phase = "chain";
    const parsed = await finishTx(sent, walletAccount(), gateId);
    const outcome = noteTx(parsed);
    if (outcome === "unconfirmed") {
      await beginWatch({
        action: "expire",
        txHash: parsed?.txHash || sent?.txHash || "",
        signer: walletAccount() || "",
        sentAt: lastSentAt,
        onSuccess: async () => { clearCache(); await loadHolds(); },
      });
    }
    clearCache();
    await loadHolds();
  } catch (error) {
    state.phase = "idle";
    if (isCancelError(error)) {
      state.noticeKey = "flow.cancelled";
      state.notice = "";
    } else if (error?.walletOpened !== true && !error?.txHash && walletSendCount() === opSends) {
      state.noticeKey = "";
      state.notice = `${t("tx.notSent")} ${String(error?.message || error || "")}`.trim();
    } else {
      lastSentAt = Date.now();
      await beginWatch({
        action: "expire",
        txHash: error?.txHash || "",
        signer: walletAccount() || "",
        sentAt: lastSentAt,
        onSuccess: async () => { clearCache(); await loadHolds(); },
      });
    }
  } finally {
    state.busy = false;
    renderMain();
  }
}

function historyStep() {
  return el("section", { class: "step-panel stack", id: "panel-history" },
    el("h2", {}, t("step.history")),
    historyView(state.history, {
      error: state.readError,
      onRefresh: () => loadHist(true),
      onRetry: () => loadHist(true),
      onRetryRow: (row) => retryHistRow(row),
    }),
    noticeBox(),
  );
}

async function retryHistRow(row) {
  try {
    const next = await reloadHistoryRow(state.gateId, row);
    state.history = (state.history || []).map((item) => item.txHash === row.txHash ? next : item);
  } catch (error) {
    if (error?.kind === "rate") state.readError = error;
  }
  renderMain();
}

async function loadHist(force) {
  state.history = null;
  state.readError = null;
  if (force) clearCache();
  renderMain();
  try { state.history = await loadHistory(state.gateId, { limit: 8, fresh: !!force }); }
  catch (error) { state.readError = error; state.history = null; }
  renderMain();
}

function wipeAgentKey() {
  if (state.agentKey && typeof state.agentKey.secret_key === "string") state.agentKey.secret_key = "";
  state.agentKey = null;
  showAgentSecret = false;
}

let countdownTimer = 0;
function stopCountdown() {
  if (countdownTimer) {
    window.clearInterval(countdownTimer);
    countdownTimer = 0;
  }
}

function renderMain() {
  stopCountdown();
  if (state.step !== "mandates") wipeAgentKey();
  const main = document.getElementById("console-main");
  if (!main) return;
  const locked = lockReason(state.step);
  const names = { wallet: t("step.wallet"), key: t("step.key"), gate: t("step.gate"), funds: t("step.funds"), rules: t("step.rules"), mandates: t("step.mandates"), approvals: t("step.approvals"), history: t("step.history") };
  const index = STEPS.indexOf(state.step) + 1;
  const bar = el("button", {
    type: "button",
    class: "tap step-bar",
    "data-act": "step-sheet",
    "aria-expanded": "false",
    "aria-controls": "step-sheet",
  }, t("step.bar", { n: index, name: names[state.step] }));
  const sheet = el("div", { class: "sheet", id: "step-sheet", hidden: true },
    el("button", { type: "button", class: "tap", "data-act": "step-sheet-close" }, t("man.closeKey")),
    ...STEPS.map((id) => stepButton(id)),
  );
  bar.addEventListener("click", () => { sheet.hidden = false; bar.setAttribute("aria-expanded", "true"); });
  sheet.querySelector("[data-act=step-sheet-close]").addEventListener("click", () => {
    sheet.hidden = true;
    bar.setAttribute("aria-expanded", "false");
    bar.focus();
  });
  let body;
  if (locked) {
    const agentLocked = state.step === "mandates" && FEATURE_CREATE_AGENT_ACCOUNT
      ? disable(el("button", { type: "button", class: "tap", "data-act": "create-agent" }, t("man.createAgent")), locked)
      : null;
    body = el("section", { class: "step-panel stack", id: `panel-${state.step}` }, el("h2", {}, names[state.step]), reasonLine(locked), agentLocked);
  }
  else if (state.step === "wallet") body = walletStep();
  else if (state.step === "key") body = keyStep();
  else if (state.step === "gate") body = gateStep();
  else if (state.step === "funds") body = fundsStep();
  else if (state.step === "rules") body = rulesStep();
  else if (state.step === "mandates") body = mandateStep();
  else if (state.step === "approvals") body = approvalsStep();
  else body = historyStep();
  const lockNote = state.lockFor && lockReason(state.lockFor) ? reasonLine(lockReason(state.lockFor)) : null;
  main.replaceChildren(
    el("div", { class: "console-layout" },
      el("nav", { class: "steps steps-desk", "aria-label": t("step.list") }, ...STEPS.map((id) => stepButton(id))),
      el("div", { class: "stack" }, bar, lockNote, body),
    ),
    sheet,
  );
  if (state.step === "approvals" && state.pending) {
    countdownTimer = window.setInterval(() => {
      if (state.step !== "approvals") {
        stopCountdown();
        return;
      }
      document.querySelectorAll("[data-pending]").forEach((node) => {
        const item = (state.pending || []).find((row) => String(row.id) === node.dataset.pending);
        const slot = node.querySelector("[data-countdown]");
        if (!item || !slot) return;
        slot.textContent = countdown(item.deadline ?? item.deadline_ns);
      });
    }, 1000);
  }
}

let chromePaint = () => {};

function renderAll() {
  const app = document.getElementById("app");
  const chrome = mountChrome(1, "nav-console", {
    onLang: async () => { await toggleLang(); renderAll(); },
    onConnect: () => connectFromAnywhere(),
    onDisconnect: () => disconnectFromAnywhere(),
  });
  chromePaint = chrome.paintWallet;
  app.replaceChildren(sprite(), chrome.header, el("main", { class: "page", id: "console-root" }, el("div", { id: "console-main" })), chrome.footer, chrome.sheet);
  document.title = t("meta.console");
  renderMain();
  document.documentElement.dataset.ready = "1";
}

async function start() {
  await loadI18n();
  await bootData();
  // Draw the page frame and bind the listeners first; a slow or failing RPC must not leave a blank or dead screen.
  // The gate step loads through kick(false) below, and loadGateStep redraws when it finishes.
  renderAll();
  window.addEventListener("hashchange", () => {
    const hash = location.hash.replace("#", "");
    const next = STEPS.includes(hash) ? hash : state.step;
    if (next !== state.step) clearActionNotice();
    if (next !== "key") {
      pendingImportText = "";
      state.importSlotTaken = false;
      state.importReplaceArmed = false;
      state.importUnreadable = false;
    }
    state.step = next;
    state.lockFor = lockReason(state.step) ? state.step : "";
    state.fieldError = "";
    stopCountdown();
    renderMain();
    kick(true);
  });
  kick(false);
  let balanceTimer = 0;
  const scheduleBalance = () => {
    if (state.step !== "gate" || !walletAccount()) return;
    window.clearTimeout(balanceTimer);
    balanceTimer = window.setTimeout(() => { refreshBalance(true).catch(() => {}); }, 400);
  };
  window.addEventListener("focus", scheduleBalance);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") scheduleBalance();
  });
}

function kick(force) {
  if (lockReason(state.step)) return;
  if (state.step === "gate") ensureGate(!!force).catch(() => {});
  if (state.step === "funds" || state.step === "rules") loadFunds().catch(() => {});
  if (state.step === "mandates") ensureOwnerStamp().then(() => renderMain()).catch(() => {});
  if (state.step === "approvals") loadHolds().catch(() => {});
  if (state.step === "history") loadHist(false).catch(() => {});
}

start().catch(() => {
  const app = document.getElementById("app");
  if (app) app.textContent = "The page could not start.";
});

void ownerSignature;
void readRemaining;
void formatKst;
void currentLang;
void rulesView;
