import { randomUUID } from "node:crypto";
import { type Customer } from "./customers.ts";
import { failureInfo } from "./failure-codes.ts";

export const MAX_ATTEMPTS = 3;

export const OUTCOMES = [
  "payment_recovery_initiated",
  "payment_link_sent",
  "callback_scheduled",
  "escalated",
  "customer_declined",
  "already_paid",
  "no_answer",
] as const;

export const ESCALATION_REASONS = ["customer_requested_human", "dispute", "fraud_suspected", "hardship", "other"] as const;

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export interface AuditEvent {
  id: string;
  at: string;
  customer_id: string;
  action: string;
  detail: Record<string, unknown>;
}

let audit: AuditEvent[] = [];
export const resetAudit = () => { audit = []; };
export const getAudit = () => audit;

/** Append an event to the in-memory audit log. Never pass OTP/PIN/card data in `detail`. */
export function record(customer_id: string, action: string, detail: Record<string, unknown>): AuditEvent {
  const ev = { id: `evt_${randomUUID().replace(/-/g, "").slice(0, 8)}`, at: new Date().toISOString(), customer_id, action, detail };
  audit.push(ev);
  return ev;
}

/** Why a retry is not allowed, or null if it is. */
export function retryBlockReason(c: Customer): { code: string; message: string } | null {
  const p = c.payment;
  if (p.status === "recovered") return { code: "ALREADY_RECOVERED", message: "Payment is already recovered. Do not retry." };
  if (p.status === "retry_initiated") return { code: "RETRY_IN_PROGRESS", message: "A retry is already in progress." };
  if (c.disputed) return { code: "DISPUTED_ESCALATE", message: "Customer has an open dispute. Escalate to a human." };
  if (p.attempts >= MAX_ATTEMPTS) return { code: "MAX_ATTEMPTS_REACHED", message: `Maximum of ${MAX_ATTEMPTS} attempts reached. Offer a payment link.` };
  const info = failureInfo(p.failure_code);
  if (info.action === "escalate") return { code: "ESCALATION_REQUIRED", message: `Failure ${info.code} must be reviewed by a human. Do not retry or send a link.` };
  if (info.action === "retry_later") return { code: "RETRY_LATER", message: `Failure ${info.code} won't clear yet. Schedule a callback or offer a payment link.` };
  if (info.action !== "retry") return { code: "NOT_RETRYABLE", message: `Failure ${info.code} cannot be fixed by retrying the mandate. Offer a payment link.` };
  return null;
}

export function paymentStatus(c: Customer) {
  const block = retryBlockReason(c);
  const info = failureInfo(c.payment.failure_code);
  const canLink = c.payment.status !== "recovered" && !c.disputed && info.action !== "escalate";
  let recommended_action: string;
  if (c.payment.status === "recovered") recommended_action = "thank_customer_no_action";
  else if (c.payment.status === "retry_initiated") recommended_action = "confirm_retry_in_progress";
  else if (c.disputed || info.action === "escalate") recommended_action = "escalate_to_human";
  else if (!block) recommended_action = "offer_retry";
  else if (info.action === "retry_later") recommended_action = "offer_callback_or_payment_link";
  else recommended_action = "offer_payment_link";
  return {
    customer_id: c.customer_id,
    name: c.name,
    merchant: c.merchant,
    plan: c.plan,
    mandate_type: c.mandate_type,
    mandate_status: c.mandate_status,
    ...c.payment,
    disputed: c.disputed,
    failure_info: {
      action: info.action,
      explain_en: info.explain_en,
      explain_hi: info.explain_hi,
      customer_fix: info.customer_fix,
    },
    recovery_options: {
      can_retry: !block,
      retry_block_reason: block?.code ?? null,
      can_send_payment_link: canLink,
      recommended_action,
    },
  };
}

