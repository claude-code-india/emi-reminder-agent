import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { getCustomer, listCustomers, publicCustomer, resetCustomers, type Customer } from "./customers.ts";
import {
  ApiError, escalate, getAudit, logOutcome, paymentStatus, resetAudit, retryPayment,
  scheduleCallback, sendPaymentLink,
} from "./payments.ts";

// Minimal .env loader so `npm run dev` works without extra dependencies.
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

// Keys that must never reach this API. The agent is told never to collect them;
// this is the server-side backstop.
const SENSITIVE_TOKENS = new Set(["otp", "cvv", "cvc", "pin", "mpin", "upipin", "password", "passcode"]);
const SENSITIVE_JOINED = /(cardnumber|cardno|upipin|otp|cvv)/;

function isSensitiveKey(key: string): boolean {
  const tokens = key.toLowerCase().split(/[^a-z0-9]+|(?<=[a-z])(?=[0-9])/);
  return tokens.some((t) => SENSITIVE_TOKENS.has(t)) || SENSITIVE_JOINED.test(key.toLowerCase().replace(/[^a-z]/g, ""));
}

function findSensitiveKey(value: unknown): string | null {
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (isSensitiveKey(k)) return k;
      const nested = findSensitiveKey(v);
      if (nested) return nested;
    }
  }
  return null;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must be JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function customerOr404(id: string): Customer {
  const c = getCustomer(decodeURIComponent(id));
  if (!c) throw new ApiError(404, "CUSTOMER_NOT_FOUND", `No customer ${id}`);
  return c;
}

type Handler = (params: string[], body: Record<string, unknown>) => unknown;
const routes: Array<[string, RegExp, Handler]> = [
  ["GET", /^\/health$/, () => ({ ok: true })],
  ["GET", /^\/api\/customers$/, () => listCustomers().map(publicCustomer)],
  ["GET", /^\/api\/customers\/([^/]+)$/, ([id]) => publicCustomer(customerOr404(id))],
  ["GET", /^\/api\/customers\/([^/]+)\/payment$/, ([id]) => paymentStatus(customerOr404(id))],
  ["POST", /^\/api\/payments\/([^/]+)\/retry$/, ([id], b) => retryPayment(customerOr404(id), b)],
  ["POST", /^\/api\/payments\/([^/]+)\/payment-link$/, ([id], b) => sendPaymentLink(customerOr404(id), b)],
  ["POST", /^\/api\/callbacks$/, (_, b) => scheduleCallback(customerOr404(String(b.customer_id ?? "")), b)],
  ["POST", /^\/api\/escalations$/, (_, b) => escalate(customerOr404(String(b.customer_id ?? "")), b)],
  ["POST", /^\/api\/outcomes$/, (_, b) => logOutcome(customerOr404(String(b.customer_id ?? "")), b)],
  ["GET", /^\/api\/outcomes$/, () => getAudit()],
  ["POST", /^\/api\/reset$/, () => { resetCustomers(); resetAudit(); return { ok: true }; }],
];

export function createApp(): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const apiKey = process.env.TOOL_API_KEY;
      if (apiKey && url.pathname.startsWith("/api/") && req.headers["x-api-key"] !== apiKey) {
        throw new ApiError(401, "UNAUTHORIZED", "Missing or invalid x-api-key");
      }
      for (const [method, pattern, handler] of routes) {
        const m = url.pathname.match(pattern);
        if (!m || req.method !== method) continue;
        const body = method === "POST" ? await readBody(req) : {};
        const bad = findSensitiveKey(body);
        if (bad) {
          throw new ApiError(400, "SENSITIVE_DATA_REJECTED",
            `Field "${bad}" looks like an OTP/PIN/card credential. It was not stored. Never collect these on a call.`);
        }
        const result = handler(m.slice(1), body);
        console.log(`${method} ${url.pathname} -> 200`);
        return send(res, 200, result);
      }
      throw new ApiError(404, "NOT_FOUND", `${req.method} ${url.pathname} not found`);
    } catch (err) {
      const e = err instanceof ApiError ? err : new ApiError(500, "INTERNAL_ERROR", "Unexpected error");
      if (!(err instanceof ApiError)) console.error(err);
      console.log(`${req.method} ${url.pathname} -> ${e.status} ${e.code}`);
      send(res, e.status, { error: e.code, message: e.message });
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.PORT ?? 3000);
  createApp().listen(port, () => {
    console.log(`Autopay recovery API listening on http://localhost:${port}`);
    console.log(`Loaded ${listCustomers().length} fictional customers`);
  });
}
