/**
 * Task 4.1 — Twilio WhatsApp send wrapper.
 *
 * Two send primitives:
 *   sendWhatsAppText(to, body, opts)        — plain text message
 *   sendWhatsAppWithMedia(to, body, media)  — text + media (PDF URL)
 *
 * Both:
 *   - require TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM
 *   - set statusCallback to the app's public URL if configured (Task 4.3)
 *   - log the outbound attempt to delivery_events
 *   - return { sid, status, to, from }
 *
 * Callers (lead PDF delivery route + BDA nudge send route) own state
 * transitions on lead_cases. This module is pure messaging + logging.
 */
import twilio from "twilio";
import { log } from "./log";
import { isSupabaseConfigured, supabaseServer } from "./supabase";
import { withRetry } from "./fallback";

let _client: twilio.Twilio | null = null;

export function twilioClient(): twilio.Twilio {
  if (_client) return _client;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error("Twilio credentials missing (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)");
  _client = twilio(sid, token);
  return _client;
}

/** Returns the configured WhatsApp sender address (e.g. 'whatsapp:+14155238886'). */
export function whatsappFrom(): string {
  const from = process.env.TWILIO_WHATSAPP_FROM;
  if (!from) throw new Error("TWILIO_WHATSAPP_FROM missing — set it in .env.local");
  return from.startsWith("whatsapp:") ? from : `whatsapp:${from}`;
}

export function toWhatsappAddr(phone: string): string {
  if (phone.startsWith("whatsapp:")) return phone;
  const cleaned = phone.startsWith("+") ? phone : `+${phone}`;
  return `whatsapp:${cleaned}`;
}

export function isTwilioConfigured(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_WHATSAPP_FROM
  );
}

export interface SendOpts {
  caseId?: string;
  component?: string;
  /** Override statusCallback URL. Default = env PUBLIC_BASE_URL + /api/twilio/status. */
  statusCallback?: string;
}

export interface SendResult {
  sid: string;
  status: string;
  to: string;
  from: string;
  num_media?: number;
}

function defaultStatusCallback(): string | undefined {
  const explicit = process.env.TWILIO_STATUS_CALLBACK_URL;
  if (explicit) return explicit;
  const base =
    process.env.PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined);
  if (!base) return undefined;
  const withProtocol = base.startsWith("http") ? base : `https://${base}`;
  return `${withProtocol.replace(/\/$/, "")}/api/twilio/status`;
}

async function recordDelivery(params: {
  caseId?: string;
  to: string;
  from: string;
  sid: string;
  status: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  hasMedia: boolean;
}) {
  if (!isSupabaseConfigured()) return;
  try {
    const sb = supabaseServer();
    await sb.from("delivery_events").insert({
      case_id: params.caseId ?? null,
      channel: "whatsapp",
      direction: "outbound",
      to_addr: params.to,
      from_addr: params.from,
      twilio_sid: params.sid,
      status: params.status,
      error_code: params.errorCode ?? null,
      error_message: params.errorMessage ?? null,
      payload: { has_media: params.hasMedia },
    });
  } catch (e) {
    console.warn("[twilio] delivery_events insert failed (non-fatal):", String(e).slice(0, 200));
  }
}

interface SendArgs {
  to: string;
  body: string;
  mediaUrl?: string;
  opts?: SendOpts;
}

