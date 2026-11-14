import { el, icon, emptyState, failureState, skeleton, reasonLine } from "./dom.mjs";
import { panicKey } from "./flow.mjs";
import { t } from "./i18n.mjs";
import { countdown, formatKst, shortHash, yoctoToNear } from "./format.mjs";
import { U128_MAX, U32_MAX, u128 } from "./chain.mjs";
import { currentLang } from "./i18n.mjs";
import { approvalFacts } from "./original.mjs";
import { loadDevice } from "./store.mjs";

const VERDICT_ICON = { paid: "check", held: "clock", refused: "ban", recorded: "dot", frozen: "lock", registered: "stamp" };
const VERDICT_CLASS = { paid: "ok", held: "hold", refused: "danger", recorded: "muted", frozen: "frozen", registered: "muted" };

export function unconfirmedPanel({ txUrl, offerOverride, onCheck, onOverride } = {}) {
  const check = el("button", {
    type: "button",
    class: "tap",
    "data-act": "check-again",
    onClick: () => { if (onCheck) onCheck(); },
  }, t("tx.checkAgain"));
  const override = offerOverride ? el("button", {
    type: "button",
    class: "tap",
    "data-act": "explorer-send",
    onClick: () => { if (onOverride) onOverride(); },
  }, t("tx.checkedExplorer")) : null;
  return el("div", { class: "stack", "data-unconfirmed": "1" },
    reasonLine(t("tx.pendingLock")),
    txUrl ? el("a", {
      class: "tap",
      href: txUrl,
      target: "_blank",
      rel: "noopener",
      "data-act": "unconfirmed-tx",
    }, t("flow.tx")) : null,
    check,
    override,
  );
}

export function flowView(phase) {
  const order = ["stamp", "wallet", "chain"];
  const labels = { stamp: "flow.stamp", wallet: "flow.wallet", chain: "flow.chain" };
  const active = phase === "stamping" ? "stamp" : phase === "wallet" ? "wallet" : phase === "chain" || phase === "confirmed" ? "chain" : "";
  return el("ol", { class: "stack flow", "data-phase": phase || "idle" },
    ...order.map((name) => el("li", { class: "card", "data-cell": name, "data-on": active === name ? "1" : "0" }, t(labels[name]))),
  );
}

export function verdictLine(kind, label) {
  return el("span", { class: `row ${VERDICT_CLASS[kind] || ""}` }, icon(VERDICT_ICON[kind] || "dot"), el("span", {}, label));
}

function nearOrNone(value) {
  const raw = u128(value);
  if (raw === U128_MAX) return t("common.none");
  return `${yoctoToNear(raw)} ${t("common.near")}`;
}

function isUnset(value) {
  return value === t("common.none") || value === t("common.no") || value === "0" || value === "";
}

function ruleLine(label, value) {
  const wide = String(value).length > 24;
  return el("p", {}, el("span", { class: "lbl" }, label), " ", el("span", { class: wide ? "num break" : "num" }, value));
}

export function rulesView(rules, tier2, options = {}) {
  if (!rules) return emptyState(t("hist.empty"));
  const judgeOn = options.judgeOn === true;
  const payees = Array.isArray(rules.payees) ? rules.payees : [];
  const cats = Array.isArray(rules.allowed_categories) ? rules.allowed_categories : [];
  const rows = [
    [t("rules.apply"), rules.enabled ? t("common.yes") : t("common.no")],
    [t("rules.perTx"), nearOrNone(rules.per_tx_limit)],
    [t("rules.perDay"), nearOrNone(rules.per_day_limit)],
    [t("rules.count"), Number(rules.max_tx_per_day) === U32_MAX ? t("common.none") : String(rules.max_tx_per_day)],
    [t("rules.tz"), String(rules.tz_offset_min ?? 0)],
    [t("rules.winStart"), String(rules.window_start_min ?? 0)],
    [t("rules.winEnd"), String(rules.window_end_min ?? 0)],
    [t("rules.cats"), cats.length ? cats.join(", ") : t("common.none")],
    [t("rules.jevReq"), rules.jev_required ? t("common.yes") : t("common.no")],
    [t("rules.review"), tier2 ? nearOrNone(tier2.amount_threshold) : t("common.none")],
    [t("rules.payeeAlias"), payees.length ? payees.map((row) => `${row.alias} ${row.account}`).join(", ") : t("common.none")],
  ];
  if (judgeOn) rows.splice(8, 0, [t("rules.jevQ"), String(rules.jev_threshold_permille ?? "")]);
  const setRows = rows.filter(([, value]) => !isUnset(value));
  const unsetRows = rows.filter(([, value]) => isUnset(value));
  return el("div", { class: "stack" },
    ...setRows.map(([label, value]) => ruleLine(label, value)),
    unsetRows.length ? el("details", {},
      el("summary", {}, t("tour.unset")),
      ...unsetRows.map(([label, value]) => ruleLine(label, value)),
    ) : null,
    judgeOn ? null : el("p", { "data-judge": "off" }, t("rules.judgeOff")),
    el("p", { class: "lbl" }, t("rules.jev")),
    el("p", { class: "help" }, t("rules.jevHelp")),
  );
}

