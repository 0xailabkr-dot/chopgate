/** Confirmed testnet account for this tab. A reload reads the NEAR Connect session, then wallet.getAccounts(). The stamp key is separate. */

import { WALLET_ALLOWLIST, TESTNET } from "./network.mjs";
import { rememberOwner } from "./store.mjs";
import { walletCallArgs } from "./format.mjs";
import { t } from "./i18n.mjs";

let connector = null;
let accountId = null;
let loading = null;
let refusedAccount = null;
let refusedWallet = "";
let sessionGate = Promise.resolve();

function withSession(fn) {
  const run = sessionGate.then(fn, fn);
  sessionGate = run.then(() => {}, () => {});
  return run;
}

function walletIdOf(wallet) {
  return String(wallet?.manifest?.id || wallet?.id || "");
}

export function walletAccount() { return accountId; }

/** Account id that connected but is not a testnet account. Cleared on the next connect. */
export function walletRefusedAccount() { return refusedAccount; }

/** Testnet named accounts end in .testnet. Implicit accounts (64 hex) and 0x accounts exist on testnet too. */
export function isTestnetAccount(id) {
  const value = String(id || "");
  return /\.testnet$/.test(value) || /^[0-9a-f]{64}$/.test(value) || /^0x[0-9a-f]{40}$/.test(value);
}

const NOTICE_ID = "wallet-notice";
let noticeTimer = 0;

function noticeNode() {
  let node = document.getElementById(NOTICE_ID);
  if (node) return node;
  node = document.createElement("div");
  node.id = NOTICE_ID;
  node.setAttribute("role", "status");
  node.setAttribute("aria-live", "polite");
  node.hidden = true;
  node.style.cssText = [
    "position:fixed", "left:50%", "bottom:16px", "transform:translateX(-50%)",
    "z-index:100000001", "box-sizing:border-box", "width:min(560px, calc(100vw - 24px))",
    "padding:12px 16px", "border-radius:12px", "border:1px solid #3a4470",
    "background:#121730", "color:#e8ecf8", "font:15px/1.5 system-ui, sans-serif",
    "box-shadow:0 8px 32px rgba(0,0,0,.45)", "word-break:keep-all", "overflow-wrap:anywhere",
  ].join(";");
  document.body.append(node);
  return node;
}

function hideNotice() {
  window.clearTimeout(noticeTimer);
  const node = document.getElementById(NOTICE_ID);
  if (node) { node.hidden = true; node.replaceChildren(); delete node.dataset.kind; }
}

function linkNode(href, text, act) {
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.dataset.act = act;
  a.textContent = text;
  a.style.cssText = "display:inline-flex;align-items:center;min-height:44px;margin-right:16px;color:#9cc2ff;text-decoration:underline";
  return a;
}

/** Shown from the connect click until the wallet window answers. The wallet window can stay blank for about 10 s. */
let frameWatch = null;

function watchWalletFrame() {
  if (frameWatch || typeof MutationObserver === "undefined") return;
  frameWatch = new MutationObserver((records) => {
    const node = document.getElementById(NOTICE_ID);
    if (!node || node.dataset.kind !== "loading") return;
    const added = records.some((r) => Array.from(r.addedNodes).some((n) => n.nodeName === "IFRAME" || (n.querySelector && n.querySelector("iframe"))));
    if (!added) return;
    window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => { if (node.dataset.kind === "loading") hideNotice(); }, 12000);
  });
  frameWatch.observe(document.body, { childList: true, subtree: true });
}

function onBlurWhileLoading() {
  const node = document.getElementById(NOTICE_ID);
  if (!node || node.dataset.kind !== "loading") return;
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => { if (node.dataset.kind === "loading") hideNotice(); }, 15000);
}

function showLoading() {
  watchWalletFrame();
  window.removeEventListener("blur", onBlurWhileLoading);
  window.addEventListener("blur", onBlurWhileLoading);
  const node = noticeNode();
  node.dataset.kind = "loading";
  node.style.pointerEvents = "none";
  const line = document.createElement("p");
  line.style.margin = "0";
  line.textContent = t("wallet.loading");
  node.replaceChildren(line);
  node.hidden = false;
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => { if (node.dataset.kind === "loading") hideNotice(); }, 15000);
}