async function send({ to, body, mediaUrl, opts = {} }: SendArgs): Promise<SendResult> {
  const component = opts.component ?? "twilio_send";
  const started = Date.now();
  const toAddr = toWhatsappAddr(to);
  const fromAddr = whatsappFrom();
  const statusCallback = opts.statusCallback ?? defaultStatusCallback();

  await log({
    case_id: opts.caseId,
    task_id: "4.1-send",
    component,
    provider: "twilio",
    event: "whatsapp_send_start",
    payload: {
      to: toAddr,
      from: fromAddr,
      has_media: !!mediaUrl,
      status_callback_set: !!statusCallback,
      body_chars: body.length,
    },
  });

  const client = twilioClient();
  const payload: Parameters<typeof client.messages.create>[0] = {
    from: fromAddr,
    to: toAddr,
    body,
  };
  if (mediaUrl) payload.mediaUrl = [mediaUrl];
  if (statusCallback) payload.statusCallback = statusCallback;

  let msg;
  try {
    // Fix 2: wrap with withRetry so transient 5xx/timeout errors from Twilio
    // are retried up to 3 times with exponential back-off before propagating.
    msg = await withRetry(
      () => client.messages.create(payload),
      {
        ctx: { caseId: opts.caseId, taskId: "4.1-send", component },
        providerName: "twilio",
        attempts: 3,
      }
    );
  } catch (e) {
    const err = e as { code?: string | number; message?: string };
    const errCode = err.code != null ? String(err.code) : undefined;

    // Fix 3: surface actionable messages for known Twilio sandbox error codes.
    if (errCode === "63016") {
      // Log the original code so it remains queryable.
      await log({
        case_id: opts.caseId,
        task_id: "4.1-send",
        component,
        provider: "twilio",
        level: "ERROR",
        event: "whatsapp_sandbox_optin_missing",
        error_code: errCode,
        error_message: String(err.message ?? e).slice(0, 500),
      });
      const friendly = new Error(
        `Twilio sandbox refuses to send: recipient ${toAddr} has not sent "join <sandbox-code>" to ${fromAddr} in the last 24 h. Have them text the join word once, then retry.`
      );
      (friendly as unknown as { code: string }).code = errCode;
      await recordDelivery({
        caseId: opts.caseId,
        to: toAddr,
        from: fromAddr,
        sid: "",
        status: "failed_to_enqueue",
        errorCode: errCode,
        errorMessage: friendly.message.slice(0, 500),
        hasMedia: !!mediaUrl,
      });
      throw friendly;
    }

    if (errCode === "63007") {
      // Log original code for queryability.
      await log({
        case_id: opts.caseId,
        task_id: "4.1-send",
        component,
        provider: "twilio",
        level: "ERROR",
        event: "whatsapp_invalid_sender",
        error_code: errCode,
        error_message: String(err.message ?? e).slice(0, 500),
      });
      const friendly = new Error(
        "TWILIO_WHATSAPP_FROM is not a configured WhatsApp sender for this account. Check Twilio Console → WhatsApp senders."
      );
      (friendly as unknown as { code: string }).code = errCode;
      await recordDelivery({
        caseId: opts.caseId,
        to: toAddr,
        from: fromAddr,
        sid: "",
        status: "failed_to_enqueue",
        errorCode: errCode,
        errorMessage: friendly.message.slice(0, 500),
        hasMedia: !!mediaUrl,
      });
      throw friendly;
    }

    await log({
      case_id: opts.caseId,
      task_id: "4.1-send",
      component,
      provider: "twilio",
      level: "ERROR",
      event: "whatsapp_send_failed",
      error_code: errCode,
      error_message: String(err.message ?? e).slice(0, 500),
    });
    await recordDelivery({
      caseId: opts.caseId,
      to: toAddr,
      from: fromAddr,
      sid: "",
      status: "failed_to_enqueue",
      errorCode: errCode ?? null,
      errorMessage: String(err.message ?? e).slice(0, 500),
      hasMedia: !!mediaUrl,
    });
    throw e;
  }

  await log({
    case_id: opts.caseId,
    task_id: "4.1-send",
    component,
    provider: "twilio",
    event: "whatsapp_send_enqueued",
    latency_ms: Date.now() - started,
    payload: { sid: msg.sid, status: msg.status, to: toAddr, from: fromAddr, has_media: !!mediaUrl },
  });

  await recordDelivery({
    caseId: opts.caseId,
    to: toAddr,
    from: fromAddr,
    sid: msg.sid,
    status: msg.status,
    hasMedia: !!mediaUrl,
  });

  return {
    sid: msg.sid,
    status: msg.status,
    to: toAddr,
    from: fromAddr,
    num_media: mediaUrl ? 1 : 0,
  };
}

export async function sendWhatsAppText(
  to: string,
  body: string,
  opts: SendOpts = {}
): Promise<SendResult> {
  return send({ to, body, opts });
}

export async function sendWhatsAppWithMedia(
  to: string,
  body: string,
  mediaUrl: string,
  opts: SendOpts = {}
): Promise<SendResult> {
  return send({ to, body, mediaUrl, opts });
}
