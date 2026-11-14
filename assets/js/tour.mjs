import { loadI18n, t, toggleLang } from "./i18n.mjs";
import { sprite } from "./icons.mjs";
import { el } from "./dom.mjs";
import { mountChrome } from "./shell.mjs";
import { TESTNET, explorerAddressUrl } from "./network.mjs";
import { loadHistory, readPending, readTourFacts } from "./chain.mjs";
import { historyView, pendingView, rulesView, tourSummary } from "./panels.mjs";
import { failureState } from "./dom.mjs";

const state = { tab: "rules", facts: null, pending: null, history: null, error: null };

function tabs() {
  const items = [["rules", "tour.rules"], ["held", "tour.held"], ["decisions", "tour.decisions"]];
  return el("div", { class: "tabs", role: "tablist" }, ...items.map(([id, key], index) => {
    const button = el("button", {
      type: "button",
      class: "tap",
      role: "tab",
      id: `tab-${id}`,
      "data-act": `tour-${id}`,
      "aria-selected": state.tab === id ? "true" : "false",
      "aria-controls": "tour-panel",
      tabindex: state.tab === id ? "0" : "-1",
    }, t(key));
    button.addEventListener("click", () => select(id));
    button.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      event.preventDefault();
      const next = (index + (event.key === "ArrowRight" ? 1 : items.length - 1)) % items.length;
      select(items[next][0]);
      document.getElementById(`tab-${items[next][0]}`)?.focus();
    });
    return button;
  }));
}

function reloadTab() {
  if (state.tab === "rules") loadRules();
  else if (state.tab === "held") loadHeld();
  else loadDecisions(true);
}

function select(id) {
  state.tab = id;
  render();
  if (id === "held" && !state.pending && !state.error) loadHeld();
  if (id === "decisions" && !state.history && !state.error) loadDecisions();
}

function panel() {
  if (state.tab === "rules") {
    if (state.error && !state.facts) return failureState(state.error, () => loadRules());
    if (!state.facts) return el("div", { class: "skeleton", "data-state": "loading" });
    const rulesBlock = state.facts.rulesError
      ? failureState(state.facts.rulesError, () => loadRules())
      // Run D has no judge model. The stored permille is not a score.
      : (state.facts.rules ? rulesView(state.facts.rules, state.facts.tier2, { judgeOn: false }) : null);
    return el("div", { class: "stack" }, tourSummary(state.facts), rulesBlock);
  }
  if (state.tab === "held") {
    if (state.error) return failureState(state.error, () => loadHeld(), state.error.kind === "indexer" ? "hist.unread" : undefined);
    return pendingView(state.pending, { readOnly: true });
  }
  if (state.error) return failureState(state.error, () => loadDecisions(true), state.error?.kind === "indexer" ? "hist.unread" : undefined);
  return historyView(state.history, { error: null, onRefresh: () => loadDecisions(true) });
}

function render() {
  const root = document.getElementById("tour-root");
  if (!root) return;
  root.replaceChildren(
    el("p", { class: "kicker" }, t("tour.kicker")),
    el("h1", {}, t("meta.tour")),
    el("p", { class: "chip" }, t("tour.badge")),
    el("p", { "data-tour-label": "1" }, t("tour.runD")),
    el("p", { class: "break" }, TESTNET.tourGate),
    el("a", { class: "tap", href: explorerAddressUrl(TESTNET.tourGate), target: "_blank", rel: "noopener", "data-act": "explorer" }, t("state.explorer")),
    el("button", { type: "button", class: "tap", "data-act": "refresh", onClick: () => reloadTab() }, t("hist.refresh")),
    tabs(),
    el("div", { id: "tour-panel", role: "tabpanel", "aria-labelledby": `tab-${state.tab}` }, panel()),
    el("a", { class: "tap primary", href: "../console/", "data-act": "tour-create" }, t("tour.create")),
  );
}

async function loadRules() {
  state.error = null;
  state.facts = null;
  render();
  try {
    state.facts = await readTourFacts(TESTNET.tourGate);
  } catch (error) {
    state.error = error;
    state.facts = null;
  }
  render();
  document.documentElement.dataset.ready = "1";
}

async function loadHeld() {
  state.error = null;
  state.pending = null;
  render();
  try { state.pending = await readPending(TESTNET.tourGate); }
  catch (error) { state.error = error; state.pending = null; }
  render();
}

async function loadDecisions(fresh = false) {
  state.error = null;
  state.history = null;
  render();
  try { state.history = await loadHistory(TESTNET.tourGate, { limit: 8, fresh }); }
  catch (error) { state.error = error; }
  render();
}

async function start() {
  await loadI18n();
  document.title = t("meta.tour");
  const app = document.getElementById("app");
  const paint = () => {
    const chrome = mountChrome(1, "nav-tour", { onLang: async () => { await toggleLang(); paint(); } });
    app.replaceChildren(sprite(), chrome.header, el("main", { class: "page stack", id: "tour-root" }), chrome.footer, chrome.sheet);
    render();
  };
  paint();
  await loadRules();
}

start().catch(() => {
  const app = document.getElementById("app");
  if (app) app.textContent = "The page could not start.";
});
