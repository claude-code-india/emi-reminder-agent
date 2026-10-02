# Agent Tools — Riya (Autopay Recovery)

These are the tools/actions exposed to the Sarvam voice agent. Each maps 1:1 to an HTTP endpoint in [`docs/api-contract.md`](../docs/api-contract.md).

## Base URL, auth and ngrok

- Local base URL: `http://localhost:3000`
- Sarvam calls your tools from the internet, so expose the API publicly:
  ```bash
  npm run dev            # or however the backend is started; listens on :3000
  ngrok http 3000        # copy the https forwarding URL, e.g. https://abcd-1234.ngrok-free.app
  ```
  Use that HTTPS URL as `{{BASE_URL}}` in every tool below. Free ngrok URLs change on each restart — update the tool URLs when they do.
- **Auth:** if the server has `TOOL_API_KEY` set, every `/api/*` request must include the header
  ```
  x-api-key: <TOOL_API_KEY>
  Content-Type: application/json
  ```
  Configure this header on every tool. Missing/wrong key → the request is rejected (unauthorised); the agent should treat it as a system error (see "Generic errors").
- Customer IDs are case-insensitive (`cus_001` == `CUS_001`). In `/api/payments/:id/...`, `:id` is the **customer_id**, not the payment_id.
- Optional health check: `GET {{BASE_URL}}/health`.

## Tool index

| Tool | Method | Path |
|---|---|---|
| `get_customer` | GET | `/api/customers/{customer_id}` |
| `get_payment_status` | GET | `/api/customers/{customer_id}/payment` |
| `retry_payment` | POST | `/api/payments/{customer_id}/retry` |
| `send_payment_link` | POST | `/api/payments/{customer_id}/payment-link` |
| `schedule_callback` | POST | `/api/callbacks` |
| `escalate_to_human` | POST | `/api/escalations` |
| `log_outcome` | POST | `/api/outcomes` |

Not exposed to the agent (operator/dev only): `GET /api/customers`, `GET /api/outcomes` (audit log), `POST /api/reset`.

> Example responses below show the fields named in the contract. Exact extra fields may vary; the agent should rely only on the fields listed.

---

## 1. `get_customer`

**When to use:** at call start if platform variables (name, merchant, language) are missing, or to re-check the profile. Not needed if `{{customer_name}}`, `{{merchant_name}}`, `{{preferred_language}}` were injected.

**HTTP:** `GET {{BASE_URL}}/api/customers/{customer_id}`

**Parameters schema**
```json
{
  "type": "object",
  "properties": {
    "customer_id": { "type": "string", "description": "Customer ID, e.g. CUS_001 (path parameter)", "pattern": "^[Cc][Uu][Ss]_[0-9]{3}$" }
  },
  "required": ["customer_id"]
}
```

**Example**
```http
GET /api/customers/CUS_001
x-api-key: <TOOL_API_KEY>
```
```json
{
  "customer_id": "CUS_001",
  "name": "Aarav Sharma",
  "phone": "+91******0001",
  "preferred_language": "hi-IN",
  "merchant": "FitPulse Gym",
  "plan": "Monthly Membership",
  "mandate_type": "UPI Autopay",
  "mandate_status": "active"
}
```
Phone is masked — never read it aloud.

**Errors**
| Status | Meaning | Agent says |
|---|---|---|
| 404 | Unknown customer | "I'm sorry, I'm not able to find your details right now. I'll have someone from the team get back to you." → `log_outcome` (`no_answer`, summary "customer record not found"). |

---

## 2. `get_payment_status`

**When to use:** **always**, right after identity is confirmed and before mentioning the amount or reason. Drives the whole decision tree.

**HTTP:** `GET {{BASE_URL}}/api/customers/{customer_id}/payment`

**Parameters schema**
```json
{
  "type": "object",
  "properties": {
    "customer_id": { "type": "string", "description": "Customer ID, e.g. CUS_001 (path parameter)" }
  },
  "required": ["customer_id"]
}
```

