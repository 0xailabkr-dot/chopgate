import { t } from "./i18n.mjs";

export function el(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
      else node.setAttribute(key, value === true ? "" : String(value));
    }
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

export function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

export function field(label, control, help, error) {
  const labelNode = control?.id
    ? el("label", { class: "lbl", for: control.id, id: `${control.id}-lbl` }, label)
    : el("span", { class: "lbl" }, label);
  return el("div", { class: "field" },
    labelNode,
    control,
    help ? el("p", { class: "help" }, help) : null,
    error ? el("p", { class: "field-error", role: "alert" }, error) : null,
  );
}

export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch { /* some browsers reject the async clipboard without a focused document */ }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.focus();
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  if (!ok) throw new Error("copy failed");
}

export function copyControl(act, label, getText) {
  const button = el("button", { type: "button", class: "tap", "data-act": act }, label);
  button.addEventListener("click", async () => {
    try {
      await copyText(await getText());
      button.textContent = t("copied");
      setTimeout(() => { button.textContent = label; }, 2000);
    } catch { /* clipboard permission is required for the QA run */ }
  });
  return button;
}

export function reasonLine(text) {
  return text ? el("p", { class: "reason", "data-reason": "1" }, text) : null;
}

export function skeleton(count, label) {
  return el("div", { class: "skeleton", "data-state": "loading", "aria-busy": "true", role: "status" },
    el("span", { class: "sr" }, label),
    ...Array.from({ length: count }, () => el("div", { class: "sk-row" })),
  );
}

export function failureState(error, onRetry, messageKey) {
  const rate = error?.kind === "rate";
  const key = rate ? "state.rate" : (messageKey || "state.fail");
  return el("div", { class: "state fail", "data-state": rate ? "rate" : "error", role: "alert" },
    el("p", {}, t(key)),
    el("button", { type: "button", class: "tap", "data-act": "retry", onClick: onRetry }, t("state.retry")),
  );
}

export function emptyState(text) {
  return el("p", { class: "state empty", "data-state": "empty" }, text);
}
