import { el, icon } from "./dom.mjs";
import { t } from "./i18n.mjs";
import { walletAccount, connectWallet, disconnectWallet, restoreWallet } from "./wallet.mjs";
import { INTEAR_TESTNET_CREATE_URL } from "./network.mjs";

export function walletCreateHint() {
  if (!INTEAR_TESTNET_CREATE_URL) return null;
  return el("div", { class: "stack" },
    el("p", { class: "help" }, t("wallet.needLine")),
    el("a", {
      class: "tap",
      href: INTEAR_TESTNET_CREATE_URL,
      target: "_blank",
      rel: "noopener",
      "data-act": "wallet-create",
    }, t("wallet.needLink")),
  );
}

export function href(depth, path) {
  return `${depth ? "../".repeat(depth) : ""}${path}`;
}

function optionalText(key) {
  try {
    const value = t(key);
    if (!value || value === key) return null;
    return value;
  } catch {
    return null;
  }
}

let chromeKeys = null;

export function mountChrome(depth, active, hooks) {
  chromeKeys?.abort();
  chromeKeys = new AbortController();
  const signal = chromeKeys.signal;
  const home = depth > 0 ? "../".repeat(depth) : href(0, "index.html");
  const links = [
    ["console/", "nav.console", "nav-console", "console"],
    ["agent/", "nav.agent", "nav-agent", "agent"],
    ["tour/", "nav.tour", "nav-tour", "tour"],
    ["verify/", "nav.proof", "nav-proof", "verify"],
  ];
  const linkEl = (path, key, act) => el("a", {
    class: "tap",
    href: href(depth, path),
    "data-act": act,
    "aria-current": active === act ? "page" : null,
  }, t(key));

  const menuBtn = el("button", {
    type: "button",
    class: "tap pill menu-btn",
    "data-act": "menu",
    "aria-expanded": "false",
    "aria-controls": "nav-sheet",
    "aria-label": t("nav.menu"),
  }, icon("menu"), el("span", {}, t("nav.menu")));

  const sheet = el("div", { class: "sheet", id: "nav-sheet", hidden: true, role: "dialog", "aria-label": t("nav.menu") });
  const closeBtn = el("button", {
    type: "button",
    class: "tap",
    "data-act": "menu-close",
    "aria-label": t("nav.menu"),
  }, icon("close"), el("span", {}, t("nav.menu")));
  const sheetLinks = links.map(([path, key, act]) => linkEl(path, key, act));
  sheet.append(closeBtn, ...sheetLinks);

  let opener = null;
  function closeSheet() {
    sheet.hidden = true;
    menuBtn.setAttribute("aria-expanded", "false");
    if (opener) opener.focus();
  }
  function openSheet() {
    opener = menuBtn;
    sheet.hidden = false;
    menuBtn.setAttribute("aria-expanded", "true");
    closeBtn.focus();
  }
  menuBtn.addEventListener("click", openSheet);
  closeBtn.addEventListener("click", closeSheet);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !sheet.hidden) {
      event.preventDefault();
      closeSheet();
    }
  }, { signal });

  const langBtn = el("button", {
    type: "button",
    class: "tap pill",
    id: "lang-btn",
    "data-act": "lang",
    "aria-label": t("nav.langLabel"),
  }, t("nav.lang"));
  langBtn.addEventListener("click", () => hooks.onLang());

  const walletSlot = el("div", { class: "row", id: "wallet-slot" });
  async function onConnect(button) {
    button.disabled = true;
    button.replaceChildren(el("span", {}, t("nav.connecting")));
    try {
      await connectWallet();
    } catch (error) {
      hooks.onWalletError?.(error);
    }
    paintWallet();
    hooks.onWallet?.();
  }
  async function onDisconnect(button) {
    button.disabled = true;
    try { await disconnectWallet(); } catch { /* stay disconnected locally */ }
    paintWallet();
    hooks.onWallet?.();
  }
  function paintWallet() {
    const account = walletAccount();
    if (account) {
      const disconnect = el("button", {
        type: "button",
        class: "tap quiet",
        "data-act": "disconnect",
      }, t("nav.disconnect"));
      disconnect.addEventListener("click", () => {
        if (hooks.onDisconnect) hooks.onDisconnect();
        else onDisconnect(disconnect);
      });
      walletSlot.replaceChildren(el("span", { class: "chip", title: account }, account), disconnect);
      return;
    }
    const connect = el("button", { type: "button", class: "tap primary", "data-act": "wallet" }, icon("wallet"), el("span", {}, t("nav.connect")));
    connect.addEventListener("click", () => {
      if (hooks.onConnect) hooks.onConnect();
      else onConnect(connect);
    });
    walletSlot.replaceChildren(connect);
  }
  paintWallet();
  restoreWallet().then(() => {
    paintWallet();
    hooks.onWallet?.();
  }).catch(() => { /* leave the connect button */ });

  const tag = optionalText("brand.tag");
  const header = el("header", { class: "header" },
    el("a", { class: "tap brand", href: home, "data-act": "logo" },
      el("img", { src: href(depth, "assets/img/logo-mark.svg"), width: "32", height: "32", alt: "" }),
      el("span", { class: "brand-text" },
        el("span", { class: "word" }, t("brand")),
        tag ? el("span", { class: "brand-tag" }, tag) : null,
      ),
    ),
    el("nav", { class: "nav-desk", "aria-label": t("nav.console") }, ...links.map(([path, key, act]) => linkEl(path, key, act))),
    el("div", { class: "header-tools" },
      el("span", { class: "chip", "data-net": "testnet" }, t("nav.testnet")),
      langBtn,
      walletSlot,
      menuBtn,
    ),
  );

  const limitsHref = depth ? `${href(depth, "index.html")}#limits` : "#limits";
  const footer = el("footer", { class: "footer" },
    el("p", {}, t("foot.banner")),
    el("a", { class: "tap", href: href(depth, "network/"), "data-act": "foot-network" }, t("foot.network")),
    el("a", { class: "tap", href: limitsHref, "data-act": "foot-limits" }, t("foot.limits")),
  );

  return { header, footer, sheet, paintWallet };
}
