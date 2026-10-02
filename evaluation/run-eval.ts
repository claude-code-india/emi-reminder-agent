/**
 * Runs every evaluation scenario against the real Customer/Payment API
 * (started in-process on a random port) and writes the results table into
 * evaluation/results.md between the AUTO markers.
 *
 *   npm run eval    # run + rewrite results.md
 *   npm test        # run, rewrite, exit 1 if anything fails
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createApp } from "../backend/server.ts";
import { FAILURE_CODES, fromRazorpayError } from "../backend/failure-codes.ts";

delete process.env.TOOL_API_KEY; // eval talks to the API directly
const server = createApp();
await new Promise<void>((r) => server.listen(0, r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
console.log = ((orig) => (...a: unknown[]) => { if (!String(a[0]).match(/^(GET|POST) /)) orig(...a); })(console.log);

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}
const inOneHour = () => new Date(Date.now() + 3600_000).toISOString();

interface Scenario {
  name: string;
  customer: string;
  expected: string;
  run: () => Promise<{ pass: boolean; observed: string }>;
}

const scenarios: Scenario[] = [
  {
    name: "Payment failed", customer: "CUS_001", expected: "Explain failure (status + reason available to agent)",
    run: async () => {
      const r = await call("GET", "/api/customers/CUS_001/payment");
      return { pass: r.status === 200 && r.body.failure_code === "INSUFFICIENT_FUNDS" && r.body.amount_inr === 1499,
        observed: `${r.body.failure_code}, ₹${r.body.amount_inr?.toLocaleString("en-IN")}, recommended=${r.body.recovery_options?.recommended_action}` };
    },
  },
  {
    name: "Customer agrees to retry", customer: "CUS_001", expected: "Initiate retry",
    run: async () => {
      const r = await call("POST", "/api/payments/CUS_001/retry", { customer_consent: true });
      return { pass: r.status === 200 && r.body.status === "retry_initiated", observed: `${r.status} ${r.body.status} ${r.body.retry_id}` };
    },
  },
  {
    name: "Retry without consent", customer: "CUS_003", expected: "Reject – consent required",
    run: async () => {
      const r = await call("POST", "/api/payments/CUS_003/retry", {});
      return { pass: r.status === 400 && r.body.error === "CONSENT_REQUIRED", observed: `${r.status} ${r.body.error}` };
    },
  },
  {
    name: "Customer refuses", customer: "CUS_006", expected: "Respect decision – log declined, no debit",
    run: async () => {
      const r = await call("POST", "/api/outcomes", { customer_id: "CUS_006", outcome: "customer_declined", summary: "Customer said no" });
      const p = await call("GET", "/api/customers/CUS_006/payment");
      return { pass: r.status === 200 && p.body.status === "failed" && p.body.attempts === 1,
        observed: `outcome logged; payment still ${p.body.status}, attempts=${p.body.attempts}` };
    },
  },
  {
    name: "Customer asks for human", customer: "CUS_010", expected: "Escalate",
    run: async () => {
      const r = await call("POST", "/api/escalations", { customer_id: "CUS_010", reason: "customer_requested_human", notes: "Wants to talk to a person" });
      return { pass: r.status === 200 && !!r.body.ticket_id, observed: `${r.status} ${r.body.ticket_id} priority=${r.body.priority}` };
    },
  },
  {
    name: "Customer offers OTP", customer: "CUS_008", expected: "Never request/store OTP",
    run: async () => {
      const r = await call("POST", "/api/payments/CUS_008/retry", { customer_consent: true, otp: "482913" });
      const audit = await call("GET", "/api/outcomes");
      const leaked = JSON.stringify(audit.body).includes("482913");
      return { pass: r.status === 400 && r.body.error === "SENSITIVE_DATA_REJECTED" && !leaked,
        observed: `${r.status} ${r.body.error}; OTP in audit log: ${leaked ? "YES" : "no"}` };
    },
  },
  {
    name: "Customer offers UPI PIN / card number", customer: "CUS_002", expected: "Reject credentials",
    run: async () => {
      const a = await call("POST", "/api/payments/CUS_002/payment-link", { channel: "sms", upi_pin: "1234" });
      const b = await call("POST", "/api/payments/CUS_002/payment-link", { channel: "sms", card: { cardNumber: "4111111111111111" } });
      return { pass: a.status === 400 && b.status === 400, observed: `upi_pin→${a.status}, cardNumber→${b.status}` };
    },
  },
  {
    name: "Payment already recovered", customer: "CUS_004", expected: "Don't retry",
    run: async () => {
      const r = await call("POST", "/api/payments/CUS_004/retry", { customer_consent: true });
      return { pass: r.status === 409 && r.body.error === "ALREADY_RECOVERED", observed: `${r.status} ${r.body.error}` };
    },
  },
  {
    name: "Customer disputes charge", customer: "CUS_005", expected: "Escalate (retry blocked)",
    run: async () => {
      const r = await call("POST", "/api/payments/CUS_005/retry", { customer_consent: true });
      const e = await call("POST", "/api/escalations", { customer_id: "CUS_005", reason: "dispute", notes: "Charged for 10 seats instead of 5" });
      return { pass: r.status === 409 && r.body.error === "DISPUTED_ESCALATE" && e.body.priority === "high",
        observed: `retry→${r.status} ${r.body.error}; escalation priority=${e.body.priority}` };
    },
  },
  {
    name: "Non-retryable failure (card expired)", customer: "CUS_002", expected: "Send payment link instead",
    run: async () => {
      const r = await call("POST", "/api/payments/CUS_002/retry", { customer_consent: true });
      const l = await call("POST", "/api/payments/CUS_002/payment-link", { channel: "whatsapp" });
      return { pass: r.status === 409 && r.body.error === "NOT_RETRYABLE" && l.status === 200,
        observed: `retry→${r.status} ${r.body.error}; link→${l.body.short_url}` };
    },
  },
  {
    name: "Max attempts reached", customer: "CUS_009", expected: "No retry, offer link",
    run: async () => {
      const r = await call("POST", "/api/payments/CUS_009/retry", { customer_consent: true });
      return { pass: r.status === 409 && r.body.error === "MAX_ATTEMPTS_REACHED", observed: `${r.status} ${r.body.error}` };
    },
  },
  {
    name: "Double retry", customer: "CUS_008", expected: "Second retry blocked",
    run: async () => {
      const a = await call("POST", "/api/payments/CUS_008/retry", { customer_consent: true });
      const b = await call("POST", "/api/payments/CUS_008/retry", { customer_consent: true });
      return { pass: a.status === 200 && b.status === 409 && b.body.error === "RETRY_IN_PROGRESS", observed: `1st→${a.status}, 2nd→${b.status} ${b.body.error}` };
    },
  },
  {
    name: "Customer busy", customer: "CUS_007", expected: "Schedule callback",
    run: async () => {
      const r = await call("POST", "/api/callbacks", { customer_id: "CUS_007", preferred_time: inOneHour(), reason: "Salary credit on 5th" });
      const bad = await call("POST", "/api/callbacks", { customer_id: "CUS_007", preferred_time: "2020-01-01T10:00:00Z" });
      return { pass: r.status === 200 && !!r.body.callback_id && bad.status === 400, observed: `${r.body.callback_id}; past time→${bad.status} ${bad.body.error}` };
    },
  },
  {
    name: "Unknown customer", customer: "CUS_999", expected: "404, agent must not guess",
    run: async () => {
      const r = await call("GET", "/api/customers/CUS_999/payment");
      return { pass: r.status === 404, observed: `${r.status} ${r.body.error}` };
    },
  },
  {
    name: "Every call logs an outcome", customer: "CUS_001", expected: "Outcome recorded in audit log",
    run: async () => {
      await call("POST", "/api/outcomes", { customer_id: "CUS_001", outcome: "payment_recovery_initiated", summary: "Retry initiated with consent" });
      const a = await call("GET", "/api/outcomes");
      const ok = a.body.some((e: any) => e.customer_id === "CUS_001" && e.action === "log_outcome");
      return { pass: ok, observed: `${a.body.length} audit events` };
    },
  },
  {
    name: "Failure-code catalogue served", customer: "–", expected: "Every code has an action + explanation",
    run: async () => {
      const r = await call("GET", "/api/failure-codes");
      const ok = r.status === 200 && r.body.length === FAILURE_CODES.length &&
        r.body.every((f: any) => f.action && f.explain_en && f.explain_hi && f.applies_to.length);
      return { pass: ok, observed: `${r.body.length} codes` };
    },
  },
  {
    name: "Unknown failure code", customer: "–", expected: "Treated as UNKNOWN_ERROR → escalate, never guess",
    run: async () => {
      const r = await call("GET", "/api/failure-codes/SOMETHING_NEW");
      return { pass: r.body.code === "UNKNOWN_ERROR" && r.body.action === "escalate", observed: `${r.body.code} → ${r.body.action}` };
    },
  },
  {
    name: "Razorpay error → code mapping", customer: "–", expected: "Gateway errors normalised correctly",
    run: async () => {
      const cases: Array<[Record<string, string>, string]> = [
        [{ reason: "insufficient_balance", description: "Payment failed due to insufficient balance" }, "INSUFFICIENT_FUNDS"],
        [{ reason: "mandate_revoked", description: "The mandate was revoked by the customer" }, "MANDATE_REVOKED"],
        [{ reason: "card_expired", description: "Your card has expired" }, "CARD_EXPIRED"],
        [{ reason: "payment_risk_check_failed", description: "Payment blocked due to suspicious activity" }, "RISK_DECLINED"],
        [{ reason: "bank_technical_error", description: "Bank is facing technical issues" }, "BANK_TECHNICAL_ERROR"],
        [{ reason: "", description: "something odd" }, "UNKNOWN_ERROR"],
      ];
      const wrong = cases.filter(([e, want]) => fromRazorpayError(e) !== want).map(([e, want]) => `${e.reason}→${fromRazorpayError(e)}≠${want}`);
      return { pass: wrong.length === 0, observed: wrong.length ? wrong.join("; ") : `${cases.length}/${cases.length} mapped` };
    },
  },
];

await call("POST", "/api/reset");
const rows: string[] = [];
let failed = 0;
for (const s of scenarios) {
  let res: { pass: boolean; observed: string };
  try { res = await s.run(); } catch (e) { res = { pass: false, observed: String(e) }; }
  if (!res.pass) failed++;
  process.stdout.write(`${res.pass ? "PASS" : "FAIL"}  ${s.name} — ${res.observed}\n`);
  rows.push(`| ${s.name} | ${s.customer} | ${s.expected} | ${res.observed.replace(/\|/g, "\\|")} | ${res.pass ? "✅ Pass" : "❌ Fail"} |`);
}
server.close();

const table = [
  `_Generated by \`npm run eval\` on ${new Date().toISOString()} — ${scenarios.length - failed}/${scenarios.length} passed._`,
  "",
  "| Scenario | Customer | Expected behaviour | Observed (API) | Result |",
  "| --- | --- | --- | --- | --- |",
  ...rows,
].join("\n");

const file = new URL("./results.md", import.meta.url);
const current = readFileSync(file, "utf8");
const updated = current.replace(/<!-- AUTO:START -->[\s\S]*<!-- AUTO:END -->/, `<!-- AUTO:START -->\n${table}\n<!-- AUTO:END -->`);
writeFileSync(file, updated);
process.stdout.write(`\n${scenarios.length - failed}/${scenarios.length} passed. Wrote evaluation/results.md\n`);
if (process.argv.includes("--check") && failed) process.exit(1);
