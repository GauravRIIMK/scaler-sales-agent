/**
 * Task 2.1b — POST /api/cases/[id]/generate
 *
 * Orchestrates the full post-call pipeline for a single lead_cases row:
 *
 *   transcript OR audio_url  →  [STT if needed]
 *                            →  extract (2-pass concern→question)
 *                            →  persona (5-axis vector)
 *                            →  retrieve (hybrid + rerank, per question)
 *                            →  pdfContent (Opus per section, Sonnet fallback)
 *                            →  verify (3-moat anti-hallucination)
 *                            →  persist + state='verified' (awaiting_approval)
 *
 * Rendering the PDF + delivering on WhatsApp is a separate step
 * (POST /api/cases/[id]/pdf, Task 3.4c).
 *
 * Idempotent: callable repeatedly. Each call regenerates from the
 * stored transcript — useful for re-running after BDA edits a question list
 * by hand (out of scope for today but the door is open).
 */
import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase";
import { log } from "@/lib/log";
import { extractQuestions } from "@/lib/extract";
import { inferPersona, type LeadProfile as PersonaLeadProfile } from "@/lib/persona";
import { retrieveGrounding, type GroundingHit } from "@/lib/retrieve";
import { generatePDFContent } from "@/lib/pdfContent";
import { verifyPDFContent, type ChunkLike } from "@/lib/verify";
import { transcribeAudioFromUrl, isDeepgramConfigured } from "@/lib/deepgram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type StateFn = (next: string, fields?: Record<string, unknown>) => Promise<void>;

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const caseId = params.id;
  const component = "generate";
  const started = Date.now();

  if (!caseId) return NextResponse.json({ error: "missing case id" }, { status: 400 });

  const supabase = supabaseServer();

  const { data: row, error } = await supabase
    .from("lead_cases")
    .select("id, lead_profile, transcript_text, audio_blob_url, state")
    .eq("id", caseId)
    .single();
  if (error || !row) {
    return NextResponse.json(
      { error: `case not found: ${error?.message ?? "no row"}` },
      { status: 404 }
    );
  }

  const profile = (row.lead_profile as PersonaLeadProfile) ?? {};

  const setState: StateFn = async (next, fields = {}) => {
    await supabase
      .from("lead_cases")
      .update({ state: next, ...fields })
      .eq("id", caseId);
  };

  await log({
    case_id: caseId,
    task_id: "2.1-generate",
    component,
    event: "generate_start",
    payload: {
      has_transcript: !!row.transcript_text,
      has_audio: !!row.audio_blob_url,
      from_state: row.state,
    },
  });

  // 1. STT if we only have audio.
  let transcript = (row.transcript_text as string | null) ?? "";
  if (!transcript && row.audio_blob_url) {
    if (!isDeepgramConfigured()) {
      await log({
        case_id: caseId,
        task_id: "2.1-generate",
        component,
        level: "ERROR",
        event: "stt_unavailable",
      });
      await setState("failed");
      return NextResponse.json(
        { error: "audio supplied but DEEPGRAM_API_KEY not configured", case_id: caseId },
        { status: 503 }
      );
    }
    await setState("transcribing");
    try {
      const stt = await transcribeAudioFromUrl(row.audio_blob_url as string, {
        caseId,
        component,
      });
      transcript = stt.transcript;
      await supabase
        .from("lead_cases")
        .update({ transcript_text: transcript, transcribed_at: new Date().toISOString() })
        .eq("id", caseId);
    } catch (e) {
      await log({
        case_id: caseId,
        task_id: "2.1-generate",
        component,
        level: "ERROR",
        event: "stt_failed",
        error_message: String(e).slice(0, 500),
      });
      await setState("failed");
      return NextResponse.json(
        { error: `STT failed: ${String(e).slice(0, 200)}`, case_id: caseId },
        { status: 500 }
      );
    }
  }

  if (!transcript) {
    await setState("failed");
    return NextResponse.json(
      { error: "no transcript available after STT", case_id: caseId },
      { status: 400 }
    );
  }

  // 2. Extract questions.
  let extractResult;
  try {
    extractResult = await extractQuestions(transcript, { caseId, component });
  } catch (e) {
    await log({
      case_id: caseId,
      task_id: "2.1-generate",
      component,
      level: "ERROR",
      event: "extract_failed",
      error_message: String(e).slice(0, 500),
    });
    await setState("failed");
    return NextResponse.json(
      { error: `extract failed: ${String(e).slice(0, 200)}`, case_id: caseId },
      { status: 500 }
    );
  }
  await setState("questions_extracted", {
    extracted_questions: extractResult.questions,
    extracted_at: new Date().toISOString(),
  });

  // 3. Persona.
  let persona;
  try {
    persona = await inferPersona({
      profile,
      questions: extractResult.questions,
      transcript_excerpt: transcript.slice(0, 4000),
      caseId,
      component,
    });
  } catch (e) {
    await log({
      case_id: caseId,
      task_id: "2.1-generate",
      component,
      level: "ERROR",
      event: "persona_failed",
      error_message: String(e).slice(0, 500),
    });
    await setState("failed");
    return NextResponse.json(
      { error: `persona failed: ${String(e).slice(0, 200)}`, case_id: caseId },
      { status: 500 }
    );
  }
  await setState("persona_inferred", { persona_vector: persona });

  // 4. Retrieve per question.
  const retrievedByIdx: Record<number, GroundingHit[]> = {};
  const retrievedMeta: Record<number, { refused: boolean; top_score: number | null; pool: number }> = {};
  for (let i = 0; i < extractResult.questions.length; i++) {
    const q = extractResult.questions[i];
    try {
      const r = await retrieveGrounding(q.question_rewritten, {
        caseId,
        taskId: "2.1-generate",
        component,
        topK: 6,
      });
      retrievedByIdx[i] = r.hits;
      retrievedMeta[i] = { refused: r.refused, top_score: r.top_rerank_score, pool: r.pool_size };
    } catch (e) {
      await log({
        case_id: caseId,
        task_id: "2.1-generate",
        component,
        level: "WARN",
        event: "retrieve_question_failed",
        error_message: String(e).slice(0, 500),
        payload: { idx: i },
      });
      retrievedByIdx[i] = [];
      retrievedMeta[i] = { refused: true, top_score: null, pool: 0 };
    }
  }
  await setState("retrieved", {
    retrieved_chunks: { by_question: retrievedMeta },
    retrieved_at: new Date().toISOString(),
  });

  // 5. Generate PDF content.
  let pdfContent;
  try {
    pdfContent = await generatePDFContent({
      profile,
      questions: extractResult.questions,
      persona,
      retrievedChunksByQuestion: retrievedByIdx,
      caseId,
      component,
    });
  } catch (e) {
    await log({
      case_id: caseId,
      task_id: "2.1-generate",
      component,
      level: "ERROR",
      event: "pdf_content_failed",
      error_message: String(e).slice(0, 500),
    });
    await setState("failed");
    return NextResponse.json(
      { error: `pdf content failed: ${String(e).slice(0, 200)}`, case_id: caseId },
      { status: 500 }
    );
  }
  await setState("generated", { pdf_content: pdfContent, generated_at: new Date().toISOString() });

  // 6. Verify — moat 1/2/3 honesty pass.
  const chunkLookup = new Map<string, ChunkLike>();
  for (const hits of Object.values(retrievedByIdx)) {
    for (const h of hits) {
      if (!chunkLookup.has(h.id)) chunkLookup.set(h.id, { id: h.id, text: h.text, url: h.url });
    }
  }

  let verified;
  try {
    verified = await verifyPDFContent(pdfContent, chunkLookup, { caseId, component });
  } catch (e) {
    await log({
      case_id: caseId,
      task_id: "2.1-generate",
      component,
      level: "ERROR",
      event: "verify_failed",
      error_message: String(e).slice(0, 500),
    });
    await setState("failed");
    return NextResponse.json(
      { error: `verify failed: ${String(e).slice(0, 200)}`, case_id: caseId },
      { status: 500 }
    );
  }

  await supabase
    .from("lead_cases")
    .update({
      pdf_content: verified.content,
      covering_msg: verified.content.covering_msg,
      state: "awaiting_approval",
      verified_at: new Date().toISOString(),
    })
    .eq("id", caseId);

  await log({
    case_id: caseId,
    task_id: "2.1-generate",
    component,
    event: "generate_ok",
    latency_ms: Date.now() - started,
    payload: {
      question_count: extractResult.questions.length,
      section_count: verified.content.sections.length,
      archetype: persona.archetype_label,
      degraded: {
        extract: extractResult.degraded,
        persona: persona.degraded,
        pdf: verified.content.generated_with.degraded,
        verify_moat2_skipped: verified.stats.moat2_skipped,
      },
      verify_stats: verified.stats,
    },
  });

  return NextResponse.json({
    case_id: caseId,
    state: "awaiting_approval",
    questions: extractResult.questions.length,
    sections: verified.content.sections.length,
    archetype: persona.archetype_label,
    degraded:
      extractResult.degraded ||
      persona.degraded ||
      verified.content.generated_with.degraded ||
      verified.stats.moat2_skipped,
    verify_stats: verified.stats,
    covering_msg: verified.content.covering_msg,
  });
}