function showRefused(id, walletId) {
  const meteor = walletId === "meteor-wallet";
  const node = noticeNode();
  node.dataset.kind = "mainnet";
  node.dataset.wallet = walletId || "";
  node.style.pointerEvents = "auto";
  const line = document.createElement("p");
  line.style.margin = "0 0 4px";
  line.textContent = t(meteor ? "wallet.mainnetMeteor" : "wallet.mainnet");
  const account = document.createElement("p");
  account.style.cssText = "margin:0 0 4px;color:#a3acc7";
  account.textContent = t("wallet.mainnetAccount", { account: id });
  const links = document.createElement("div");
  links.append(linkNode(TESTNET.walletCreate, t("wallet.mainnetCreate"), "mainnet-create"));
  const close = document.createElement("button");
  close.type = "button";
  close.dataset.act = "wallet-notice-close";
  close.textContent = t("wallet.noticeClose");
  close.style.cssText = "min-height:44px;min-width:44px;padding:0 12px;border-radius:10px;border:1px solid #3a4470;background:#1a2142;color:#e8ecf8;font:inherit;cursor:pointer";
  close.addEventListener("click", hideNotice);
  links.append(close);
  links.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;margin-top:4px";
  const parts = [line, account];
  if (!meteor) {
    const how = document.createElement("p");
    how.style.cssText = "margin:0;color:#a3acc7";
    how.textContent = t("wallet.mainnetHow");
    parts.push(how);
  }
  parts.push(links);
  node.replaceChildren(...parts);
  node.hidden = false;
  window.clearTimeout(noticeTimer);
}

async function refuseAccount(current, id, walletId, signedWallet) {
  refusedAccount = id;
  refusedWallet = walletId || refusedWallet || "";
  accountId = null;
  try { await current?.disconnect?.(signedWallet); } catch { /* the local session ends either way */ }
  showRefused(id, refusedWallet);
}

async function bundle() {
  return import("../vendor/near-connect-0.12.0.bundle.mjs");
}

function keepAllowlist(next) {
  const allow = new Set(WALLET_ALLOWLIST);
  next.wallets = (next.wallets || []).filter((row) => allow.has(row.manifest?.id));
  if (next.manifest?.wallets) {
    next.manifest.wallets = next.manifest.wallets.filter((row) => allow.has(row.id));
  }
}

/** Same filter as C2 try.js confirmedManifest(). Local copy of the NEAR Connect manifest, testnet wallets only. */
async function confirmedManifest() {
  const url = new URL("../vendor/near-connect-wallets-testnet.json", import.meta.url);
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error("wallet list HTTP " + res.status);
  const listed = await res.json();
  const allow = new Set(WALLET_ALLOWLIST);
  const wallets = (listed.wallets || []).filter((item) => item && allow.has(item.id) && item.features && item.features.testnet === true);
  if (!wallets.length) throw new Error("confirmed wallet missing");
  return { version: listed.version || "1.0.0", wallets };
}

async function ensure() {
  if (connector) return connector;
  if (!loading) {
    loading = (async () => {
      const { NearConnector } = await bundle();
      const manifest = await confirmedManifest();
      const next = new NearConnector({ network: "testnet", footerBranding: null, autoConnect: false, manifest: manifest });
      next.on("wallet:signIn", (payload) => {
        const signed = payload?.accounts?.[0]?.accountId || null;
        // Do not keep payload.accounts. accountId is set only after getAccounts() returns one.
        if (signed && !isTestnetAccount(signed)) {
          refuseAccount(next, signed, walletIdOf(payload?.wallet), payload?.wallet);
        }
      });
      next.on("wallet:signOut", () => {
        accountId = null;
        if (!refusedAccount) rememberOwner("");
      });
      await next.whenManifestLoaded;
      await new Promise((resolve) => setTimeout(resolve, 50));
      keepAllowlist(next);
      connector = next;
      return next;
    })();
  }
  return loading;
}

function accountIdFromList(accounts) {
  const first = accounts && accounts[0];
  if (!first) return "";
  if (typeof first === "string") return first;
  return first.accountId || "";
}

/** selected-wallet in NEAR Connect storage, then that wallet's getAccounts(). Empty until the wallet returns an account. */
async function readStoredSession(current) {
  if (!current || typeof current.getConnectedWallet !== "function") return null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const got = await current.getConnectedWallet();
      const id = accountIdFromList(got && got.accounts);
      if (!id || !got.wallet) return null;
      return { id, wallet: got.wallet };
    } catch (error) {
      const message = String((error && (error.message || error)) || "");
      // The first executor iframe often answers before the wallet has stored the account.
      if (attempt === 1 || !/no accounts found/i.test(message)) return null;
    }
  }
  return null;
}

async function accountsFromWallet(wallet) {
  if (!wallet || typeof wallet.getAccounts !== "function") return "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const id = accountIdFromList(await wallet.getAccounts());
      if (id) return id;
    } catch { /* a new executor iframe can answer before the session is stored */ }
  }
  return "";
}

async function acceptAccount(id) {
  accountId = id;
  rememberOwner(id);
  return id;
}

