/**
 * Catalogue of autopay failure codes across UPI Autopay, eNACH and card e-mandates.
 *
 * Codes are normalised internal names. In production they are mapped from the
 * `error_code` / `error_reason` / `error_description` on Razorpay's `payment.failed`
 * webhook (and the underlying NPCI / issuer response) — see `fromRazorpayError`.
 *
 * `action` drives what the voice agent is allowed to offer:
 *   retry          – safe to retry the mandate after explicit consent
 *   retry_later    – retryable, but only after a fix on the customer's side (e.g. limit resets);
 *                    the agent should schedule a callback or offer a link rather than retry now
 *   payment_link   – the mandate can't succeed as-is; send a one-time payment link
 *   escalate       – don't collect on this call; hand off to a human
 */
export type FailureAction = "retry" | "retry_later" | "payment_link" | "escalate";
export type MandateType = "UPI Autopay" | "eNACH" | "Card e-Mandate";

export interface FailureCode {
  code: string;
  applies_to: MandateType[];
  action: FailureAction;
  /** One-line explanation the agent can say to the customer. */
  explain_en: string;
  explain_hi: string;
  /** What the customer can do to fix it, if anything. */
  customer_fix: string;
}

const ALL: MandateType[] = ["UPI Autopay", "eNACH", "Card e-Mandate"];
const BANK: MandateType[] = ["UPI Autopay", "eNACH"];
const UPI: MandateType[] = ["UPI Autopay"];
const NACH: MandateType[] = ["eNACH"];
const CARD: MandateType[] = ["Card e-Mandate"];

