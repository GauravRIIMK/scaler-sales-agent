/**
 * POST /api/cases/[id]/nudge
 *
 * Generates the pre-call BDA nudge (markdown + WhatsApp plaintext) for the
 * given case.
 *
 * As of the two-stage refactor, this route is a thin wrapper around
 * lib/preCallNudge.ts — the assignment-correct, profile-only nudge
 * generator. It no longer requires extracted_questions or persona_vector to
 * exist; it derives retrieval queries from the lead_profile alone, infers
 * persona from profile alone, and never references the transcript.
 *
 * The legacy lib/nudge.ts (which consumed transcript-derived questions +
 * persona) was removed because:
 *   1. The assignment defines the BDA nudge as a PRE-CALL artifact — sent
 *      ahead of the call, before any transcript can possibly exist.
 *   2. Two callsites (cron auto-fire + manual fire-now) already use
 *      preCallNudge. Having a second post-call-aware path was a footgun:
 *      a manually-triggered post-/generate nudge would leak transcript
 *      facts into a brief that ought to read pre-call-clean.
 *
 * Persisted columns (bda_nudge_markdown, bda_nudge_whatsapp_plaintext) are
 * unchanged so the downstream /nudge/send route keeps working.
 */
import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase";
import { log } from "@/lib/log";
import { generatePreCallNudge, type PreCallProfile } from "@/lib/preCallNudge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const caseId = params.id;
  const component = "nudge_route";
  const started = Date.now();
  if (!caseId) return NextResponse.json({ error: "missing case id" }, { status: 400 });

  const supabase = supabaseServer();

  const { data: row, error } = await supabase
    .from("lead_cases")
    .select("id, lead_profile, language")
    .eq("id", caseId)
    .single();
  if (error || !row) {
    return NextResponse.json(
      { error: `case not found: ${error?.message ?? "no row"}` },
      { status: 404 }
    );
  }

  const profile = (row.lead_profile as PreCallProfile) ?? {};

  let nudge;
  try {
    nudge = await generatePreCallNudge({
      profile,
      caseId,
      component,
      language: (row.language as string | null) ?? undefined,
    });
  } catch (e) {
    await log({
      case_id: caseId,
      task_id: "nudge-route",
      component,
      level: "ERROR",
      event: "nudge_generate_failed",
      error_message: String(e).slice(0, 500),
    });
    return NextResponse.json(
      { error: `nudge generation failed: ${String(e).slice(0, 200)}`, case_id: caseId },
      { status: 500 }
    );
  }

  const { error: updErr } = await supabase
    .from("lead_cases")
    .update({
      bda_nudge_markdown: nudge.markdown,
      bda_nudge_whatsapp_plaintext: nudge.whatsapp_plaintext,
    })
    .eq("id", caseId);
  if (updErr) {
    await log({
      case_id: caseId,
      task_id: "nudge-route",
      component,
      level: "WARN",
      event: "nudge_persist_failed",
      error_message: updErr.message,
    });
  }

  await log({
    case_id: caseId,
    task_id: "nudge-route",
    component,
    event: "nudge_ok",
    latency_ms: Date.now() - started,
    payload: {
      markdown_chars: nudge.markdown.length,
      whatsapp_chars: nudge.char_count_whatsapp,
      degraded: nudge.degraded,
      model: nudge.model,
      retrieved_chunk_count: nudge.retrieved_chunk_count,
      derived_query_count: nudge.derived_queries.length,
      persona_archetype: nudge.persona.archetype_label,
    },
  });

  return NextResponse.json({
    case_id: caseId,
    markdown: nudge.markdown,
    whatsapp_plaintext: nudge.whatsapp_plaintext,
    inferred_angles: nudge.inferred_angles,
    sources_used: nudge.sources_used,
    degraded: nudge.degraded,
    model: nudge.model,
    retrieved_chunks: nudge.retrieved_chunk_count,
    derived_queries: nudge.derived_queries,
    persona_archetype: nudge.persona.archetype_label,
  });
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const caseId = params.id;
  if (!caseId) return NextResponse.json({ error: "missing case id" }, { status: 400 });

  const supabase = supabaseServer();
  const { data, error } = await supabase
    .from("lead_cases")
    .select("id, bda_nudge_markdown, bda_nudge_whatsapp_plaintext")
    .eq("id", caseId)
    .single();
  if (error || !data) {
    return NextResponse.json(
      { error: `case not found: ${error?.message ?? "no row"}` },
      { status: 404 }
    );
  }
  return NextResponse.json({
    case_id: caseId,
    markdown: data.bda_nudge_markdown ?? null,
    whatsapp_plaintext: data.bda_nudge_whatsapp_plaintext ?? null,
  });
}
