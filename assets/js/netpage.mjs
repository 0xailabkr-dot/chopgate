import { loadI18n, t, toggleLang } from "./i18n.mjs";
import { sprite } from "./icons.mjs";
import { el } from "./dom.mjs";
import { mountChrome } from "./shell.mjs";
import { factoryState } from "./chain.mjs";
import { gateAmount } from "./gateplan.mjs";

function amountLine(parts) {
  if (!parts?.readable) return t("gate.amountFallback", { x: parts?.x || gateAmount(null).x });
  return t("gate.amountLive", { x: parts.x, y: parts.y });
}

function render(status) {
  const root = document.getElementById("net-root");
  if (!root) return;
  const kids = [
    el("p", { class: "kicker" }, t("net.kicker")),
    el("h1", {}, t("net.title")),
    el("p", {}, el("span", { class: "lbl" }, t("net.costLabel")), " ", amountLine(status.parts)),
    el("p", {}, t("net.lead")),
  ];
  if (status.deployed === false) kids.push(el("p", {}, t("net.note")));
  kids.push(el("section", { class: "limits", id: "limits" }, el("p", {}, t("home.limitsBody"))));
  root.replaceChildren(...kids);
}

async function readStatus() {
  try {
    const factory = await factoryState();
    const deposit = factory.deployed && factory.required ? factory.required : null;
    return { parts: gateAmount(deposit), deployed: factory.deployed === true };
  } catch {
    return { parts: gateAmount(null), deployed: null };
  }
}

async function start() {
  await loadI18n();
  let status = { parts: gateAmount(null), deployed: null };
  let settled = false;
  const read = readStatus().then((next) => { status = next; settled = true; });
  await Promise.race([read, new Promise((resolve) => setTimeout(resolve, 8000))]);
  document.title = t("meta.network");
  const app = document.getElementById("app");
  const paint = () => {
    const chrome = mountChrome(1, "", { onLang: async () => { await toggleLang(); paint(); } });
    app.replaceChildren(sprite(), chrome.header, el("main", { class: "page stack", id: "net-root" }), chrome.footer, chrome.sheet);
    render(status);
    document.documentElement.dataset.ready = "1";
  };
  paint();
  if (!settled) read.then(() => { if (document.getElementById("net-root")) paint(); });
}

start().catch(() => {
  const app = document.getElementById("app");
  if (app) app.textContent = "The page could not start.";
});