**Example**
```http
GET /api/customers/CUS_001/payment
x-api-key: <TOOL_API_KEY>
```
```json
{
  "customer_id": "CUS_001",
  "merchant": "FitPulse Gym",
  "plan": "Monthly Membership",
  "mandate_type": "UPI Autopay",
  "payment": {
    "payment_id": "pay_DEMO001",
    "amount_inr": 1499,
    "due_date": "2026-10-01",
    "status": "failed",
    "failure_code": "INSUFFICIENT_FUNDS",
    "failure_reason": "Insufficient funds in the linked bank account",
    "attempts": 1
  },
  "disputed": false,
  "recovery_options": {
    "can_retry": true,
    "retry_block_reason": null,
    "can_send_payment_link": true,
    "recommended_action": "retry_payment"
  }
}
```

**How to read it**
- `payment.status == "recovered"` → thank, `log_outcome(already_paid)`. Never retry.
- `payment.status == "retry_initiated"` → a retry is already in progress; reassure, don't retry again.
- `disputed == true` → `escalate_to_human(reason: dispute)`.
- `recovery_options.can_retry == true` → ask consent → `retry_payment`.
- `can_retry == false` → use `retry_block_reason` to explain, offer `send_payment_link` if `can_send_payment_link`.
- Retryable codes: `INSUFFICIENT_FUNDS`, `BANK_TECHNICAL_ERROR`, `AFA_NOT_COMPLETED`. Not retryable: `CARD_EXPIRED`, `MANDATE_REVOKED`, `ACCOUNT_FROZEN`, `AMOUNT_EXCEEDS_LIMIT`. `attempts >= 3` → not retryable.

**Errors**
| Status | Meaning | Agent says |
|---|---|---|
| 404 | Unknown customer / no payment | "I'm not able to pull up the payment details right now. Let me have a colleague call you back." → `escalate_to_human(other)` or `schedule_callback`. |

---

## 3. `retry_payment`

**When to use:** only when the payment is retryable **and** the customer has said a clear "yes" to retrying the stated amount in this call. Always send `customer_consent: true` — never send it without a real yes.

**HTTP:** `POST {{BASE_URL}}/api/payments/{customer_id}/retry`

**Parameters schema**
```json
{
  "type": "object",
  "properties": {
    "customer_id": { "type": "string", "description": "Customer ID (path parameter, NOT payment_id)" },
    "customer_consent": { "type": "boolean", "const": true, "description": "Must be true; set only after an explicit verbal yes" }
  },
  "required": ["customer_id", "customer_consent"],
  "additionalProperties": false
}
```
Body sent: `{ "customer_consent": true }`

**Example**
```http
POST /api/payments/CUS_001/retry
x-api-key: <TOOL_API_KEY>
Content-Type: application/json

{ "customer_consent": true }
```
```json
{
  "status": "retry_initiated",
  "retry_id": "rty_xxxxxxxx",
  "amount_inr": 1499,
  "message": "Mandate retry initiated"
}
```
Agent: "I've started the retry for fourteen ninety-nine rupees. You'll get a confirmation SMS shortly." → `log_outcome(payment_recovery_initiated)`.

**Errors**
| Status / code | Meaning | Agent says / does |
|---|---|---|
| 400 `CONSENT_REQUIRED` | consent not true | Ask clearly: "Just to confirm, shall I retry the payment of … now? Yes or no?" Retry only on a clear yes. |
| 409 `ALREADY_RECOVERED` | already paid | "Good news, this payment is already received. Thank you!" → `log_outcome(already_paid)`. |
| 409 `DISPUTED_ESCALATE` | open dispute | "I see there's an open concern on this charge, so I'll pass this to our team rather than charge you." → `escalate_to_human(dispute)`. |
| 409 `MAX_ATTEMPTS_REACHED` | ≥ 3 attempts | "The autopay can't be retried again, but I can send you a secure payment link. SMS or WhatsApp?" → `send_payment_link`. |
| 409 `NOT_RETRYABLE` | card expired / mandate revoked / account frozen / over limit | Explain the reason simply, offer `send_payment_link`. |
| 409 `RETRY_IN_PROGRESS` | retry already started | "A retry is already in progress, so you don't need to do anything. You'll get an SMS once it's done." Do not retry. |
| 400 `SENSITIVE_DATA_REJECTED` | body had otp/cvv/pin/etc. | Never send such fields. Warn customer: "Please never share your OTP, PIN or CVV with anyone, including me." Re-call with only `customer_consent`. |

---

## 4. `send_payment_link`

**When to use:** retry is not possible (non-retryable code, max attempts, revoked mandate) or the customer prefers to pay manually. Ask SMS or WhatsApp first.