export function tourSummary(facts) {
  const unread = t("hist.unread");
  const near = (value) => `${yoctoToNear(value)} ${t("common.near")}`;
  const review = facts.review == null
    ? unread
    : (facts.review === U128_MAX ? t("common.none") : near(facts.review));
  const row = (label, value, wide) => el("p", {},
    el("span", { class: "lbl" }, label),
    " ",
    el("span", { class: wide ? "num break" : "num" }, value),
  );
  const hashRow = el("p", {},
    el("span", { class: "lbl" }, t("tour.sumHash")),
    " ",
    el("span", { class: facts.codeHash ? "num break" : "num" }, facts.codeHash || unread),
    facts.hashMatches ? el("span", {}, ` ${t("tour.hashMatch")}`) : null,
  );
  return el("div", { class: "stack", "data-tour-summary": "1" },
    row(t("tour.sumEscrow"), facts.escrow == null ? unread : near(facts.escrow), false),
    row(t("tour.sumReview"), review, false),
    row(t("tour.sumKeys"), facts.keys == null ? unread : String(facts.keys), false),
    hashRow,
    facts.mandates == null ? null : row(t("tour.sumMandates"), String(facts.mandates), false),
  );
}

function originalBlock(facts) {
  if (!facts.originalFound) return [el("p", { "data-mandate-text": "missing" }, t("hold.noOriginal"))];
  return [el("div", { class: "stack", "data-original": "1" },
    el("p", { "data-mandate-text": "saved" }, el("span", { class: "lbl" }, t("man.instruction")), " ", facts.original),
  )];
}

export function pendingView(items, { readOnly, onApprove, onReject, onExpire, lockReason, busy, heldAction, gate } = {}) {
  if (!items) return skeleton(5, t("hold.loading"));
  if (!items.length) return emptyState(t("hold.empty"));
  return el("div", { class: "stack" }, ...items.map((item) => pendingCard(item, { readOnly, onApprove, onReject, onExpire, lockReason, busy, heldAction, gate })));
}

function pendingCard(item, { readOnly, onApprove, onReject, onExpire, lockReason, busy, heldAction, gate }) {
  const facts = approvalFacts(item, loadDevice().mandates, gate || item?.gate || "");
  const deadline = item.deadline ?? item.deadline_ns;
  const expired = BigInt(deadline || 0) <= BigInt(Date.now()) * 1000000n;
  const amount = yoctoToNear(facts.amount);
  const kids = [
    el("p", { class: "amount num", "data-hold-amount": "1" }, `${amount} ${t("common.near")}`),
    el("p", { "data-hold-target": "1" }, el("span", { class: "lbl" }, t("hist.target")), " ", el("span", { class: "break" }, facts.target)),
    el("p", { "data-hold-serial": "1" }, el("span", { class: "lbl" }, t("hold.serial")), " ", facts.serial),
    el("p", { "data-hold-id": "1" }, el("span", { class: "lbl" }, t("hold.holdId")), " ", facts.id),
    el("p", {}, el("span", { class: "lbl" }, t("hold.hash")), " ", el("span", { class: "num" }, shortHash(item.instruction_hash || ""))),
    ...originalBlock(facts),
    el("p", {}, el("span", { class: "lbl" }, t("hold.for")), " ", item.predecessor || ""),
    el("p", { class: "num" }, el("span", { class: "lbl" }, t("hold.left")), " ", el("span", { "data-countdown": "1" }, countdown(deadline))),
  ];
  if (expired) {
    kids.push(el("p", {}, t("hold.expired")));
    if (!readOnly) {
      const releaseHeld = !!busy || !!heldAction;
      const release = el("button", {
        type: "button",
        class: "tap",
        "data-act": "expire-hold",
        "data-id": String(item.id),
        onClick: () => { if (!releaseHeld && onExpire) onExpire(item); },
      }, t("hold.release"));
      if (releaseHeld) {
        release.disabled = true;
        release.dataset.disabledReason = !!heldAction ? t("tx.pendingLock") : t("flow.working");
      }
      kids.push(release);
    }
  } else if (!readOnly) {
    const approveHeld = !!busy || !!heldAction;
    const rejectHeld = !!busy || !!heldAction;
    const approve = el("button", { type: "button", class: "tap primary", "data-act": "approve", "data-id": String(item.id), onClick: () => { if (!lockReason && !approveHeld) onApprove(item); } }, t("hold.approve"));
    const reject = el("button", { type: "button", class: "tap", "data-act": "reject", "data-id": String(item.id), onClick: () => { if (!lockReason && !rejectHeld) onReject(item); } }, t("hold.reject"));
    if (lockReason || approveHeld) {
      approve.disabled = true;
      approve.dataset.disabledReason = lockReason || (!!heldAction ? t("tx.pendingLock") : t("flow.working"));
    }
    if (lockReason || rejectHeld) {
      reject.disabled = true;
      reject.dataset.disabledReason = lockReason || (!!heldAction ? t("tx.pendingLock") : t("flow.working"));
    }
    kids.push(el("div", { class: "row" }, approve, reject));
  }
  return el("article", { class: "card", "data-pending": String(item.id), "data-expired": expired ? "1" : "0" }, ...kids);
}

