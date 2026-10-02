# API contract (Customer/Payment API used as Sarvam agent tools)

Base URL: `http://localhost:3000` (expose publicly with `ngrok http 3000` for Sarvam).
Auth: if `TOOL_API_KEY` is set, every `/api/*` call must send header `x-api-key: <TOOL_API_KEY>`.
Customer IDs are case-insensitive (`cus_001` == `CUS_001`).

| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | /health | – | liveness |
| GET | /api/customers | – | list all 10 customers (summary) |
| GET | /api/customers/:id | – | customer profile (phone masked, e.g. `+91******0001`) |
| GET | /api/customers/:id/payment | – | failed payment (top-level fields) + `failure_info` {action, explain_en, explain_hi, customer_fix} + `recovery_options` {can_retry, retry_block_reason, can_send_payment_link, recommended_action} |
| POST | /api/payments/:id/retry | `{ "customer_consent": true }` | initiate mandate retry → `{status:"retry_initiated", retry_id, payment_id, amount_inr, attempt, message}` |
| POST | /api/payments/:id/payment-link | `{ "channel": "sms" \| "whatsapp" }` | send one-time payment link → `{link_id, channel, short_url, amount_inr, expires_at}` (48 h expiry) |
| POST | /api/callbacks | `{ customer_id, preferred_time (ISO 8601), reason }` | schedule callback → `{callback_id, scheduled_for}` |
| POST | /api/escalations | `{ customer_id, reason, notes }` | human handoff → `{ticket_id, priority, sla_hours}`; reason ∈ customer_requested_human, dispute, fraud_suspected, hardship, other |
| POST | /api/outcomes | `{ customer_id, outcome, summary }` | log final call outcome; outcome ∈ payment_recovery_initiated, payment_link_sent, callback_scheduled, escalated, customer_declined, already_paid, no_answer |
| GET | /api/failure-codes | – | full failure-code catalogue (27 entries: code, applies_to, action, explain_en, explain_hi, customer_fix) |
| GET | /api/failure-codes/:code | – | one catalogue entry (case-insensitive); unknown codes return the `UNKNOWN_ERROR` entry (action `escalate`), never 404 |
| GET | /api/outcomes | – | audit log of every tool action + outcome |
| POST | /api/reset | – | reset in-memory state to data/customers.json |
| POST | /webhooks/razorpay | Razorpay webhook event | inbound Razorpay events (see "Webhooks and dialer" below); not an agent tool, not behind `x-api-key` |

`:id` in /api/payments/:id is the **customer_id**.

## `recommended_action`
Computed from payment status, dispute flag, attempts and the failure code's `action` (first match wins):

| Condition | `recommended_action` |
|---|---|
| `status == "recovered"` | `thank_customer_no_action` |
| `status == "retry_initiated"` | `confirm_retry_in_progress` |
| `disputed` or `failure_info.action == "escalate"` | `escalate_to_human` |
| retry allowed (`action == "retry"`, attempts < 3) | `offer_retry` |
| `failure_info.action == "retry_later"` | `offer_callback_or_payment_link` |
| anything else (`payment_link`, or attempts ≥ 3) | `offer_payment_link` |

`can_send_payment_link` is false when the payment is recovered, disputed, or the failure action is `escalate`.

