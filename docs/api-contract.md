# API contract (Customer/Payment API used as Sarvam agent tools)

Base URL: `http://localhost:3000` (expose publicly with `ngrok http 3000` for Sarvam).
Auth: if `TOOL_API_KEY` is set, every `/api/*` call must send header `x-api-key: <TOOL_API_KEY>`.
Customer IDs are case-insensitive (`cus_001` == `CUS_001`).

| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | /health | – | liveness |
| GET | /api/customers | – | list all 10 customers (summary) |
| GET | /api/customers/:id | – | customer profile (phone masked, e.g. `+91******0001`) |
| GET | /api/customers/:id/payment | – | failed payment + `recovery_options` {can_retry, retry_block_reason, can_send_payment_link, recommended_action} |
| POST | /api/payments/:id/retry | `{ "customer_consent": true }` | initiate mandate retry → `{status:"retry_initiated", retry_id, amount_inr, message}` |
| POST | /api/payments/:id/payment-link | `{ "channel": "sms" \| "whatsapp" }` | send one-time payment link → `{link_id, short_url, expires_at}` |
| POST | /api/callbacks | `{ customer_id, preferred_time (ISO 8601), reason }` | schedule callback → `{callback_id, scheduled_for}` |
| POST | /api/escalations | `{ customer_id, reason, notes }` | human handoff → `{ticket_id, priority, sla_hours}`; reason ∈ customer_requested_human, dispute, fraud_suspected, hardship, other |
| POST | /api/outcomes | `{ customer_id, outcome, summary }` | log final call outcome; outcome ∈ payment_recovery_initiated, payment_link_sent, callback_scheduled, escalated, customer_declined, already_paid, no_answer |
| GET | /api/outcomes | – | audit log of every tool action + outcome |
| POST | /api/reset | – | reset in-memory state to data/customers.json |

`:id` in /api/payments/:id is the **customer_id**.

## Business rules enforced server-side (guardrails)
- Retry requires `customer_consent: true` → else 400 `CONSENT_REQUIRED`.
- Payment already `recovered` → 409 `ALREADY_RECOVERED` (never re-debit).
- Customer has open dispute → 409 `DISPUTED_ESCALATE`.
- `attempts >= 3` → 409 `MAX_ATTEMPTS_REACHED` (offer payment link).
- Failure codes CARD_EXPIRED, MANDATE_REVOKED, ACCOUNT_FROZEN, AMOUNT_EXCEEDS_LIMIT are not retryable on the mandate → 409 `NOT_RETRYABLE` (offer payment link).
- Retryable codes: INSUFFICIENT_FUNDS, BANK_TECHNICAL_ERROR, AFA_NOT_COMPLETED.
- Any request body containing a key like otp / cvv / pin / upi_pin / card_number / password → 400 `SENSITIVE_DATA_REJECTED`; the value is never stored or logged.
- A successful retry sets payment status to `retry_initiated`; a second retry → 409 `RETRY_IN_PROGRESS`.

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
