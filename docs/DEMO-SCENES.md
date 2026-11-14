# Contract, dual lock and inbox demo

Run `cargo run --locked --example demo` in the prepared local sandbox, or `bash scripts/check.sh` for full verification. These are local sandbox transactions, not mainnet/testnet. All JEV judgments come from fixed files; no network API or key is used. Each scene asserts its expected outcome and prints expected versus actual.

| Scene | Tier | Check |
| --- | --- | --- |
| 1 | 1 | Unsigned hidden page instruction denies; no recipient or escrow change |
| 2 | 2a | Signed text, external-content mock context with q=0.97 denies; no payout or reservation |
| 3 | 2b | Confident owner-source report but off-list payee denies; no payout or reservation |
| 4 | 2c → 3 | External-content q=0.62 escalates; owner-signed approval pays reserved amount |
| 5 | 3 | Another escalation is rejected; escrow restored, no payout |
| 6 | 3 | Short 20-second TTL expires; escrow restored, no payout |
| 7 | 2a + 2b | Confident owner-source and compliant rules pass and pay |
| 8 | 2b | Signed rule limit raised: same payment changes from escalate to pass using a fresh signed entry |

The final asserted line uses `DEMO RESULT: N/N steps as expected`; check.sh requires equal values and at least eight scenes. Measured results come only from `bash scripts/summarize-check-log.sh <check log>`. Mock JEV timing prints `JUDGMENT TIME (mock mode, offline pipeline, NOT a JEV service figure)`. The offline timing includes two classifications from an in-memory fixture, report building and pure evaluation; instruction hashing is supplied by the caller outside timing.

Record the local web app too: `#home`, `#pending`, `#rules`, `#history`. Show the 62% explanation, mock approval confirmation, limit preview, owner policy summary and receipt history. The app is sample-data/mock-signing only. Paste EVENT_JSON lines, not demo summary text.

Narration: tier 1 is absolute; tier 2 combines source model judgment (not proof, offline mock) and deterministic rules; uncertainty goes to people. Caller-declared source is supplemented, not proven. Reports are relayed by the caller and verified against owner-registered judge keys and request hashes. Source/context truth remains a model/integration risk. Rejection/expiry/refund restore escrow only; signed entries and budgets remain consumed.

## Agent Economy

`cargo run --locked --example agent_economy` asserts an allowed API subscription payment, an above-limit payment approved over its exact request hash after an owner-signed limit increase, and a hidden instruction blocked without a transfer. It also reuses the attack helpers for budget overrun, replay, altered approval content and missing/malformed reports. Blocked attacks are counted from the local sandbox results and balance checks. Human approvals count only owner approvals in the normal flow; attack-case approvals are excluded. `AGENT ECONOMY RESULT: PASS` requires expected scene behavior, all attacks observed blocked, no normal denials and the required normal-flow approval; runtime counters and local stage timings are labelled mock JEV, offline, not real JEV latency.
