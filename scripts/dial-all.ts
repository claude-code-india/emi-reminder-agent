/**
 * Dial every customer whose failed payment the voice agent can actually help with.
 *
 *   npm run dial -- --dry-run --ignore-hours
 *   npm run dial -- --api-url http://localhost:3000     # live payment state from a running API
 *
 * Flags:
 *   --dry-run        build and print requests, place no calls (default when SARVAM_API_KEY is empty)
 *   --ignore-hours   skip the 08:00–19:00 Asia/Kolkata calling-window check (testing only)
 *   --api-url URL    read payment state / create escalations via a running API instead of in-process
 *
 * Rules:
 *   thank_customer_no_action, confirm_retry_in_progress → skip (nothing to recover)
 *   escalate_to_human                                     → never dialled; an escalation ticket is raised
 *   anything else                                         → dial (only inside the calling window)
 */
import { pathToFileURL } from "node:url";
import { listCustomers, type Customer } from "../backend/customers.ts";
import { loadEnv } from "../backend/env.ts";
import { escalate, paymentStatus } from "../backend/payments.ts";
import { triggerCall, type TriggerResult } from "../backend/sarvam.ts";

export const CALL_WINDOW_IST = { startHour: 8, endHour: 19 };
const SKIP_ACTIONS = new Set(["thank_customer_no_action", "confirm_retry_in_progress"]);
const CONCURRENCY = 2;

export interface PlanItem {
  customer: Customer;
  recommended_action: string;
  decision: "call" | "escalate" | "skip" | "outside_hours";
  reason: string;
}

export function istHour(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value) % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value);
  return h + m / 60;
}

export function inCallingWindow(now: Date): boolean {
  const h = istHour(now);
  return h >= CALL_WINDOW_IST.startHour && h < CALL_WINDOW_IST.endHour;
}

/** Pure planning step: no I/O. `actions` maps customer_id → recovery_options.recommended_action. */
export function planCalls(
  customers: Customer[],
  opts: { now?: Date; ignoreHours?: boolean; actions?: Record<string, string> } = {},
): PlanItem[] {
  const now = opts.now ?? new Date();
  const open = opts.ignoreHours || inCallingWindow(now);
  return customers.map((customer) => {
    const action = opts.actions?.[customer.customer_id] ?? paymentStatus(customer).recovery_options.recommended_action;
    if (SKIP_ACTIONS.has(action)) return { customer, recommended_action: action, decision: "skip", reason: "nothing to recover" };
    if (action === "escalate_to_human") {
      return { customer, recommended_action: action, decision: "escalate", reason: customer.disputed ? "open dispute" : `failure ${customer.payment.failure_code} needs human review` };
    }
    if (!open) return { customer, recommended_action: action, decision: "outside_hours", reason: "outside 08:00–19:00 IST" };
    return { customer, recommended_action: action, decision: "call", reason: action };
  });
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

async function main() {
  loadEnv();
  const args = process.argv.slice(2);
  const flag = (f: string) => args.includes(f);
  const apiIdx = args.indexOf("--api-url");
  const apiUrl = apiIdx >= 0 ? args[apiIdx + 1]?.replace(/\/$/, "") : undefined;
  const dryRun = flag("--dry-run") || !(process.env.SARVAM_API_KEY ?? "").trim();
  const ignoreHours = flag("--ignore-hours");
  const apiHeaders = { "content-type": "application/json", ...(process.env.TOOL_API_KEY ? { "x-api-key": process.env.TOOL_API_KEY } : {}) };

  // Phone numbers always come from the local data (the API deliberately masks them);
  // with --api-url the live payment state comes from the running API.
  const customers = listCustomers();
  let actions: Record<string, string> | undefined;
  if (apiUrl) {
    actions = {};
    for (const c of customers) {
      const r = await fetch(`${apiUrl}/api/customers/${c.customer_id}/payment`, { headers: apiHeaders });
      if (!r.ok) throw new Error(`GET payment ${c.customer_id} → HTTP ${r.status}`);
      actions[c.customer_id] = ((await r.json()) as any).recovery_options.recommended_action;
    }
  }

  const now = new Date();
  const plan = planCalls(customers, { now, ignoreHours, actions });
  console.log(`Dialer — ${dryRun ? "DRY RUN (no calls placed)" : "LIVE"} — ${now.toISOString()} (IST hour ${istHour(now).toFixed(2)})` +
    `${ignoreHours ? " — calling window IGNORED" : ""}${apiUrl ? ` — state from ${apiUrl}` : ""}\n`);

  const calls = await pool(plan.filter((p) => p.decision === "call"), CONCURRENCY, (p) => triggerCall(p.customer, { dryRun }));
  const callBy = new Map<string, TriggerResult>(calls.map((r) => [r.customer_id, r]));

  const tickets = new Map<string, string>();
  for (const p of plan.filter((x) => x.decision === "escalate")) {
    const body = { customer_id: p.customer.customer_id, reason: p.customer.disputed ? "dispute" : "other", notes: `Dialer: not called – ${p.reason}` };
    if (dryRun) { tickets.set(p.customer.customer_id, "(would escalate)"); continue; }
    if (apiUrl) {
      const r = await fetch(`${apiUrl}/api/escalations`, { method: "POST", headers: apiHeaders, body: JSON.stringify(body) });
      tickets.set(p.customer.customer_id, r.ok ? ((await r.json()) as any).ticket_id : `HTTP ${r.status}`);
    } else {
      tickets.set(p.customer.customer_id, escalate(p.customer, body).ticket_id + " (in-process)");
    }
  }

  const rows = plan.map((p) => {
    const r = callBy.get(p.customer.customer_id);
    const result = p.decision === "call"
      ? (r?.ok ? (r.dry_run ? "dry-run ok" : `attempt ${r.attempt_id ?? "?"}`) : `ERROR ${r?.error}`)
      : p.decision === "escalate" ? tickets.get(p.customer.customer_id) ?? "" : p.reason;
    return { customer: p.customer.customer_id, name: p.customer.name, lang: p.customer.preferred_language, action: p.recommended_action, decision: p.decision, result };
  });
  console.table(rows);
  const count = (d: PlanItem["decision"]) => plan.filter((p) => p.decision === d).length;
  const failed = calls.filter((c) => !c.ok).length;
  console.log(`\n${dryRun ? "would_call" : "called"}=${count("call") - failed} failed=${failed} escalated=${count("escalate")} skipped=${count("skip")} outside_hours=${count("outside_hours")}`);
  if (dryRun && calls[0]) console.log("\nSample request body:\n" + JSON.stringify(calls[0].request, null, 2));
  if (failed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
