import { loadI18n, t, toggleLang } from "./i18n.mjs";
import { sprite } from "./icons.mjs";
import { el } from "./dom.mjs";
import { mountChrome } from "./shell.mjs";

async function start() {
  await loadI18n();
  document.title = t("meta.try");
  const app = document.getElementById("app");
  const paint = () => {
    const chrome = mountChrome(1, "", { onLang: async () => { await toggleLang(); paint(); } });
    const main = el("main", { class: "page stack" },
      el("h1", {}, t("try.title")),
      el("p", {}, t("try.body")),
      el("a", { class: "tap primary", href: "../verify/", "data-act": "try-proof" }, t("try.proof")),
      el("a", { class: "tap", href: "../verify/#try", "data-act": "try-anchor" }, t("try.anchor")),
    );
    app.replaceChildren(sprite(), chrome.header, main, chrome.footer, chrome.sheet);
    document.documentElement.dataset.ready = "1";
  };
  paint();
}

start().catch(() => {
  const app = document.getElementById("app");
  if (app) app.textContent = "The page could not start.";
});