/** After a reload or a page change, show the account only when getAccounts() returned one. */
export function restoreWallet() {
  if (accountId && isTestnetAccount(accountId)) return Promise.resolve(accountId);
  return withSession(async () => {
    if (accountId && isTestnetAccount(accountId)) return accountId;
    const current = await ensure();
    const stored = await readStoredSession(current);
    if (!stored) return "";
    if (!isTestnetAccount(stored.id)) {
      await refuseAccount(current, stored.id, walletIdOf(stored.wallet), stored.wallet);
      return "";
    }
    return acceptAccount(stored.id);
  });
}

export function connectWallet() {
  return withSession(async () => {
    if (accountId && isTestnetAccount(accountId)) return accountId;
    refusedAccount = null;
    refusedWallet = "";
    hideNotice();
    showLoading();
    let wallet = null;
    let current = null;
    try {
      current = await ensure();
      await current.whenManifestLoaded;
      keepAllowlist(current);
      const stored = await readStoredSession(current);
      if (stored && isTestnetAccount(stored.id)) return acceptAccount(stored.id);
      if (stored && !isTestnetAccount(stored.id)) {
        await refuseAccount(current, stored.id, walletIdOf(stored.wallet), stored.wallet);
        const error = new Error("not a testnet account");
        error.kind = "mainnet";
        error.walletId = refusedWallet;
        throw error;
      }
      try {
        wallet = await current.connect();
      } catch (error) {
        const message = String((error && (error.message || error)) || "");
        if (/failed to sign in/i.test(message)) {
          const again = await readStoredSession(current);
          if (again && isTestnetAccount(again.id)) return acceptAccount(again.id);
          if (again && !isTestnetAccount(again.id)) {
            await refuseAccount(current, again.id, walletIdOf(again.wallet), again.wallet);
            const mainnet = new Error("not a testnet account");
            mainnet.kind = "mainnet";
            mainnet.walletId = refusedWallet;
            throw mainnet;
          }
        }
        throw error;
      }
    } finally {
      if (noticeNode().dataset.kind === "loading") hideNotice();
    }
    const found = await accountsFromWallet(wallet);
    if (found && !isTestnetAccount(found)) {
      await refuseAccount(current, found, walletIdOf(wallet), wallet);
      const error = new Error("not a testnet account");
      error.kind = "mainnet";
      error.walletId = refusedWallet;
      throw error;
    }
    if (!found) {
      const error = new Error("wallet selector closed");
      error.kind = "cancel";
      throw error;
    }
    return acceptAccount(found);
  });
}

export async function disconnectWallet() {
  if (connector?.disconnect) {
    try { await connector.disconnect(); } catch { /* local session still ends */ }
  }
  accountId = null;
  rememberOwner("");
}

async function connectedWallet() {
  if (!connector || !accountId || !isTestnetAccount(accountId)) {
    const error = new Error("wallet is not connected");
    error.kind = "cancel";
    throw error;
  }
  return connector.wallet();
}

/** Marks errors thrown after the wallet was asked to send, so callers can tell them from local errors. */
let sendCount = 0;

/** How many times the wallet has been asked to send. A catch that sees this number change since its operation began cannot claim "not sent". */
export function walletSendCount() {
  return sendCount;
}

async function openedSend(run) {
  sendCount += 1;
  try {
    return await run();
  } catch (error) {
    if (error && typeof error === "object") {
      try { error.walletOpened = true; } catch { /* frozen error object */ }
      if (error.walletOpened === true) throw error;
    }
    const wrapped = new Error(String(error?.message || error || "wallet error"));
    wrapped.walletOpened = true;
    if (error?.kind) wrapped.kind = error.kind;
    if (error?.txHash) wrapped.txHash = error.txHash;
    if (error?.code) wrapped.code = error.code;
    throw wrapped;
  }
}

export async function sendCall({ receiverId, methodName, args, gas, deposit }) {
  const wallet = await connectedWallet();
  const result = await openedSend(() => wallet.signAndSendTransaction({
    receiverId,
    actions: [{
      type: "FunctionCall",
      params: {
        methodName,
        args: walletCallArgs(args ?? {}),
        gas,
        deposit: deposit || "0",
      },
    }],
  }));
  const txHash = result?.transaction?.hash || result?.transactionHash || null;
  return { txHash, raw: result };
}

export async function sendActions({ receiverId, actions }) {
  const wallet = await connectedWallet();
  const encoded = (actions || []).map((action) => {
    if (action?.type === "FunctionCall" && action.params && "args" in action.params) {
      return { ...action, params: { ...action.params, args: walletCallArgs(action.params.args) } };
    }
    return action;
  });
  const result = await openedSend(() => wallet.signAndSendTransaction({ receiverId, actions: encoded }));
  const txHash = result?.transaction?.hash || result?.transactionHash || null;
  return { txHash, raw: result };
}