export const FAILURE_CODES: FailureCode[] = [
  // ── Funds & limits ────────────────────────────────────────────────
  { code: "INSUFFICIENT_FUNDS", applies_to: ALL, action: "retry",
    explain_en: "there wasn't enough balance in the linked account on the debit date",
    explain_hi: "debit ki tareekh par linked account mein balance kam tha",
    customer_fix: "Add funds, then allow a retry." },
  { code: "DAILY_LIMIT_EXCEEDED", applies_to: BANK, action: "retry_later",
    explain_en: "your bank's daily transaction limit was already used up that day",
    explain_hi: "us din aapke bank ki daily transaction limit poori ho chuki thi",
    customer_fix: "Retry the next day, or pay now with a payment link." },
  { code: "CARD_LIMIT_EXCEEDED", applies_to: CARD, action: "retry_later",
    explain_en: "the card's credit limit was reached",
    explain_hi: "card ki credit limit poori ho gayi thi",
    customer_fix: "Retry after the limit frees up, or pay with another method via link." },
  { code: "AMOUNT_EXCEEDS_LIMIT", applies_to: ALL, action: "payment_link",
    explain_en: "the amount was higher than the maximum allowed on your autopay mandate",
    explain_hi: "amount aapke autopay mandate ki maximum limit se zyada tha",
    customer_fix: "Pay this one via link; re-register the mandate with a higher limit." },

  // ── Mandate state ─────────────────────────────────────────────────
  { code: "MANDATE_REVOKED", applies_to: ALL, action: "payment_link",
    explain_en: "the autopay mandate was cancelled",
    explain_hi: "autopay mandate cancel ho chuka hai",
    customer_fix: "Pay via link and set up autopay again if they want to continue." },
  { code: "MANDATE_PAUSED", applies_to: UPI, action: "payment_link",
    explain_en: "the autopay was paused in your UPI app",
    explain_hi: "aapke UPI app mein autopay pause kiya hua hai",
    customer_fix: "Resume the mandate in the UPI app, or pay via link." },
  { code: "MANDATE_EXPIRED", applies_to: ALL, action: "payment_link",
    explain_en: "the autopay mandate has expired",
    explain_hi: "autopay mandate ki validity khatam ho gayi hai",
    customer_fix: "Pay via link and register a new mandate." },
  { code: "MANDATE_NOT_ACTIVE", applies_to: NACH, action: "payment_link",
    explain_en: "the bank hasn't activated the eNACH mandate yet",
    explain_hi: "bank ne abhi tak eNACH mandate activate nahi kiya hai",
    customer_fix: "Pay via link; mandate registration will be rechecked." },
  { code: "PAYMENT_STOPPED_BY_CUSTOMER", applies_to: NACH, action: "escalate",
    explain_en: "a stop-payment instruction was placed on this debit with your bank",
    explain_hi: "aapne bank mein is debit par stop-payment lagaya tha",
    customer_fix: "Customer deliberately stopped it – a human should understand why." },

  // ── Pre-debit / authentication ────────────────────────────────────
  { code: "AFA_NOT_COMPLETED", applies_to: CARD, action: "retry",
    explain_en: "the pre-debit authentication on your card wasn't completed",
    explain_hi: "card ka pre-debit authentication complete nahi hua tha",
    customer_fix: "Approve the pre-debit notification when the retry comes." },
  { code: "PRE_DEBIT_NOTIFICATION_FAILED", applies_to: UPI, action: "retry",
    explain_en: "the advance debit notification couldn't be delivered, so the bank skipped the debit",
    explain_hi: "pre-debit notification deliver nahi hua, isliye bank ne debit nahi kiya",
    customer_fix: "Allow a retry; a fresh notification will be sent." },

  // ── Account problems ──────────────────────────────────────────────
  { code: "ACCOUNT_FROZEN", applies_to: BANK, action: "payment_link",
    explain_en: "the linked bank account is frozen or inactive",
    explain_hi: "linked bank account freeze ya inactive hai",
    customer_fix: "Pay from another account via link; contact the bank." },
  { code: "ACCOUNT_CLOSED", applies_to: BANK, action: "payment_link",
    explain_en: "the linked bank account has been closed",
    explain_hi: "linked bank account band ho chuka hai",
    customer_fix: "Pay via link and set up autopay on a new account." },
  { code: "ACCOUNT_DORMANT", applies_to: BANK, action: "payment_link",
    explain_en: "the linked bank account is dormant",
    explain_hi: "linked bank account dormant hai",
    customer_fix: "Reactivate with the bank, or pay via link." },
  { code: "ACCOUNT_DETAILS_MISMATCH", applies_to: NACH, action: "payment_link",
    explain_en: "the account details on the mandate don't match the bank's records",
    explain_hi: "mandate par account details bank ke record se match nahi karte",
    customer_fix: "Pay via link; re-register the mandate with correct details." },
  { code: "INVALID_VPA", applies_to: UPI, action: "payment_link",
    explain_en: "the UPI ID linked to the autopay is no longer valid",
    explain_hi: "autopay se juda UPI ID ab valid nahi hai",
    customer_fix: "Pay via link and set up autopay with the current UPI ID." },

  // ── Card problems ─────────────────────────────────────────────────
  { code: "CARD_EXPIRED", applies_to: CARD, action: "payment_link",
    explain_en: "the card linked to the autopay has expired",
    explain_hi: "autopay se juda card expire ho gaya hai",
    customer_fix: "Pay via link and add the new card to autopay." },
  { code: "CARD_BLOCKED", applies_to: CARD, action: "payment_link",
    explain_en: "the card is blocked by the issuing bank",
    explain_hi: "card bank dwara block kiya gaya hai",
    customer_fix: "Pay with another method via link." },
  { code: "CARD_REPORTED_LOST_OR_STOLEN", applies_to: CARD, action: "escalate",
    explain_en: "the card was reported lost or stolen",
    explain_hi: "card lost ya stolen report hua hai",
    customer_fix: "Possible fraud signal – hand to a human; do not collect on this call." },
  { code: "ISSUER_DECLINED", applies_to: CARD, action: "retry",
    explain_en: "the card issuer declined the charge without a specific reason",
    explain_hi: "card issuer bank ne charge decline kar diya",
    customer_fix: "Allow one retry; if it fails again, use a link." },
  { code: "INTERNATIONAL_NOT_ENABLED", applies_to: CARD, action: "payment_link",
    explain_en: "the card isn't enabled for this type of transaction",
    explain_hi: "card par is tarah ka transaction enable nahi hai",
    customer_fix: "Enable it in the bank app, or pay via link." },

  // ── Technical ─────────────────────────────────────────────────────
  { code: "BANK_TECHNICAL_ERROR", applies_to: ALL, action: "retry",
    explain_en: "there was a temporary technical problem at your bank",
    explain_hi: "aapke bank mein temporary technical problem thi",
    customer_fix: "Nothing – a retry usually succeeds." },
  { code: "BANK_TIMEOUT", applies_to: ALL, action: "retry",
    explain_en: "your bank didn't respond in time",
    explain_hi: "bank ne time par response nahi diya",
    customer_fix: "Nothing – a retry usually succeeds." },
  { code: "UPI_APP_ERROR", applies_to: UPI, action: "retry",
    explain_en: "there was a temporary error with the UPI app or network",
    explain_hi: "UPI app ya network mein temporary error tha",
    customer_fix: "Nothing – a retry usually succeeds." },
  { code: "GATEWAY_ERROR", applies_to: ALL, action: "retry",
    explain_en: "there was a temporary processing error",
    explain_hi: "processing mein temporary error tha",
    customer_fix: "Nothing – a retry usually succeeds." },

  // ── Risk ──────────────────────────────────────────────────────────
  { code: "RISK_DECLINED", applies_to: ALL, action: "escalate",
    explain_en: "the payment was held back by a security check",
    explain_hi: "payment security check ki wajah se roka gaya",
    customer_fix: "Do not retry or send a link; a human must review." },
  { code: "UNKNOWN_ERROR", applies_to: ALL, action: "escalate",
    explain_en: "the payment failed for a reason we couldn't confirm",
    explain_hi: "payment fail hua, lekin wajah confirm nahi ho payi",
    customer_fix: "Don't guess – hand to a human." },
];

