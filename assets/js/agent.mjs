import { loadI18n, t, toggleLang } from "./i18n.mjs";
import { sprite } from "./icons.mjs";
import { el, copyText } from "./dom.mjs";
import { mountChrome } from "./shell.mjs";
import { FEATURE_CREATE_AGENT_ACCOUNT } from "./network.mjs";

const MCP = `{
  "mcpServers": {
    "chopgate": {
      "command": "node",
      "args": ["/path/to/chopgate/agent/src/mcp-server.mjs"],
      "env": {
        "CHOPGATE_AGENT_KEY": "/path/to/my-agent/chopgate-agent-key.json",
        "CHOPGATE_MANDATES": "/path/to/my-agent/mandates",
        "CHOPGATE_LEDGER": "/path/to/my-agent/ledger.jsonl"
      }
    }
  }
}`;

const JS = `import { status, pay } from "/path/to/chopgate/agent/src/chopgate-agent.mjs";

const report = await status({ gate: "gate.example.testnet" });
const entry = report.entries.find((row) => row.state === "unused");
const result = await pay({
  entry_id: entry.entry_id,
  amount: "0.1",
  source: "owner_chat"
});
`;

const REPO_URL = "https://github.com/0xailabkr-dot/chopgate";
const CLONE_CMD = "git clone https://github.com/0xailabkr-dot/chopgate.git";
const README_URL = "https://github.com/0xailabkr-dot/chopgate/blob/main/agent/README.md";

let tab = "mcp";

function extLink(href, act) {
  return el("a", {
    class: "tap",
    href,
    target: "_blank",
    rel: "noopener noreferrer",
    "data-act": act,
  }, href);
}

function copyButton(act, label, text) {
  const button = el("button", { type: "button", class: "tap", "data-act": act }, label);
  button.addEventListener("click", async () => {
    try {
      await copyText(text);
      button.textContent = t("copied");
      window.setTimeout(() => { button.textContent = label; }, 2000);
    } catch { /* clipboard permission is required */ }
  });
  return button;
}

function tabs() {
  const items = [["mcp", "agent.tabMcp", "tab-mcp"], ["js", "agent.tabJs", "tab-js"]];
  return el("div", { class: "tabs", role: "tablist", "aria-label": t("agent.s2") }, ...items.map(([id, key, act], index) => {
    const button = el("button", {
      type: "button",
      class: "tap",
      role: "tab",
      "data-act": act,
      "aria-selected": tab === id ? "true" : "false",
      tabindex: tab === id ? "0" : "-1",
    }, t(key));
    button.addEventListener("click", () => { tab = id; render(); });
    button.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      event.preventDefault();
      const next = (index + (event.key === "ArrowRight" ? 1 : items.length - 1)) % items.length;
      tab = items[next][0];
      render();
      document.querySelector(`[data-act="${items[next][2]}"]`)?.focus();
    });
    return button;
  }));
}

function render() {
  const root = document.getElementById("agent-root");
  if (!root) return;
  root.replaceChildren(
    el("h1", {}, t("meta.agent")),
    el("section", { class: "card stack" }, el("h2", {}, t("agent.s0")), el("p", {}, t("agent.s0body")), el("a", { class: "tap", href: "../console/", "data-act": "agent-console" }, t("agent.s0open"))),
    el("section", { class: "card stack" }, el("h2", {}, t("agent.s1")), el("p", {}, t("agent.s1body"))),
    el("section", { class: "card stack" },
      el("h2", {}, t("agent.s2")),
      el("p", {}, t("agent.s2body")),
      el("p", { class: "help" }, t("agent.pathNote")),
      tabs(),
      tab === "mcp"
        ? el("div", {}, el("pre", {}, MCP), copyButton("copy-mcp", t("agent.copyMcp"), MCP))
        : el("div", {}, el("pre", {}, JS), copyButton("copy-js", t("agent.copyJs"), JS)),
    ),
    el("section", { class: "card stack" }, el("h2", {}, t("agent.s3")), el("p", {}, t("agent.s3body"))),
    el("section", { class: "warn card" }, el("p", {}, t("agent.warn"))),
  );
  if (!FEATURE_CREATE_AGENT_ACCOUNT) {
    root.append(el("section", { class: "card stack" },
      el("h2", {}, t("agent.cliTitle")),
      el("p", {}, t("agent.cliDo")),
      el("p", {}, t("agent.cliSee")),
    ));
  }
  root.append(el("section", { class: "card stack", id: "run-yourself" },
    el("h2", {}, t("agent.runTitle")),
    el("p", {}, t("agent.runBody")),
    el("p", {}, extLink(REPO_URL, "agent-repo")),
    el("pre", {}, CLONE_CMD),
    copyButton("copy-clone", t("agent.copyClone"), CLONE_CMD),
    el("p", {}, extLink(README_URL, "agent-readme")),
  ));
}

async function start() {
  await loadI18n();
  document.title = t("meta.agent");
  const app = document.getElementById("app");
  const paint = () => {
    const chrome = mountChrome(1, "nav-agent", { onLang: async () => { await toggleLang(); paint(); } });
    app.replaceChildren(sprite(), chrome.header, el("main", { class: "page stack", id: "agent-root" }), chrome.footer, chrome.sheet);
    render();
    document.documentElement.dataset.ready = "1";
  };
  paint();
}

start().catch(() => {
  const app = document.getElementById("app");
  if (app) app.textContent = "The page could not start.";
});