export function retryPayment(c: Customer, body: { customer_consent?: unknown }) {
  if (body.customer_consent !== true) {
    throw new ApiError(400, "CONSENT_REQUIRED", "Ask the customer for explicit consent before retrying.");
  }
  const block = retryBlockReason(c);
  if (block) throw new ApiError(409, block.code, block.message);
  c.payment.status = "retry_initiated";
  c.payment.attempts += 1;
  const retry_id = `rty_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  record(c.customer_id, "retry_payment", { retry_id, amount_inr: c.payment.amount_inr, attempt: c.payment.attempts });
  return {
    status: "retry_initiated",
    retry_id,
    payment_id: c.payment.payment_id,
    amount_inr: c.payment.amount_inr,
    attempt: c.payment.attempts,
    message: `Retry of ₹${c.payment.amount_inr.toLocaleString("en-IN")} initiated on the ${c.mandate_type} mandate. The customer will get a pre-debit notification; debit is expected within 24 hours.`,
  };
}

export function sendPaymentLink(c: Customer, body: { channel?: unknown }) {
  const channel = body.channel ?? "sms";
  if (channel !== "sms" && channel !== "whatsapp") throw new ApiError(400, "INVALID_CHANNEL", "channel must be sms or whatsapp");
  if (c.payment.status === "recovered") throw new ApiError(409, "ALREADY_RECOVERED", "Payment is already recovered.");
  if (c.disputed) throw new ApiError(409, "DISPUTED_ESCALATE", "Customer has an open dispute. Escalate to a human.");
  if (failureInfo(c.payment.failure_code).action === "escalate") {
    throw new ApiError(409, "ESCALATION_REQUIRED", "This failure must be reviewed by a human. Do not send a link.");
  }
  const link_id = `plink_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const expires_at = new Date(Date.now() + 48 * 3600_000).toISOString();
  const short_url = `https://rzp.io/demo/${link_id.slice(6)}`;
  record(c.customer_id, "send_payment_link", { link_id, channel, amount_inr: c.payment.amount_inr });
  return { link_id, channel, short_url, amount_inr: c.payment.amount_inr, expires_at };
}

export function scheduleCallback(c: Customer, body: { preferred_time?: unknown; reason?: unknown }) {
  const when = typeof body.preferred_time === "string" ? new Date(body.preferred_time) : null;
  if (!when || Number.isNaN(when.getTime())) throw new ApiError(400, "INVALID_TIME", "preferred_time must be an ISO 8601 timestamp");
  if (when.getTime() < Date.now()) throw new ApiError(400, "TIME_IN_PAST", "preferred_time must be in the future");
  const callback_id = `cb_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  record(c.customer_id, "schedule_callback", { callback_id, scheduled_for: when.toISOString(), reason: body.reason ?? null });
  return { callback_id, scheduled_for: when.toISOString() };
}

export function escalate(c: Customer, body: { reason?: unknown; notes?: unknown }) {
  const reason = body.reason as (typeof ESCALATION_REASONS)[number];
  if (!ESCALATION_REASONS.includes(reason)) {
    throw new ApiError(400, "INVALID_REASON", `reason must be one of ${ESCALATION_REASONS.join(", ")}`);
  }
  const priority = reason === "fraud_suspected" || reason === "dispute" ? "high" : "normal";
  const ticket_id = `tkt_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  record(c.customer_id, "escalate_to_human", { ticket_id, reason, priority, notes: body.notes ?? null });
  return { ticket_id, priority, sla_hours: priority === "high" ? 4 : 24 };
}

export function logOutcome(c: Customer, body: { outcome?: unknown; summary?: unknown }) {
  const outcome = body.outcome as (typeof OUTCOMES)[number];
  if (!OUTCOMES.includes(outcome)) throw new ApiError(400, "INVALID_OUTCOME", `outcome must be one of ${OUTCOMES.join(", ")}`);
  const ev = record(c.customer_id, "log_outcome", { outcome, summary: body.summary ?? null });
  return { outcome_id: ev.id, outcome };
}
