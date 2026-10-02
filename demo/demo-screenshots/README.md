# Demo screenshots

Add PNGs to this folder using these exact filenames, so the links below and in the README work.

| File | What to capture |
|---|---|
| `01-sarvam-agent-config.png` | Sarvam agent settings: name, voice, languages |
| `02-system-prompt.png` | System prompt pasted from `agent/system-prompt.md` |
| `03-tools-config.png` | Tools registered from `agent/tools.md` (ngrok base URL + `x-api-key` header visible, secret value hidden) |
| `04-test-call.png` | Live test call in progress with CUS_001 |
| `05-transcript.png` | Call transcript showing the failure explained and consent given |
| `06-api-tool-log.png` | Backend terminal or `GET /api/outcomes` showing the tool calls (`get payment` → `retry` → `outcome`) |
| `07-outcome.png` | Final outcome: `payment_recovery_initiated` |

Before saving, blur or crop any API keys, ngrok auth tokens or real phone numbers.

## Referencing them

From the repo root (e.g. `README.md`):

```markdown
![Sarvam agent config](demo/demo-screenshots/01-sarvam-agent-config.png)
```

From inside `demo/` (e.g. `demo/demo-transcript.md`):

```markdown
![Test call](demo-screenshots/04-test-call.png)
```

## Preview

![01 Sarvam agent config](01-sarvam-agent-config.png)
![02 System prompt](02-system-prompt.png)
![03 Tools config](03-tools-config.png)
![04 Test call](04-test-call.png)
![05 Transcript](05-transcript.png)
![06 API tool log](06-api-tool-log.png)
![07 Outcome](07-outcome.png)
