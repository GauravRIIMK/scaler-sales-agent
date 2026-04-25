/**
 * POST /api/leads
 *
 * Stage-A entry point for the two-stage flow per the assignment.
 *
 *   Lead created → assigned to BDA → call scheduled at T → at T-1h, the
 *   pre-call nudge auto-fires to the BDA's WhatsApp using ONLY the CRM
 *   profile data (no transcript exists yet).
 *
 * This route lands the lead row in state='nudge_scheduled'. The cron at
 * /api/cron/fire-nudges picks it up when now() >= scheduled_call_at - LEAD,
 * generates the profile-only nudge, sends WhatsApp to the BDA, and
 * transitions to state='nudge_sent'.
 *
 * Inputs (JSON):
 *   profile            (required) Lead CRM data — same shape as legacy
 *                      /api/cases/new but without transcript/audio.
 *   bda_whatsapp       (required) E.164 WhatsApp number for the BDA who
 *                      will receive the nudge. Demo evaluator's number.
 *   evaluator_phone    (optional) Lead's WhatsApp number — used later when
 *                      the post-call PDF is delivered. Optional here because
 *                      the lead's number is sometimes added after the call.
 *   scheduled_call_at  (required) ISO 8601 timestamp. Cron will fire the
 *                      nudge LEAD minutes before this. Send a past
 *                      timestamp to make the row immediately due.
 *   bda_name           (optional)
 *   language           (optional) en-IN | en-US | hi
 *
 * Returns:
 *   { lead_id, state: 'nudge_scheduled', scheduled_call_at, fires_at }
 *   where fires_at = scheduled_call_at - NUDGE_LEAD_MINUTES.
 *
 * NOTE: Legacy /api/cases/new still works for the single-shot post-call
 * pipeline (transcript supplied at creation time). New deployments should
 * prefer this two-stage flow.
 */
import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface NewLeadBody {
  profile?: Record<string, unknown>;
  bda_whatsapp?: string;
  evaluator_phone?: string;
  scheduled_call_at?: string;
  bda_name?: string;
  language?: string;
}

const DEFAULT_LEAD_MINUTES = 60;

function leadMinutes(): number {
  const raw = process.env.NUDGE_LEAD_MINUTES;
  const n = raw ? Number(raw) : DEFAULT_LEAD_MINUTES;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LEAD_MINUTES;
}

function badRequest(msg: string) {
  return NextResponse.json({ error: msg }, { status: 400 });
}

function suspectPhone(value: string | undefined): boolean {
  return typeof value === "string" && value.length > 0 && !value.startsWith("+");
}

export async function POST(req: Request) {
  const started = Date.now();
  const component = "leads_create";

  let body: NewLeadBody;
  try {
    body = (await req.json()) as NewLeadBody;
  } catch (e) {
    return badRequest(`invalid JSON: ${String(e).slice(0, 180)}`);
  }

  const { profile, bda_whatsapp, evaluator_phone, scheduled_call_at, bda_name, language } = body;

  if (!profile || typeof profile !== "object") {
    return badRequest("profile (object) is required");
  }
  if (!bda_whatsapp || typeof bda_whatsapp !== "string") {
    return badRequest("bda_whatsapp (E.164 string) is required — that's where the pre-call nudge goes");
  }
  if (!scheduled_call_at || typeof scheduled_call_at !== "string") {
    return badRequest(
      "scheduled_call_at (ISO 8601 string) is required — when the BDA will dial the lead"
    );
  }
  const callAt = new Date(scheduled_call_at);
  if (Number.isNaN(callAt.getTime())) {
    return badRequest(`scheduled_call_at is not a valid ISO 8601 timestamp: ${scheduled_call_at}`);
  }

  if (language && !["en-IN", "en-US", "hi"].includes(language)) {
    return badRequest(`language must be one of en-IN | en-US | hi (got: ${language})`);
  }

  const lead = leadMinutes();
  const firesAt = new Date(callAt.getTime() - lead * 60 * 1000);

  const suspectPhones: string[] = [];
  if (suspectPhone(bda_whatsapp)) suspectPhones.push("bda_whatsapp");
  if (suspectPhone(evaluator_phone)) suspectPhones.push("evaluator_phone");

  const supabase = supabaseServer();
  const { data: created, error: insertErr } = await supabase
    .from("lead_cases")
    .insert({
      lead_profile: profile,
      bda_whatsapp,
      evaluator_phone: evaluator_phone ?? null,
      bda_name: bda_name ?? null,
      language: language ?? null,
      scheduled_call_at: callAt.toISOString(),
      state: "nudge_scheduled",
      received_at: new Date().toISOString(),
    })
    .select("id, scheduled_call_at, state")
    .single();

  if (insertErr || !created) {
    await log({
      task_id: "leads.create",
      component,
      level: "ERROR",
      event: "lead_create_failed",
      error_message: insertErr?.message ?? "no row",
    });
    return NextResponse.json(
      { error: `create failed: ${insertErr?.message ?? "unknown"}` },
      { status: 500 }
    );
  }

  await log({
    case_id: created.id as string,
    task_id: "leads.create",
    component,
    event: "lead_scheduled",
    latency_ms: Date.now() - started,
    payload: {
      scheduled_call_at: created.scheduled_call_at,
      fires_at: firesAt.toISOString(),
      lead_minutes: lead,
      suspect_phone_formats: suspectPhones.length > 0 ? suspectPhones : undefined,
      has_evaluator_phone: !!evaluator_phone,
      language: language ?? null,
    },
  });

  return NextResponse.json({
    lead_id: created.id,
    state: created.state,
    scheduled_call_at: created.scheduled_call_at,
    fires_at: firesAt.toISOString(),
    lead_minutes: lead,
    fire_now_url: `/api/leads/${created.id}/fire-nudge-now`,
    post_call_url: `/api/cases/${created.id}/post-call`,
  });
}