export function historyView(rows, { error, onRefresh, onRetry, onRetryRow } = {}) {
  const refresh = el("button", { type: "button", class: "tap", "data-act": "refresh", onClick: onRefresh }, icon("refresh"), el("span", {}, t("hist.refresh")));
  if (error) {
    const messageKey = error?.kind === "indexer" ? "hist.unread" : undefined;
    return el("div", { class: "stack" }, refresh, failureState(error, onRetry || onRefresh, messageKey));
  }
  if (!rows) return el("div", { class: "stack" }, refresh, skeleton(5, t("hist.loading")));
  if (!rows.length) return el("div", { class: "stack" }, refresh, emptyState(t("hist.empty")));
  const lang = currentLang();
  return el("div", { class: "stack" },
    refresh,
    el("p", { class: "help" }, t("hist.cap")),
    ...rows.map((row) => historyCard(row, lang, onRetryRow)),
  );
}

function agentText(row) {
  if (row.agentKind === "owner") return t("hist.owner");
  if (row.agent) return row.agent;
  return t("hist.unread");
}

function historyCard(row, lang, onRetryRow) {
  if (row.unread) {
    return el("article", { class: "card table-card", "data-unread": row.txHash || "" },
      el("p", {}, t("hist.unread")),
      el("button", {
        type: "button",
        class: "tap",
        "data-act": "hist-retry",
        "data-hash": row.txHash || "",
        onClick: () => { if (onRetryRow) onRetryRow(row); },
      }, t("state.retry")),
      row.explorer ? el("a", { class: "tap", href: row.explorer, target: "_blank", rel: "noopener", "data-act": "explorer" }, t("hist.tx")) : null,
    );
  }
  const verdict = t(`verdict.${row.verdict}`);
  const mapped = row.panic ? panicKey(row.panic) : "";
  const reason = row.panic ? t(mapped || "panic.generic") : t(row.reasonKey);
  const code = row.reasonCode || (row.panic ? row.panic : "");
  const amount = row.amountKind === "budget"
    ? t("hist.budget", { amount: yoctoToNear(row.amount) })
    : `${yoctoToNear(row.amount)} ${t("common.near")}`;
  const amountNode = row.amountKind === "budget"
    ? el("p", { class: "num" }, amount)
    : el("p", { class: "num" }, el("span", { class: "lbl" }, t("hist.amount")), " ", amount);
  return el("article", { class: "card table-card", "data-verdict": row.verdict || "", "data-agent-kind": row.agentKind || "" },
    el("p", { class: "num" }, el("span", { class: "lbl" }, t("hist.time")), " ", formatKst(row.timeMs, lang)),
    el("p", {}, el("span", { class: "lbl" }, t(row.agentKind === "owner" ? "hist.sender" : "hist.agent")), " ", el("span", { class: row.agentKind === "account" ? "break" : "" }, agentText(row))),
    row.target ? el("p", {}, el("span", { class: "lbl" }, t("hist.target")), " ", el("span", { class: "break" }, row.target)) : null,
    amountNode,
    el("p", { class: "badge" }, row.source === "recorded" ? t("hist.recorded") : t("hist.live")),
    el("p", {}, verdictLine(row.verdict, verdict)),
    row.verdict === "registered" ? null : el("p", {}, el("span", { class: "lbl" }, t("hist.reason")), " ", reason, code ? el("span", { class: "code" }, ` ${code}`) : ""),
    row.paidZero ? el("p", { class: "num" }, t("hist.paid0")) : null,
    row.explorer ? el("a", { class: "tap", href: row.explorer, target: "_blank", rel: "noopener", "data-act": "explorer" }, t("hist.tx")) : null,
  );
}

export function notice(text) { return reasonLine(text); }
