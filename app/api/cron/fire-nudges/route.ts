/**
 * GET / POST /api/cron/fire-nudges
 *
 * The auto-trigger that satisfies the assignment's pre-call requirement:
 *   "Sent to the BDA on their own WhatsApp, ahead of the call".
 *
 * Tick semantics:
 *   - Find every row in state='nudge_scheduled' whose scheduled_call_at
 *     is within NUDGE_LEAD_MINUTES (default 60) of now() (or already past).
 *   - For each row: generate the profile-only nudge, send WhatsApp to the
 *     BDA, persist the markdown + plaintext + nudge_sent_at, transition
 *     state to 'nudge_sent', stamp nudge_fired_by='cron'.
 *
 * Failure handling per row is local — one bad lead doesn't kill the tick.
 * Errors are logged and the row stays in 'nudge_scheduled' so the next
 * tick retries.
 *
 * Recommended schedule: every 5 minutes via Vercel Cron / Supabase
 * scheduled function. Idempotent because the state guard ('nudge_scheduled')
 * prevents double-firing.
 *
 * Auth: if CRON_SECRET is set, the request must include header
 *   x-cron-secret: <CRON_SECRET>
 * — both Vercel Cron and an external scheduler can supply that header.
 * This stops random internet traffic from triggering sends.
 *
 * Demo: GET works without a body so the Loom can hit it from a browser.
 * Production should POST with the secret header.
 */
import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase";
import { log } from "@/lib/log";
import { fireOne, type FireResult } from "@/lib/fireNudge";
import type { PreCallProfile } from "@/lib/preCallNudge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEFAULT_LEAD_MINUTES = 60;
const DEFAULT_BATCH_SIZE = 25;

function leadMinutes(): number {
  const raw = process.env.NUDGE_LEAD_MINUTES;
  const n = raw ? Number(raw) : DEFAULT_LEAD_MINUTES;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LEAD_MINUTES;
}

function batchSize(): number {
  const raw = process.env.NUDGE_BATCH_SIZE;
  const n = raw ? Number(raw) : DEFAULT_BATCH_SIZE;
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 200) : DEFAULT_BATCH_SIZE;
}

function authError(req: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null; // no auth configured ⇒ open (dev mode)
  const provided = req.headers.get("x-cron-secret") ?? "";
  // Also accept Vercel's "Authorization: Bearer <CRON_SECRET>" convention.
  const auth = req.headers.get("authorization") ?? "";
  if (provided === secret) return null;
  if (auth === `Bearer ${secret}`) return null;
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

async function handle(req: Request): Promise<NextResponse> {
  const auth = authError(req);
  if (auth) return auth;

  const started = Date.now();
  const component = "cron_fire_nudges";
  const lead = leadMinutes();
  const limit = batchSize();
  const cutoff = new Date(Date.now() + lead * 60 * 1000).toISOString();

  await log({
    task_id: "cron.fire-nudges",
    component,
    event: "fire_tick_start",
    payload: { lead_minutes: lead, batch_size: limit, cutoff },
  });

  const supabase = supabaseServer();
  const { data: due, error: queryErr } = await supabase
    .from("lead_cases")
    .select("id, lead_profile, bda_whatsapp, language, scheduled_call_at")
    .eq("state", "nudge_scheduled")
    .lte("scheduled_call_at", cutoff)
    .order("scheduled_call_at", { ascending: true })
    .limit(limit);

  if (queryErr) {
    await log({
      task_id: "cron.fire-nudges",
      component,
      level: "ERROR",
      event: "fire_tick_query_failed",
      error_message: queryErr.message,
    });
    return NextResponse.json({ error: queryErr.message }, { status: 500 });
  }

  const results: FireResult[] = [];
  for (const row of due ?? []) {
    const caseId = row.id as string;
    try {
      const r = await fireOne({
        caseId,
        profile: (row.lead_profile as PreCallProfile) ?? {},
        bdaWhatsapp: (row.bda_whatsapp as string | null) ?? null,
        language: (row.language as string | null) ?? undefined,
        firedBy: "cron",
      });
      results.push(r);
    } catch (e) {
      await log({
        case_id: caseId,
        task_id: "cron.fire-nudges",
        component,
        level: "ERROR",
        event: "fire_one_uncaught",
        error_message: String(e).slice(0, 500),
      });
      results.push({ case_id: caseId, status: "failed", error: String(e).slice(0, 200) });
    }
  }

  const summary = {
    sent: results.filter((r) => r.status === "sent").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "failed").length,
  };

  await log({
    task_id: "cron.fire-nudges",
    component,
    event: "fire_tick_done",
    latency_ms: Date.now() - started,
    payload: { ...summary, total: results.length, lead_minutes: lead, batch_size: limit },
  });

  return NextResponse.json({
    tick_at: new Date().toISOString(),
    lead_minutes: lead,
    cutoff,
    examined: due?.length ?? 0,
    ...summary,
    results,
  });
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
