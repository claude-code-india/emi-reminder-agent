# Demo video

| Field | Value |
|---|---|
| Video URL | `<paste link here>` |
| Hosting | Unlisted YouTube, or Google Drive with sharing set to "Anyone with the link" (Viewer) |
| Duration | `<mm:ss>` |
| Recorded on | `<YYYY-MM-DD>` |
| Customer | CUS_001 (Aarav Sharma, fictional), ₹1,499, insufficient funds |
| Outcome | Payment recovery initiated |

> Check the link in an incognito window before submitting. A Drive link that asks for access means the sharing setting is wrong.

## What's shown

| Timestamp | Section |
|---|---|
| `00:00` | Intro: problem and architecture (`architecture.png`) |
| `00:00` | Local API running (`npm run dev`) and exposed via ngrok |
| `00:00` | Sarvam agent config: system prompt and registered tools |
| `00:00` | Live test call with CUS_001: failure explained, consent taken, retry initiated |
| `00:00` | Tool-call log / `GET /api/outcomes` showing the retry and logged outcome |
| `00:00` | Guardrail example (e.g. OTP request refused, or CUS_005 dispute escalated) |
| `00:00` | `npm test` passing and wrap-up |
