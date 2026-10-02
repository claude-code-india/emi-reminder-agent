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
import { signPayload } from "../backend/webhooks.ts";
import { getCustomer, listCustomers } from "../backend/customers.ts";
import { planCalls } from "../scripts/dial-all.ts";

delete process.env.TOOL_API_KEY; // eval talks to the API directly
const WEBHOOK_SECRET = "eval_test_webhook_secret";
process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
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
async function webhook(payload: unknown, opts: { eventId?: string; secret?: string } = {}) {
  const raw = JSON.stringify(payload);
  const res = await fetch(base + "/webhooks/razorpay", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-razorpay-signature": signPayload(raw, opts.secret ?? WEBHOOK_SECRET),
      ...(opts.eventId ? { "x-razorpay-event-id": opts.eventId } : {}),
    },
    body: raw,
  });
  return { status: res.status, body: (await res.json()) as any };
}
const rzpPayment = (event: string, entity: Record<string, unknown>) => ({
  entity: "event", event, contains: ["payment"],
  payload: { payment: { entity: { entity: "payment", currency: "INR", method: "card",
    card: { id: "card_EVAL", last4: "1111", network: "Visa", type: "debit" }, ...entity } } },
  created_at: Math.floor(Date.now() / 1000),
});
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
  {
    name: "Webhook: signed payment.failed", customer: "CUS_003", expected: "Signature verified; failure code/amount/attempts updated",
    run: async () => {
      const r = await webhook(rzpPayment("payment.failed", {
        id: "pay_DEMO003", amount: 450000, status: "failed", notes: { customer_id: "CUS_003" },
        error_code: "BAD_REQUEST_ERROR", error_reason: "insufficient_balance", error_description: "Payment failed due to insufficient balance",
      }), { eventId: "evt_eval_failed_1" });
      const p = await call("GET", "/api/customers/CUS_003/payment");
      return { pass: r.status === 200 && p.body.failure_code === "INSUFFICIENT_FUNDS" && p.body.status === "failed" && p.body.attempts === 2 && p.body.amount_inr === 4500,
        observed: `${r.status}; ${p.body.failure_code}, attempts=${p.body.attempts}, ₹${p.body.amount_inr?.toLocaleString("en-IN")}` };
    },
  },
  {
    name: "Webhook: bad signature", customer: "CUS_003", expected: "Reject 401, state unchanged",
    run: async () => {
      const r = await webhook(rzpPayment("payment.captured", { id: "pay_DEMO003", notes: { customer_id: "CUS_003" } }), { eventId: "evt_eval_forged", secret: "wrong" });
      const p = await call("GET", "/api/customers/CUS_003/payment");
      return { pass: r.status === 401 && r.body.error === "INVALID_SIGNATURE" && p.body.status === "failed", observed: `${r.status} ${r.body.error}; status still ${p.body.status}` };
    },
  },
  {
    name: "Webhook: duplicate event id", customer: "CUS_003", expected: "Ignored (idempotent)",
    run: async () => {
      const r = await webhook(rzpPayment("payment.failed", {
        id: "pay_DEMO003", amount: 450000, notes: { customer_id: "CUS_003" }, error_reason: "insufficient_balance", error_description: "insufficient balance",
      }), { eventId: "evt_eval_failed_1" });
      const p = await call("GET", "/api/customers/CUS_003/payment");
      return { pass: r.status === 200 && r.body.duplicate === true && p.body.attempts === 2, observed: `${r.status} duplicate=${r.body.duplicate}; attempts=${p.body.attempts}` };
    },
  },
  {
    name: "Webhook: payment.captured", customer: "CUS_003", expected: "Marked recovered; retry → 409 ALREADY_RECOVERED; card data not stored",
    run: async () => {
      const r = await webhook(rzpPayment("payment.captured", { id: "pay_DEMO003", amount: 450000, status: "captured", contact: "+919800000003" }), { eventId: "evt_eval_captured_1" });
      const p = await call("GET", "/api/customers/CUS_003/payment");
      const retry = await call("POST", "/api/payments/CUS_003/retry", { customer_consent: true });
      const audit = await call("GET", "/api/outcomes");
      const leaked = JSON.stringify(audit.body).includes("card_EVAL");
      return { pass: r.status === 200 && p.body.status === "recovered" && retry.status === 409 && retry.body.error === "ALREADY_RECOVERED" && !leaked,
        observed: `${r.status}; status=${p.body.status}; retry→${retry.status} ${retry.body.error}; card in audit: ${leaked ? "YES" : "no"}` };
    },
  },
  {
    name: "Dialer plan (dry run)", customer: "all", expected: "Escalate-only not dialled; recovered skipped; nothing outside 08–19 IST",
    run: async () => {
      await call("POST", "/api/reset");
      const day = planCalls(listCustomers(), { now: new Date("2026-10-02T05:30:00Z") });   // 11:00 IST
      const night = planCalls(listCustomers(), { now: new Date("2026-10-02T15:30:00Z") }); // 21:00 IST
      const ids = (pl: typeof day, d: string) => pl.filter((x) => x.decision === d).map((x) => x.customer.customer_id);
      const calls = ids(day, "call"), esc = ids(day, "escalate"), skip = ids(day, "skip");
      const ok = calls.length === 8 && esc.join() === "CUS_005" && skip.join() === "CUS_004" && ids(night, "call").length === 0 && ids(night, "outside_hours").length === 8;
      return { pass: ok, observed: `11:00 IST: call=${calls.length}, escalate=${esc.join()}, skip=${skip.join()}; 21:00 IST: call=${ids(night, "call").length}` };
    },
  },
  {
    name: "Retry-later code (daily limit)", customer: "CUS_009*", expected: "No retry now; offer callback or link",
    run: async () => {
      const c = getCustomer("CUS_009")!;
      Object.assign(c.payment, { status: "failed", attempts: 1, failure_code: "DAILY_LIMIT_EXCEEDED" });
      const p = await call("GET", "/api/customers/CUS_009/payment");
      const r = await call("POST", "/api/payments/CUS_009/retry", { customer_consent: true });
      const l = await call("POST", "/api/payments/CUS_009/payment-link", { channel: "sms" });
      return { pass: p.body.recovery_options.recommended_action === "offer_callback_or_payment_link" && r.status === 409 && r.body.error === "RETRY_LATER" && l.status === 200,
        observed: `recommended=${p.body.recovery_options.recommended_action}; retry→${r.status} ${r.body.error}; link→${l.status}` };
    },
  },
  {
    name: "Escalate-only code (risk declined)", customer: "CUS_010*", expected: "No retry, no link; escalate",
    run: async () => {
      const c = getCustomer("CUS_010")!;
      Object.assign(c.payment, { status: "failed", attempts: 1, failure_code: "RISK_DECLINED" });
      const p = await call("GET", "/api/customers/CUS_010/payment");
      const r = await call("POST", "/api/payments/CUS_010/retry", { customer_consent: true });
      const l = await call("POST", "/api/payments/CUS_010/payment-link", { channel: "sms" });
      return { pass: p.body.recovery_options.recommended_action === "escalate_to_human" && r.body.error === "ESCALATION_REQUIRED" && l.body.error === "ESCALATION_REQUIRED",
        observed: `recommended=${p.body.recovery_options.recommended_action}; retry→${r.status} ${r.body.error}; link→${l.status} ${l.body.error}` };
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
  `_Generated by \`npm run eval\` on ${new Date().toISOString()} — ${scenarios.length - failed}/${scenarios.length} passed. Customers marked * have their failure code overridden in-process for that scenario._`,
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
