/**
 * Task 4.3 — Twilio statusCallback webhook.
 *
 * Twilio posts application/x-www-form-urlencoded to this endpoint whenever
 * an outbound WhatsApp message changes status (queued → sent → delivered →
 * read → failed). We:
 *
 *   1. Verify X-Twilio-Signature with TWILIO_AUTH_TOKEN
 *   2. Append a row to delivery_events with the full payload
 *   3. Update lead_cases.state if the message was our delivery_sid:
 *        delivered  → state stays 'delivered' (timeline filled via events)
 *        failed / undelivered → state='failed'
 *
 * Idempotent: multiple updates for the same SID just stack as event rows.
 */
import { NextResponse } from "next/server";
import twilio from "twilio";
import { supabaseServer } from "@/lib/supabase";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function expectedUrl(req: Request): string {
  const explicit = process.env.TWILIO_STATUS_CALLBACK_URL;
  if (explicit) return explicit;
  const base =
    process.env.PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined);
  if (base) return `${base.replace(/\/$/, "")}/api/twilio/status`;
  // Last resort: trust request URL (dev / ngrok).
  return req.url;
}

function paramsFromForm(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) out[k] = typeof v === "string" ? v : "";
  return out;
}

export async function POST(req: Request) {
  const component = "twilio_status";
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  // only honored outside production — webhook signature verification is mandatory in prod
  const skipValidation =
    process.env.TWILIO_SKIP_VALIDATION === "true" &&
    process.env.NODE_ENV !== "production";

  let form: FormData;
  try {
    form = await req.formData();
  } catch (e) {
    return NextResponse.json({ error: `bad form: ${String(e).slice(0, 180)}` }, { status: 400 });
  }
  const params = paramsFromForm(form);

  if (!skipValidation) {
    const signature = req.headers.get("x-twilio-signature") ?? "";
    if (!authToken) {
      await log({
        task_id: "4.3-status",
        component,
        level: "ERROR",
        event: "status_no_auth_token",
      });
      return NextResponse.json({ error: "server missing TWILIO_AUTH_TOKEN" }, { status: 500 });
    }
    const ok = twilio.validateRequest(authToken, signature, expectedUrl(req), params);
    if (!ok) {
      await log({
        task_id: "4.3-status",
        component,
        level: "WARN",
        event: "status_signature_invalid",
        payload: { sid: params.MessageSid, status: params.MessageStatus },
      });
      return NextResponse.json({ error: "signature mismatch" }, { status: 403 });
    }
  }

  const sid = params.MessageSid ?? params.SmsSid ?? null;
  const status = params.MessageStatus ?? params.SmsStatus ?? "unknown";
  const errorCode = params.ErrorCode || null;
  const errorMessage = params.ErrorMessage || null;
  const to = params.To ?? null;
  const from = params.From ?? null;

  const supabase = supabaseServer();

  // Find the case this SID belongs to (delivery_sid on lead_cases).
  let caseId: string | null = null;
  if (sid) {
    const { data: maybe } = await supabase
      .from("lead_cases")
      .select("id")
      .eq("delivery_sid", sid)
      .maybeSingle();
    caseId = (maybe?.id as string) ?? null;
  }

  // 1. Always log the event.
  try {
    await supabase.from("delivery_events").insert({
      case_id: caseId,
      channel: "whatsapp",
      direction: "outbound",
      to_addr: to,
      from_addr: from,
      twilio_sid: sid,
      status,
      error_code: errorCode,
      error_message: errorMessage,
      payload: params as Record<string, string>,
    });
  } catch (e) {
    await log({
      case_id: caseId ?? undefined,
      task_id: "4.3-status",
      component,
      level: "WARN",
      event: "status_event_persist_failed",
      error_message: String(e).slice(0, 500),
    });
  }

  // 2. Flip case state on terminal status.
  if (caseId && (status === "failed" || status === "undelivered")) {
    await supabase.from("lead_cases").update({ state: "failed" }).eq("id", caseId);
    await log({
      case_id: caseId,
      task_id: "4.3-status",
      component,
      level: "WARN",
      event: "case_state_failed_from_twilio",
      payload: { sid, status, errorCode, errorMessage },
    });
  } else if (caseId && status === "delivered") {
    await log({
      case_id: caseId,
      task_id: "4.3-status",
      component,
      event: "whatsapp_delivered",
      payload: { sid, status },
    });
  } else {
    await log({
      case_id: caseId ?? undefined,
      task_id: "4.3-status",
      component,
      event: "whatsapp_status_event",
      payload: { sid, status, to, from, errorCode, errorMessage },
    });
  }

  // Twilio expects 2xx with no body required.
  return new NextResponse(null, { status: 204 });
}
