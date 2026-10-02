# What to paste into the Razorpay form

Copy each block into the matching field. Fill in the `<…>` placeholders before submitting.

---

## Project title

Razorpay Autopay Recovery Agent: a Sarvam voice agent that recovers failed autopay payments

## GitHub link

https://github.com/claude-code-india/emi-reminder-agent

## Summary (≤120 words)

A multilingual Sarvam voice agent that calls customers whose autopay (UPI Autopay, eNACH, card e-mandate) payment failed, explains why in their language, and picks the right recovery path: a mandate retry with explicit consent, a one-time payment link, a scheduled callback, or a human handoff. Tools are served by a TypeScript mock Customer/Payment API holding 10 fictional customers that cover every major failure type. Safety rules are enforced server-side as well as in the prompt: no debit without consent, no re-debiting a recovered payment, disputes escalated, retries capped at 3, and OTP/PIN/CVV rejected and never stored. Every action is audit-logged, and an automated evaluation suite checks each scenario.

## What I built

- A Sarvam voice agent (system prompt + tool definitions) that understands the failure, explains it, offers recovery, retries, schedules callbacks or escalates to a human
- A mock Customer/Payment API in TypeScript (Node, no framework) exposing the agent's tool endpoints plus an audit log
- A 27-code failure catalogue across UPI Autopay, eNACH and card e-mandates. Each code maps to one action (retry, retry later, payment link or escalate) plus a short English/Hindi explanation the agent uses on the call
- Razorpay webhook ingestion (`POST /webhooks/razorpay`, HMAC-SHA256 signature check): `payment.failed` marks a payment failed with a mapped failure code, `payment.captured` marks it recovered
- A batch dialer (`npm run dial`, with `--dry-run`) that triggers Sarvam outbound calls for every customer still needing recovery, only between 8 AM and 7 PM IST
- Docker setup (`docker compose up`) and GitHub Actions CI (typecheck + tests on every push)
- 10 fictional customers in 6 languages covering insufficient funds, expired card, bank error, already recovered, dispute, revoked mandate, max attempts, pending authentication and frozen account
- Server-side guardrails: consent check, duplicate/recovered/disputed/max-attempt blocks, retry-later and escalate-only blocks (`RETRY_LATER`, `ESCALATION_REQUIRED`), sensitive-data rejection, masked phone numbers, optional API-key auth
- A scripted demo (`npm run demo`) that prints every tool call for CUS_001
- An evaluation suite (`npm run eval` / `npm test`) that regenerates `evaluation/results.md`

## Tech stack

Sarvam AI voice agent · TypeScript · Node.js 18+ · tsx · ngrok (to expose tools) · JSON fixture data · Docker · GitHub Actions

## How to test (3 commands)

```bash
npm install
npm run dev          # terminal 1: starts the API on :3000
npm test             # terminal 2: runs all scenarios, exits non-zero on failure
```

(`npm run demo` prints the full CUS_001 recovery flow with every tool call.)

## Demo

```
Demo customer: CUS_001 (Aarav Sharma, fictional)
Amount: ₹1,499
Failure reason: Insufficient funds
Outcome: Payment recovery initiated
```

- Demo video: `<Google Drive/YouTube unlisted link>`
- Sarvam agent: `<Sarvam agent link>`
- Transcript + tool calls: https://github.com/claude-code-india/emi-reminder-agent/blob/main/demo/demo-transcript.md

## Key design decisions and guardrails

- **Defence in depth.** Every safety rule is in the prompt and is also enforced by the API, so a model mistake cannot cause an unsafe debit.
- **Consent before debit.** Retry requires `customer_consent: true`, otherwise `CONSENT_REQUIRED`.
- **Failure-aware routing.** Each of 27 failure codes has one action. Retryable codes (insufficient funds, bank errors, pending authentication) get a retry. Limit codes get a callback or link instead of an immediate retry. Broken-mandate codes (expired card, revoked mandate, frozen account, amount over limit) get a payment link. Risk declines, lost/stolen cards, stop-payments and unknown errors go only to a human, with no retry and no link.
- **No double charging.** Already-recovered and in-flight retries are blocked. Retries stop at 3 attempts.
- **Humans for hard cases.** Disputes, fraud, hardship and explicit requests go to a human ticket with a priority and SLA.
- **No credentials on calls.** OTP/PIN/CVV/card number/password are never requested. Any request containing them is rejected and nothing is logged.
- **Privacy and auditability.** Phone numbers are masked, an optional `x-api-key` protects the tools, and every action is written to an audit log.

## Evaluation summary

25 automated checks via `npm test`, all passing: payment failed, agrees to retry, retry without consent, refuses, asks for a human, OTP / UPI PIN / card number rejected and never logged, already recovered, dispute, non-retryable → link, max attempts, double retry, busy → callback, unknown customer, outcome logging, 27-code failure catalogue, unknown-code → escalate, Razorpay error mapping, retry-later and escalate-only codes, signed / bad-signature / duplicate Razorpay webhooks, payment.captured → no re-debit, and dialer planning. Conversational behaviour from live Sarvam test calls is recorded separately in `evaluation/results.md`.

## What I'd do next

- Replace the mock with the Razorpay Subscriptions / Payments and Payment Links APIs
- Test the webhook and outbound dialer against live Razorpay and Sarvam accounts
- Add DND/NCPR checks, call-recording consent and contact caps
- Persist state in a database and add recovery-rate / handoff-rate dashboards

---

## Pre-submission checklist

- [ ] Screenshots added to `demo/demo-screenshots/` (01–07, see its README)
- [ ] Video link filled in `demo/demo-video-link.md` and in the Demo field above
- [ ] Sarvam agent link filled in above
- [ ] No API key committed: `git grep -n "SARVAM_API_KEY=."` returns nothing and `.env` is not tracked
- [ ] Repo is public and the GitHub link opens in an incognito window
- [ ] `evaluation/results.md` updated after the live Sarvam test calls
