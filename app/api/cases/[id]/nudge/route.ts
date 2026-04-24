/**
 * Task 3.1 route — POST /api/cases/[id]/nudge
 *
 * Generates the pre-call BDA nudge (markdown + WhatsApp plaintext) for the
 * given case. Assumes extract + persona + retrieve already ran (i.e. the
 * case is at least in state='persona_inferred').
 *
 * The nudge itself is produced by lib/nudge.ts. This route is thin:
 *   - load the case
 *   - pool + rerank top chunks across every extracted question
 *   - call generateNudge
 *   - persist bda_nudge_markdown on the case
 *   - return both renderings
 *
 * Sending the nudge over WhatsApp is a separate route (Task 4.4).
 */
import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase";
import { log } from "@/lib/log";
import { generateNudge, type LeadProfile } from "@/lib/nudge";
import { retrieveGrounding, type GroundingHit } from "@/lib/retrieve";
import type { ExtractedQuestion } from "@/lib/extract";
import type { PersonaVector } from "@/lib/persona";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const TOP_CHUNKS_FOR_NUDGE = 3;

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const caseId = params.id;
  const component = "nudge_route";
  const started = Date.now();
  if (!caseId) return NextResponse.json({ error: "missing case id" }, { status: 400 });

  const supabase = supabaseServer();

  const { data: row, error } = await supabase
    .from("lead_cases")
    .select("id, lead_profile, extracted_questions, persona_vector")
    .eq("id", caseId)
    .single();
  if (error || !row) {
    return NextResponse.json(
      { error: `case not found: ${error?.message ?? "no row"}` },
      { status: 404 }
    );
  }

  const profile = (row.lead_profile as LeadProfile) ?? {};
  const questions = (row.extracted_questions as ExtractedQuestion[]) ?? [];
  const persona = row.persona_vector as PersonaVector | null;

  if (!persona) {
    return NextResponse.json(
      { error: "persona_vector missing — run /api/cases/[id]/generate first" },
      { status: 409 }
    );
  }

  // Pool top chunks across every extracted question, dedupe by chunk id,
  // keep the highest rerank_score per id, take the top N.
  const byId = new Map<string, GroundingHit>();
  if (questions.length > 0) {
    for (const q of questions) {
      try {
        const r = await retrieveGrounding(q.question_rewritten, {
          caseId,
          taskId: "3.1-nudge",
          component,
          topK: 3,
        });
        for (const h of r.hits) {
          const prev = byId.get(h.id);
          if (!prev || prev.rerank_score < h.rerank_score) byId.set(h.id, h);
        }
      } catch (e) {
        await log({
          case_id: caseId,
          task_id: "3.1-nudge",
          component,
          level: "WARN",
          event: "nudge_retrieve_question_failed",
          error_message: String(e).slice(0, 500),
          payload: { question: q.question_rewritten.slice(0, 200) },
        });
      }
    }
  }
  const topChunks = [...byId.values()]
    .sort((a, b) => b.rerank_score - a.rerank_score)
    .slice(0, TOP_CHUNKS_FOR_NUDGE);

  await log({
    case_id: caseId,
    task_id: "3.1-nudge",
    component,
    event: "nudge_chunks_pooled",
    payload: { pooled: byId.size, kept: topChunks.length },
  });

  let nudge;
  try {
    nudge = await generateNudge({
      profile,
      questions,
      persona,
      topChunks,
      caseId,
      component,
    });
  } catch (e) {
    await log({
      case_id: caseId,
      task_id: "3.1-nudge",
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
      task_id: "3.1-nudge",
      component,
      level: "WARN",
      event: "nudge_persist_failed",
      error_message: updErr.message,
    });
  }

  await log({
    case_id: caseId,
    task_id: "3.1-nudge",
    component,
    event: "nudge_ok",
    latency_ms: Date.now() - started,
    payload: {
      markdown_chars: nudge.markdown.length,
      whatsapp_chars: nudge.char_count_whatsapp,
      degraded: nudge.degraded,
      model: nudge.model,
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
  });
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const caseId = params.id;
  if (!caseId) return NextResponse.json({ error: "missing case id" }, { status: 400 });

  const supabase = supabaseServer();
  const { data, error } = await supabase
    .from("lead_cases")
    .select("id, bda_nudge_markdown")
    .eq("id", caseId)
    .single();
  if (error || !data) {
    return NextResponse.json(
      { error: `case not found: ${error?.message ?? "no row"}` },
      { status: 404 }
    );
  }
  return NextResponse.json({ case_id: caseId, markdown: data.bda_nudge_markdown ?? null });
}
