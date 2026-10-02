/**
 * Sarvam outbound-call client (Instant Outbound API).
 *
 * Verified against https://docs.sarvam.ai/conversations/api/instant-outbound/create
 *   POST https://apps.sarvam.ai/api/outbounds/v1/orgs/{org_id}/workspaces/{workspace_id}/outbounds
 *   Header: X-API-Key: <SARVAM_API_KEY>      (Conversations API auth; the model APIs use
 *                                             `api-subscription-key`, the Conversations API does not)
 *   Body:   { app_config: { app_id, app_version, connection_config: { connection_id, agent_phone_number },
 *                           agent_variables?, app_overrides?: { initial_language_name?, ... } },
 *             user_config: { user_phone_number },
 *             webhook_config?: { url, metadata? } }
 *   200 →   { attempt_id }
 * One request = one dial attempt; Sarvam does not retry no_answer/busy. The call outcome
 * is POSTed to webhook_config.url when the call ends.
 *
 * `SARVAM_CALL_API_URL` overrides the full endpoint URL (e.g. for a mock/staging endpoint).
 *
 * Data minimisation: the agent only receives the variables its prompt needs. Payment
 * details are fetched live by the agent through the tool API, never pushed here.
 */
import type { Customer } from "./customers.ts";

const LANGUAGE_NAMES: Record<string, string> = {
  "hi-IN": "Hindi", "en-IN": "English", "ta-IN": "Tamil", "te-IN": "Telugu", "bn-IN": "Bengali",
  "mr-IN": "Marathi", "gu-IN": "Gujarati", "kn-IN": "Kannada", "ml-IN": "Malayalam", "pa-IN": "Punjabi",
  "od-IN": "Odia", "or-IN": "Odia", "as-IN": "Assamese",
};

export interface SarvamConfig {
  apiKey: string;
  url: string;
  appId: string;
  appVersion: number;
  connectionId: string;
  agentPhoneNumber: string;
  webhookUrl?: string;
}

export interface TriggerResult {
  customer_id: string;
  dry_run: boolean;
  ok: boolean;
  attempt_id?: string;
  error?: string;
  /** The request body that was (or would have been) sent, phone masked. */
  request: unknown;
}

const env = (k: string) => (process.env[k] ?? "").trim();

/** Resolve config from env. Returns the list of missing variables instead of throwing. */
export function sarvamConfig(): { config?: SarvamConfig; missing: string[] } {
  const appId = env("SARVAM_AGENT_ID") || env("SARVAM_APP_ID");
  const org = env("SARVAM_ORG_ID");
  const ws = env("SARVAM_WORKSPACE_ID");
  const override = env("SARVAM_CALL_API_URL");
  const missing: string[] = [];
  if (!env("SARVAM_API_KEY")) missing.push("SARVAM_API_KEY");
  if (!appId) missing.push("SARVAM_AGENT_ID");
  if (!env("SARVAM_CONNECTION_ID")) missing.push("SARVAM_CONNECTION_ID");
  if (!env("SARVAM_AGENT_PHONE_NUMBER")) missing.push("SARVAM_AGENT_PHONE_NUMBER");
  if (!override && !org) missing.push("SARVAM_ORG_ID");
  if (!override && !ws) missing.push("SARVAM_WORKSPACE_ID");
  if (missing.length) return { missing };
  return {
    missing,
    config: {
      apiKey: env("SARVAM_API_KEY"),
      url: override || `https://apps.sarvam.ai/api/outbounds/v1/orgs/${encodeURIComponent(org)}/workspaces/${encodeURIComponent(ws)}/outbounds`,
      appId,
      appVersion: Number(env("SARVAM_APP_VERSION") || 1),
      connectionId: env("SARVAM_CONNECTION_ID"),
      agentPhoneNumber: env("SARVAM_AGENT_PHONE_NUMBER"),
      webhookUrl: env("SARVAM_CALL_WEBHOOK_URL") || undefined,
    },
  };
}

export function currentTimeIst(now = new Date()): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short", hour12: true,
  }).format(now) + " IST";
}

/** Only what the system prompt needs. No amounts, failure codes or full phone numbers. */
export function agentVariables(c: Customer, now = new Date()) {
  return {
    customer_id: c.customer_id,
    customer_name: c.name,
    merchant_name: c.merchant,
    preferred_language: c.preferred_language,
    current_time_ist: currentTimeIst(now),
  };
}

export function buildCallRequest(c: Customer, cfg: Pick<SarvamConfig, "appId" | "appVersion" | "connectionId" | "agentPhoneNumber" | "webhookUrl">, now = new Date()) {
  const lang = LANGUAGE_NAMES[c.preferred_language];
  return {
    app_config: {
      app_id: cfg.appId,
      app_version: cfg.appVersion,
      connection_config: { connection_id: cfg.connectionId, agent_phone_number: cfg.agentPhoneNumber },
      agent_variables: agentVariables(c, now),
      ...(lang ? { app_overrides: { initial_language_name: lang } } : {}),
    },
    user_config: { user_phone_number: c.phone },
    ...(cfg.webhookUrl ? { webhook_config: { url: cfg.webhookUrl, metadata: { customer_id: c.customer_id } } } : {}),
  };
}

const maskForLog = (req: ReturnType<typeof buildCallRequest>) => ({
  ...req,
  user_config: { user_phone_number: req.user_config.user_phone_number.replace(/\d(?=\d{4})/g, "*") },
});

export async function triggerCall(customer: Customer, opts: { dryRun?: boolean } = {}): Promise<TriggerResult> {
  const { config, missing } = sarvamConfig();
  const dryRun = opts.dryRun ?? !config;
  const placeholder = {
    appId: config?.appId ?? (env("SARVAM_AGENT_ID") || "<SARVAM_AGENT_ID>"),
    appVersion: config?.appVersion ?? Number(env("SARVAM_APP_VERSION") || 1),
    connectionId: config?.connectionId ?? (env("SARVAM_CONNECTION_ID") || "<SARVAM_CONNECTION_ID>"),
    agentPhoneNumber: config?.agentPhoneNumber ?? (env("SARVAM_AGENT_PHONE_NUMBER") || "<SARVAM_AGENT_PHONE_NUMBER>"),
    webhookUrl: config?.webhookUrl ?? (env("SARVAM_CALL_WEBHOOK_URL") || undefined),
  };
  const body = buildCallRequest(customer, placeholder);
  const base = { customer_id: customer.customer_id, dry_run: dryRun, request: maskForLog(body) };
  if (dryRun) return { ...base, ok: true };
  if (!config) return { ...base, ok: false, error: `Missing env: ${missing.join(", ")}` };

  try {
    const res = await fetch(config.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": config.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
    if (!res.ok) return { ...base, ok: false, error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
    return { ...base, ok: true, attempt_id: json?.attempt_id };
  } catch (e) {
    return { ...base, ok: false, error: String((e as Error).message ?? e) };
  }
}