## Business rules enforced server-side (guardrails)
- Retry requires `customer_consent: true` → else 400 `CONSENT_REQUIRED`.
- Payment already `recovered` → 409 `ALREADY_RECOVERED` (never re-debit). Applies to retry and payment-link.
- A successful retry sets status to `retry_initiated`; a second retry → 409 `RETRY_IN_PROGRESS`.
- Customer has open dispute → 409 `DISPUTED_ESCALATE` (retry and payment-link).
- `attempts >= 3` → 409 `MAX_ATTEMPTS_REACHED` (offer payment link).
- Retry is allowed only when the failure code's action is `retry`. Otherwise:
  - action `escalate` → 409 `ESCALATION_REQUIRED` (don't collect; hand to a human)
  - action `retry_later` → 409 `RETRY_LATER` (schedule a callback or offer a payment link)
  - action `payment_link` → 409 `NOT_RETRYABLE` (offer payment link)
- Payment-link for a failure whose action is `escalate` → 409 `ESCALATION_REQUIRED`. Invalid channel → 400 `INVALID_CHANNEL`.
- Callbacks: 400 `INVALID_TIME` / `TIME_IN_PAST`. Escalations: 400 `INVALID_REASON`. Outcomes: 400 `INVALID_OUTCOME`. Unknown customer → 404 `CUSTOMER_NOT_FOUND`.
- Any request body containing a key like otp / cvv / pin / upi_pin / card_number / password → 400 `SENSITIVE_DATA_REJECTED`; the value is never stored or logged.
- Error body shape: `{ "error": "<CODE>", "message": "<text>" }`.

## Failure-code catalogue (`backend/failure-codes.ts`)
27 normalised codes across UPI Autopay, eNACH and card e-mandates. "All" = UPI Autopay, eNACH and Card e-Mandate. Each entry also carries `explain_en`, `explain_hi` and `customer_fix` (see `GET /api/failure-codes`).

| Code | Applies to | Action |
|---|---|---|
| INSUFFICIENT_FUNDS | All | `retry` |
| DAILY_LIMIT_EXCEEDED | UPI Autopay, eNACH | `retry_later` |
| CARD_LIMIT_EXCEEDED | Card | `retry_later` |
| AMOUNT_EXCEEDS_LIMIT | All | `payment_link` |
| MANDATE_REVOKED | All | `payment_link` |
| MANDATE_PAUSED | UPI Autopay | `payment_link` |
| MANDATE_EXPIRED | All | `payment_link` |
| MANDATE_NOT_ACTIVE | eNACH | `payment_link` |
| PAYMENT_STOPPED_BY_CUSTOMER | eNACH | `escalate` |
| AFA_NOT_COMPLETED | Card | `retry` |
| PRE_DEBIT_NOTIFICATION_FAILED | UPI Autopay | `retry` |
| ACCOUNT_FROZEN | UPI Autopay, eNACH | `payment_link` |
| ACCOUNT_CLOSED | UPI Autopay, eNACH | `payment_link` |
| ACCOUNT_DORMANT | UPI Autopay, eNACH | `payment_link` |
| ACCOUNT_DETAILS_MISMATCH | eNACH | `payment_link` |
| INVALID_VPA | UPI Autopay | `payment_link` |
| CARD_EXPIRED | Card | `payment_link` |
| CARD_BLOCKED | Card | `payment_link` |
| CARD_REPORTED_LOST_OR_STOLEN | Card | `escalate` |
| ISSUER_DECLINED | Card | `retry` |
| INTERNATIONAL_NOT_ENABLED | Card | `payment_link` |
| BANK_TECHNICAL_ERROR | All | `retry` |
| BANK_TIMEOUT | All | `retry` |
| UPI_APP_ERROR | UPI Autopay | `retry` |
| GATEWAY_ERROR | All | `retry` |
| RISK_DECLINED | All | `escalate` |
| UNKNOWN_ERROR | All | `escalate` |

Totals: 8 `retry`, 2 `retry_later`, 13 `payment_link`, 4 `escalate`. Codes are internal names; in production they're mapped from Razorpay's `payment.failed` error (`reason` / `description`) by `fromRazorpayError`, and anything unmatched becomes `UNKNOWN_ERROR`.

## Webhooks and dialer
- **`POST /webhooks/razorpay`** (`backend/webhooks.ts`): verifies the `X-Razorpay-Signature` header (HMAC-SHA256 of the raw body with the webhook secret; see `.env.example`) and rejects unsigned/invalid requests.
  - `payment.failed` → marks the customer's payment `failed`, with `failure_code` mapped from the Razorpay error via `fromRazorpayError`.
  - `payment.captured` → marks the payment `recovered` (later calls get `thank_customer_no_action`; retries return `ALREADY_RECOVERED`).
- **Outbound calls** (`backend/sarvam.ts`): client that triggers a Sarvam outbound call for a customer, injecting the call variables used by the system prompt. Agent ID and call API URL come from env (see `.env.example`).
- **Batch dialer** (`scripts/dial-all.ts`, `npm run dial`): dials every customer whose payment still needs recovery, only within 8 AM–7 PM IST. `npm run dial -- --dry-run` prints the plan without calling.

## 10 fictional customers (data/customers.json)
| ID | Name | Lang | Merchant | Amount | Failure | Scenario |
|---|---|---|---|---|---|---|
| CUS_001 | Aarav Sharma | hi-IN | FitPulse Gym | ₹1,499 | INSUFFICIENT_FUNDS | demo: agrees to retry |
| CUS_002 | Priya Nair | en-IN | StreamBox OTT | ₹2,999 | CARD_EXPIRED | payment link |
| CUS_003 | Rohit Verma | hi-IN | QuickLearn Academy | ₹4,500 | BANK_TECHNICAL_ERROR | retry / callback |
| CUS_004 | Sneha Iyer | ta-IN | GreenLeaf Insurance | ₹899 | (already recovered) | don't retry |
| CUS_005 | Vikram Singh | hi-IN | CloudDesk SaaS | ₹5,999 | AMOUNT_EXCEEDS_LIMIT, disputed | escalate |
| CUS_006 | Ananya Reddy | te-IN | FreshBasket | ₹749 | MANDATE_REVOKED | payment link / declines |
| CUS_007 | Karan Mehta | en-IN | DriveSafe Motors | ₹18,250 | INSUFFICIENT_FUNDS (2 attempts) | callback after salary |
| CUS_008 | Fatima Khan | hi-IN | BrightSmile Dental | ₹3,200 | AFA_NOT_COMPLETED | retry |
| CUS_009 | Arjun Das | bn-IN | BookNook | ₹599 | INSUFFICIENT_FUNDS (3 attempts) | max attempts → link |
| CUS_010 | Meera Joshi | mr-IN | SkillUp Online | ₹2,499 | ACCOUNT_FROZEN | human / hardship |
