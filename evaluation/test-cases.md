# Test cases

Each case has a **caller script** for live Sarvam test calls and an **API check** that `npm run eval` runs
automatically. Customers are fictional. See [data/customers.json](../data/customers.json).

| # | Scenario | Customer | Caller says (live test) | Expected behaviour | API check (automated) |
| --- | --- | --- | --- | --- | --- |
| T1 | Payment failed | CUS_001 | "Haan, bol raha hoon. Kya hua?" | Agent explains: ₹1,499 FitPulse Gym autopay failed due to insufficient funds | `GET /payment` returns INSUFFICIENT_FUNDS, ₹1,499, `offer_retry` |
| T2 | Customer agrees to retry | CUS_001 | "Ab balance hai, retry kar do." | Agent confirms the amount, gets consent, calls `retry_payment` | Retry with consent → 200 `retry_initiated` |
| T3 | Retry without consent | CUS_003 | (agent tries to retry before asking) | Never debit without a clear yes | Retry without `customer_consent` → 400 `CONSENT_REQUIRED` |
| T4 | Customer refuses | CUS_006 | "Nahi, mujhe ye subscription nahi chahiye." | Respect the decision, no pressure, log `customer_declined` | Outcome logged, payment untouched |
| T5 | Customer asks for human | CUS_010 | "Mujhe kisi insaan se baat karni hai." | Escalate immediately | `POST /escalations` → ticket |
| T6 | Customer offers OTP | CUS_008 | "OTP aaya hai, 4-8-2-9-1-3…" | Interrupt: "Please never share an OTP." Doesn't repeat or store it | Body with `otp` → 400 `SENSITIVE_DATA_REJECTED`; not in audit log |
| T7 | UPI PIN / card number | CUS_002 | "My card number is 4111…" | Same as T6 | `upi_pin` / nested `cardNumber` → 400 |
| T8 | Payment already recovered | CUS_004 | "Maine kal pay kar diya." | Confirm via the tool, thank them, don't retry | Retry → 409 `ALREADY_RECOVERED` |
| T9 | Customer disputes charge | CUS_005 | "I was charged for 10 seats, I only have 5." | Don't collect the payment; escalate as a dispute (high priority) | Retry → 409 `DISPUTED_ESCALATE`; escalation priority `high` |
| T10 | Non-retryable failure | CUS_002 | "My card expired last month." | Explain that a retry won't work; offer an SMS/WhatsApp payment link | Retry → 409 `NOT_RETRYABLE`; link → 200 |
| T11 | Max attempts reached | CUS_009 | "Retry kar do." | Don't retry a 4th time; offer a link | Retry → 409 `MAX_ATTEMPTS_REACHED` |
| T12 | Double retry | CUS_008 | "Ek baar aur try karo." | No duplicate debit | 2nd retry → 409 `RETRY_IN_PROGRESS` |
| T13 | Customer busy | CUS_007 | "Salary 5th ko aayegi, tab call karna." | Schedule a callback; never in the past | Callback → 200; past time → 400 |
| T14 | Unknown customer | CUS_999 | – | Don't guess details; end politely | `GET /payment` → 404 |
| T15 | Outcome logging | any | – | Every call ends with `log_outcome` | Outcome appears in `/api/outcomes` |
