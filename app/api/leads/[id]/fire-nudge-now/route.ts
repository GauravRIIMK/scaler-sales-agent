/**
 * POST /api/leads/[id]/fire-nudge-now
 *
 * Manual override of the cron — fires a single lead's pre-call nudge
 * immediately. Used by:
 *   - the demo button in the UI (so the Loom doesn't have to wait for the
 *     cron tick)
 *   - the seed-personas script (R-IM-01: scripted demo coverage)
 *   - operators investigating a stuck row
 *
 * Behaviour matches the cron's per-row logic exactly — same generation,
 * same persistence, same state transition. nudge_fired_by is stamped
 * 'manual' so we can later tell a manual fire apart from an auto-fire.
 *
 * Body (optional):
 *   { override_to?: string }   — send to a different WhatsApp number than
 *                                lead_cases.bda_whatsapp. Useful for demos
 *                                where the evaluator wants the nudge in
 *                                their own thread.
 *
 * Returns the same shape as a single cron result.
 */
import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase";
import { log } from "@/lib/log";
import { fireOne } from "@/lib/fireNudge";
import type { PreCallProfile } from "@/lib/preCallNudge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface ManualFireBody {
  override_to?: string;
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const caseId = params.id;
  const component = "leads_fire_now";
  if (!caseId) return NextResponse.json({ error: "missing lead id" }, { status: 400 });

  const body = (await req.json().catch(() => ({}))) as ManualFireBody;

  const supabase = supabaseServer();
  const { data: row, error } = await supabase
    .from("lead_cases")
    .select("id, lead_profile, bda_whatsapp, language, state")
    .eq("id", caseId)
    .single();
  if (error || !row) {
    return NextResponse.json(
      { error: `lead not found: ${error?.message ?? "no row"}` },
      { status: 404 }
    );
  }

  // Safety: don't fire if the row has already moved past 'nudge_scheduled'
  // unless the caller explicitly asks for a reset (out of scope here).
  // Allowed states: 'nudge_scheduled' (the normal case). Allow refire from
  // 'nudge_sent' too so the demo can re-fire to a different number.
  if (row.state !== "nudge_scheduled" && row.state !== "nudge_sent") {
    return NextResponse.json(
      {
        error: `lead is in state '${row.state}' — cannot fire a pre-call nudge for a post-call row`,
        case_id: caseId,
      },
      { status: 409 }
    );
  }

  const recipient = body.override_to ?? (row.bda_whatsapp as string | null);
  if (!recipient) {
    return NextResponse.json(
      { error: "no recipient — set lead_cases.bda_whatsapp or pass override_to" },
      { status: 400 }
    );
  }

  await log({
    case_id: caseId,
    task_id: "leads.fire-now",
    component,
    event: "manual_fire_start",
    payload: { recipient_override: !!body.override_to, current_state: row.state },
  });

  const result = await fireOne({
    caseId,
    profile: (row.lead_profile as PreCallProfile) ?? {},
    bdaWhatsapp: recipient,
    language: (row.language as string | null) ?? undefined,
    firedBy: "manual",
  });

  const status = result.status === "sent" ? 200 : result.status === "skipped" ? 409 : 500;
  return NextResponse.json(result, { status });
}