**HTTP:** `POST {{BASE_URL}}/api/payments/{customer_id}/payment-link`

**Parameters schema**
```json
{
  "type": "object",
  "properties": {
    "customer_id": { "type": "string", "description": "Customer ID (path parameter)" },
    "channel": { "type": "string", "enum": ["sms", "whatsapp"], "description": "Where to send the one-time link" }
  },
  "required": ["customer_id", "channel"],
  "additionalProperties": false
}
```
Body sent: `{ "channel": "whatsapp" }`

**Example**
```http
POST /api/payments/CUS_002/payment-link
x-api-key: <TOOL_API_KEY>
Content-Type: application/json

{ "channel": "whatsapp" }
```
```json
{
  "link_id": "plink_xxxxxxxx",
  "short_url": "https://rzp.io/i/xxxxxx",
  "expires_at": "2026-10-09T18:29:59+05:30"
}
```
Agent: "I've sent a secure payment link on WhatsApp to your registered number. It's valid till ninth October." Never read `short_url` aloud. → `log_outcome(payment_link_sent)`.

**Errors**
| Status / code | Meaning | Agent says / does |
|---|---|---|
| 409 `ALREADY_RECOVERED` | already paid | Thank them → `log_outcome(already_paid)`. |
| 409 `DISPUTED_ESCALATE` | open dispute | → `escalate_to_human(dispute)`. |
| 400 (invalid channel) | channel not sms/whatsapp | Ask again: "Should I send it on SMS or WhatsApp?" |
| 400 `SENSITIVE_DATA_REJECTED` | sensitive key in body | Remove it, warn customer never to share such data. |

---

## 5. `schedule_callback`

**When to use:** customer is busy, asks to talk later, wants to pay after salary, or the call is outside 8 AM–7 PM IST. The time must fall within 8 AM–7 PM IST.

**HTTP:** `POST {{BASE_URL}}/api/callbacks`

**Parameters schema**
```json
{
  "type": "object",
  "properties": {
    "customer_id": { "type": "string" },
    "preferred_time": { "type": "string", "format": "date-time", "description": "ISO 8601 with IST offset, e.g. 2026-10-05T11:00:00+05:30; must be 08:00–19:00 IST" },
    "reason": { "type": "string", "description": "Short English reason, e.g. 'customer busy, driving' or 'will pay after salary on 5th'" }
  },
  "required": ["customer_id", "preferred_time", "reason"],
  "additionalProperties": false
}
```

**Example**
```http
POST /api/callbacks
x-api-key: <TOOL_API_KEY>
Content-Type: application/json

{ "customer_id": "CUS_007", "preferred_time": "2026-10-05T11:00:00+05:30", "reason": "will pay after salary on 5th" }
```
```json
{ "callback_id": "cb_xxxxxxxx", "scheduled_for": "2026-10-05T11:00:00+05:30" }
```
Agent: "Done. I'll call you on fifth October at eleven in the morning." → `log_outcome(callback_scheduled)`.

**Errors**
| Status | Meaning | Agent says / does |
|---|---|---|
| 400 (invalid/missing time) | bad ISO time or missing field | Re-confirm: "Which day and time works for you, between 8 am and 7 pm?" and retry with a valid ISO timestamp. |
| 404 | unknown customer | Apologise, offer human escalation. |

---

## 6. `escalate_to_human`