const BY_CODE = new Map(FAILURE_CODES.map((f) => [f.code, f]));

/** Look up a code; anything unrecognised is treated as UNKNOWN_ERROR (escalate, never guess). */
export function failureInfo(code: string): FailureCode {
  return BY_CODE.get(code) ?? BY_CODE.get("UNKNOWN_ERROR")!;
}

/**
 * Best-effort mapping from a Razorpay `payment.failed` error payload to a catalogue code.
 * Matches on `error.reason` first, then keywords in `error.description`.
 */
export function fromRazorpayError(err: { code?: string; reason?: string; description?: string } | undefined): string {
  const reason = (err?.reason ?? "").toLowerCase();
  const text = `${reason} ${(err?.description ?? "").toLowerCase()}`;
  const rules: Array<[RegExp, string]> = [
    [/insufficient|balance/, "INSUFFICIENT_FUNDS"],
    [/daily.*limit|limit.*(per day|daily)/, "DAILY_LIMIT_EXCEEDED"],
    [/credit limit|card.*limit/, "CARD_LIMIT_EXCEEDED"],
    [/(mandate|max(imum)?).*amount|amount.*(mandate|max)/, "AMOUNT_EXCEEDS_LIMIT"],
    [/revoked|cancell?ed/, "MANDATE_REVOKED"],
    [/paused/, "MANDATE_PAUSED"],
    [/mandate.*expired|expired.*mandate/, "MANDATE_EXPIRED"],
    [/not (yet )?(active|registered)|registration pending/, "MANDATE_NOT_ACTIVE"],
    [/stop(ped)? payment|payment stopped/, "PAYMENT_STOPPED_BY_CUSTOMER"],
    [/authenticat|afa/, "AFA_NOT_COMPLETED"],
    [/pre.?debit|notification/, "PRE_DEBIT_NOTIFICATION_FAILED"],
    [/frozen|inactive|blocked account|debit freeze/, "ACCOUNT_FROZEN"],
    [/account.*closed|closed account/, "ACCOUNT_CLOSED"],
    [/dormant/, "ACCOUNT_DORMANT"],
    [/mismatch|does not exist|invalid account/, "ACCOUNT_DETAILS_MISMATCH"],
    [/invalid (vpa|upi)|vpa/, "INVALID_VPA"],
    [/card.*expired|expired.*card/, "CARD_EXPIRED"],
    [/lost|stolen/, "CARD_REPORTED_LOST_OR_STOLEN"],
    [/card.*blocked|blocked.*card/, "CARD_BLOCKED"],
    [/international|not enabled/, "INTERNATIONAL_NOT_ENABLED"],
    [/issuer|declined/, "ISSUER_DECLINED"],
    [/timeout|timed out/, "BANK_TIMEOUT"],
    [/upi app|psp/, "UPI_APP_ERROR"],
    [/bank.*(technical|down|unavailable)|technical/, "BANK_TECHNICAL_ERROR"],
    [/fraud|risk|suspicious/, "RISK_DECLINED"],
    [/gateway|server error/, "GATEWAY_ERROR"],
  ];
  for (const [re, code] of rules) if (re.test(text)) return code;
  return "UNKNOWN_ERROR";
}
