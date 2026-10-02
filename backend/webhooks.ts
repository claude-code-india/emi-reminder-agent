/**
 * Razorpay webhook receiver: POST /webhooks/razorpay
 *
 * - Verifies `X-Razorpay-Signature` = hex HMAC-SHA256(rawBody, RAZORPAY_WEBHOOK_SECRET)
 *   with a constant-time compare. If the secret is unset we accept (dev mode) but warn.
 * - Idempotent on `x-razorpay-event-id` (Razorpay retries deliveries).
 * - Only whitelisted fields are copied into customer state / the audit log; card, VPA,
 *   bank and other instrument details in the payload are never stored.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { listCustomers, type Customer } from "./customers.ts";
import { fromRazorpayError } from "./failure-codes.ts";
import { ApiError, record } from "./payments.ts";

const MAX_TRACKED_EVENTS = 10_000;
let seenEventIds = new Set<string>();
let warnedNoSecret = false;

export const resetWebhooks = () => { seenEventIds = new Set(); };

export function signPayload(rawBody: string | Buffer, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifySignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = Buffer.from(signPayload(rawBody, secret), "utf8");
  const given = Buffer.from(signature.trim(), "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const header = (h: IncomingHttpHeaders, name: string) => {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
};

const last10 = (phone: unknown) => String(phone ?? "").replace(/\D/g, "").slice(-10);

/** Find the customer a payment entity belongs to: notes.customer_id → payment_id → contact phone. */
function findCustomer(entity: Record<string, any> | undefined): Customer | undefined {
  if (!entity) return undefined;
  const all = listCustomers();
  const noteId = typeof entity.notes?.customer_id === "string" ? entity.notes.customer_id.trim().toUpperCase() : "";
  if (noteId) {
    const c = all.find((x) => x.customer_id === noteId);
    if (c) return c;
  }
  if (entity.id) {
    const c = all.find((x) => x.payment.payment_id === entity.id);
    if (c) return c;
  }
  const phone = last10(entity.contact);
  if (phone.length === 10) return all.find((x) => last10(x.phone) === phone);
  return undefined;
}

export function handleRazorpayWebhook(raw: Buffer, headers: IncomingHttpHeaders) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (secret) {
    if (!verifySignature(raw, header(headers, "x-razorpay-signature"), secret)) {
      throw new ApiError(401, "INVALID_SIGNATURE", "X-Razorpay-Signature does not match the request body");
    }
  } else if (!warnedNoSecret) {
    warnedNoSecret = true;
    console.warn("[webhooks] RAZORPAY_WEBHOOK_SECRET is not set – accepting UNSIGNED webhooks (dev mode only).");
  }

  let body: Record<string, any>;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Webhook body must be JSON");
  }
  const event = String(body?.event ?? "");
  if (!event) throw new ApiError(400, "INVALID_EVENT", "Missing `event`");

  const eventId = header(headers, "x-razorpay-event-id");
  if (eventId) {
    if (seenEventIds.has(eventId)) return { received: true, duplicate: true, event, event_id: eventId };
    if (seenEventIds.size >= MAX_TRACKED_EVENTS) seenEventIds = new Set();
    seenEventIds.add(eventId);
  }

  const payment = body.payload?.payment?.entity as Record<string, any> | undefined;
  const base = { event, event_id: eventId ?? null };

  switch (event) {
    case "payment.failed": {
      const c = findCustomer(payment);
      if (!c) {
        record("UNMATCHED", "webhook_unmatched", { ...base, payment_id: payment?.id ?? null });
        return { received: true, ...base, matched: false };
      }
      const failure_code = fromRazorpayError({
        code: payment?.error_code, reason: payment?.error_reason, description: payment?.error_description,
      });
      const p = c.payment;
      if (payment?.id) p.payment_id = String(payment.id);
      p.status = "failed";
      p.failure_code = failure_code;
      p.failure_reason = String(payment?.error_description ?? "Payment failed");
      if (typeof payment?.amount === "number") p.amount_inr = payment.amount / 100;
      p.attempts += 1;
      record(c.customer_id, "webhook_payment_failed", {
        ...base, payment_id: p.payment_id, failure_code, error_code: payment?.error_code ?? null,
        error_reason: payment?.error_reason ?? null, amount_inr: p.amount_inr, attempt: p.attempts,
      });
      return { received: true, ...base, matched: true, customer_id: c.customer_id, status: p.status, failure_code, attempts: p.attempts };
    }
    case "payment.captured": {
      const c = findCustomer(payment);
      if (!c) {
        record("UNMATCHED", "webhook_unmatched", { ...base, payment_id: payment?.id ?? null });
        return { received: true, ...base, matched: false };
      }
      c.payment.status = "recovered";
      if (payment?.id) c.payment.payment_id = String(payment.id);
      record(c.customer_id, "webhook_payment_captured", { ...base, payment_id: c.payment.payment_id, amount_inr: c.payment.amount_inr });
      return { received: true, ...base, matched: true, customer_id: c.customer_id, status: c.payment.status };
    }
    case "subscription.halted":
    case "subscription.pending": {
      const sub = body.payload?.subscription?.entity as Record<string, any> | undefined;
      const id = typeof sub?.notes?.customer_id === "string" ? sub.notes.customer_id.trim().toUpperCase() : "";
      const c = id ? listCustomers().find((x) => x.customer_id === id) : findCustomer(payment);
      record(c?.customer_id ?? "UNMATCHED", `webhook_${event.replace(".", "_")}`, {
        ...base, subscription_id: sub?.id ?? null, subscription_status: sub?.status ?? null,
      });
      return { received: true, ...base, matched: !!c, customer_id: c?.customer_id ?? null };
    }
    default:
      return { received: true, ...base, ignored: true };
  }
}