**When to use:** customer asks for a person; disputes the charge; suspects fraud/unauthorised debit; mentions hardship (job loss, medical, can't pay); account frozen with distress; asks for waivers/extensions; or any tool error you can't resolve.

**HTTP:** `POST {{BASE_URL}}/api/escalations`

**Parameters schema**
```json
{
  "type": "object",
  "properties": {
    "customer_id": { "type": "string" },
    "reason": { "type": "string", "enum": ["customer_requested_human", "dispute", "fraud_suspected", "hardship", "other"] },
    "notes": { "type": "string", "description": "1–2 factual English sentences. Never include OTP/PIN/CVV/card numbers." }
  },
  "required": ["customer_id", "reason", "notes"],
  "additionalProperties": false
}
```

**Example**
```http
POST /api/escalations
x-api-key: <TOOL_API_KEY>
Content-Type: application/json

{ "customer_id": "CUS_005", "reason": "dispute", "notes": "Customer says he was billed for 10 seats instead of 5; refuses to pay until corrected." }
```
```json
{ "ticket_id": "esc_xxxxxxxx", "priority": "high", "sla_hours": 24 }
```
Agent: "I've passed this to our team. Someone will contact you within twenty-four hours." Don't read the ticket ID. → `log_outcome(escalated)`.

**Errors**
| Status | Meaning | Agent says / does |
|---|---|---|
| 400 (invalid reason) | reason not in enum | Re-call with the closest valid reason (`other` if unsure). |
| 400 `SENSITIVE_DATA_REJECTED` | notes contained a sensitive key | Rewrite notes without it. |

---

## 7. `log_outcome`

**When to use:** **always, exactly once, at the end of every call** — including wrong person, no answer, declines and hang-ups.

**HTTP:** `POST {{BASE_URL}}/api/outcomes`

**Parameters schema**
```json
{
  "type": "object",
  "properties": {
    "customer_id": { "type": "string" },
    "outcome": {
      "type": "string",
      "enum": ["payment_recovery_initiated", "payment_link_sent", "callback_scheduled", "escalated", "customer_declined", "already_paid", "no_answer"]
    },
    "summary": { "type": "string", "description": "1–2 factual English sentences; no sensitive data" }
  },
  "required": ["customer_id", "outcome", "summary"],
  "additionalProperties": false
}
```

**Example**
```http
POST /api/outcomes
x-api-key: <TOOL_API_KEY>
Content-Type: application/json

{ "customer_id": "CUS_001", "outcome": "payment_recovery_initiated", "summary": "Customer confirmed balance is available and consented to retry of Rs 1499." }
```
```json
{ "outcome_id": "evt_538a07c1", "outcome": "payment_recovery_initiated" }
```
No need to say anything about this to the customer.

**Errors**
| Status | Meaning | Agent does |
|---|---|---|
| 400 (invalid outcome) | outcome not in enum | Re-call with the correct enum value. |
| 400 `SENSITIVE_DATA_REJECTED` | summary had sensitive key | Rewrite without it. |

---

## Generic errors (all tools)

| Situation | Agent says / does |
|---|---|
| 401/403 (missing or wrong `x-api-key`) | System misconfiguration. "I'm having a small technical issue on my side. Let me arrange a callback." Do not claim any action succeeded. |
| 5xx / timeout / network error | "Sorry, our system is not responding right now." Try once more; if it fails again, offer a callback or human, and `log_outcome` honestly. |
| Any unknown error | Never pretend success. Offer callback or `escalate_to_human(other)`. |

---

## Configuring in Sarvam (generic steps)

Exact screen and field names in the Sarvam dashboard may differ; follow the equivalent options.

1. **Start the API**: run the backend on port 3000, start `ngrok http 3000`, and note the HTTPS URL. Set `TOOL_API_KEY` on the server if you want auth.
2. **Create an agent** in the Sarvam platform (voice agent), name it "Riya".
3. **Paste the system prompt**: copy the content of `agent/system-prompt.md` (below the separator line) into the agent's prompt / instructions field.
4. **Define call variables**: make sure the platform injects `customer_id`, `customer_name`, `merchant_name`, `preferred_language` and `current_time_ist` (or remove those that aren't supported and rely on `get_customer`).
5. **Add each tool** as an HTTP/API tool (one per section above):
   - Name: exactly as in this file (e.g. `get_payment_status`).
   - Description: the "When to use" text.
   - Method + URL: e.g. `GET https://<ngrok-url>/api/customers/{customer_id}/payment`.
   - Headers: `x-api-key: <TOOL_API_KEY>`, `Content-Type: application/json`.
   - Parameters: paste the JSON schema; map `customer_id` to the URL path and the rest to the JSON body.
6. **Set languages**: enable Hindi, English, Tamil, Telugu, Bengali and Marathi (hi-IN, en-IN, ta-IN, te-IN, bn-IN, mr-IN) for speech-to-text and text-to-speech, and choose a female voice to match the persona.
7. **Test call**: call with `customer_id = CUS_001` (retry path), `CUS_002` (payment link), `CUS_004` (already paid), `CUS_005` (dispute → escalate). After each call, check `GET /api/outcomes` for the tool actions and logged outcome. Use `POST /api/reset` between test runs.
8. **Update URLs** whenever the ngrok URL changes.
