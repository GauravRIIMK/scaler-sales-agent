/**
 * POST /api/cases/[id]/post-call
 *
 * Stage-B entry point of the two-stage flow. The BDA has just finished the
 * call and now uploads either:
 *   - a transcript (text), or
 *   - an audio recording (multipart file or audio_url)
 *
 * This endpoint UPDATES an existing lead_cases row that was created by
 * /api/leads (state='nudge_scheduled' or 'nudge_sent'), persists the
 * transcript / audio reference, and transitions to state='received'. From
 * there the existing /api/cases/[id]/generate pipeline takes over (extract
 * questions → infer post-call persona → retrieve → generate PDF →
 * approval gate → deliver).
 *
 * Why a separate route from /api/cases/new:
 *   - /api/cases/new creates a NEW row from scratch with profile +
 *     transcript bundled. That's the legacy single-shot path used by the
 *     seed script and any caller that has all data up front.
 *   - /api/cases/[id]/post-call layers the transcript/audio onto a row that
 *     ALREADY EXISTS (because the pre-call nudge fired against it earlier).
 *     Same lead, same case_id, two-stage lifecycle.
 *
 * Accepts JSON or multipart form (mirrors /api/cases/new's contract):
 *
 *   JSON body:
 *     {
 *       transcript?: string,
 *       audio_url?:  string,
 *       evaluator_phone?: string,  // lead's WhatsApp for PDF delivery
 *     }
 *
 *   Multipart fields:
 *     transcript        text
 *     audio_url         text
 *     evaluator_phone   text
 *     audio             file (uploaded to scaler-sales-audio bucket)
 */
import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const AUDIO_BUCKET = process.env.SUPABASE_BUCKET_AUDIO || "scaler-sales-audio";
const MAX_TRANSCRIPT_CHARS = 120_000;
const MAX_AUDIO_BYTES = 40 * 1024 * 1024;

interface PostCallBody {
  transcript?: string;
  audio_url?: string;
  evaluator_phone?: string;
}

function badRequest(msg: string) {
  return NextResponse.json({ error: msg }, { status: 400 });
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const caseId = params.id;
  const component = "cases_post_call";
  const started = Date.now();
  if (!caseId) return badRequest("missing case id");

  const ct = req.headers.get("content-type") ?? "";
  let transcript: string | undefined;
  let audioUrl: string | undefined;
  let evaluatorPhone: string | undefined;
  let audioBytes: Uint8Array | undefined;
  let audioContentType: string | undefined;

  try {
    if (ct.includes("multipart/form-data")) {
      const form = await req.formData();
      const t = form.get("transcript");
      if (typeof t === "string") transcript = t;
      const a = form.get("audio_url");
      if (typeof a === "string") audioUrl = a;
      const e = form.get("evaluator_phone");
      if (typeof e === "string") evaluatorPhone = e;

      const file = form.get("audio");
      if (file && typeof file !== "string") {
        const blob = file as Blob;
        if (blob.size > MAX_AUDIO_BYTES) {
          return badRequest(`audio too large (>${Math.floor(MAX_AUDIO_BYTES / (1024 * 1024))}MB)`);
        }
        audioBytes = new Uint8Array(await blob.arrayBuffer());
        audioContentType = blob.type || "application/octet-stream";
      }
    } else {
      const body = (await req.json().catch(() => null)) as PostCallBody | null;
      if (!body) return badRequest("invalid JSON body");
      transcript = body.transcript;
      audioUrl = body.audio_url;
      evaluatorPhone = body.evaluator_phone;
    }
  } catch (e) {
    return badRequest(`parse error: ${String(e).slice(0, 180)}`);
  }

  if (!transcript && !audioUrl && !audioBytes) {
    return badRequest("one of transcript, audio_url, or audio file is required");
  }
  if (transcript && transcript.length > MAX_TRANSCRIPT_CHARS) {
    return badRequest(`transcript too long (>${MAX_TRANSCRIPT_CHARS} chars)`);
  }

  const supabase = supabaseServer();

  // 1. Verify the row exists and is in a state that accepts post-call
  // ingest. Allowed: nudge_scheduled (call happened before cron fired —
  // unusual but valid), nudge_sent (the normal case). 'received' and later
  // states would mean the row is already past this stage.
  const { data: row, error: fetchErr } = await supabase
    .from("lead_cases")
    .select("id, state, audio_blob_url, transcript_text, evaluator_phone")
    .eq("id", caseId)
    .single();
  if (fetchErr || !row) {
    return NextResponse.json(
      { error: `lead not found: ${fetchErr?.message ?? "no row"}`, case_id: caseId },
      { status: 404 }
    );
  }
  const allowedStates = new Set(["nudge_scheduled", "nudge_sent", "received"]);
  if (!allowedStates.has(row.state as string)) {
    return NextResponse.json(
      {
        error: `case is in state '${row.state}' — already past the post-call ingest step`,
        case_id: caseId,
      },
      { status: 409 }
    );
  }

  // 2. If audio bytes were uploaded, push to storage + sign URL.
  if (audioBytes) {
    const ext = audioContentType?.includes("wav")
      ? "wav"
      : audioContentType?.includes("mp3")
      ? "mp3"
      : "bin";
    const objectPath = `cases/${caseId}/source.${ext}`;
    const { error: upErr } = await supabase.storage
      .from(AUDIO_BUCKET)
      .upload(objectPath, audioBytes, { contentType: audioContentType, upsert: true });
    if (upErr) {
      await log({
        case_id: caseId,
        task_id: "cases.post-call",
        component,
        level: "ERROR",
        event: "audio_upload_failed",
        error_message: upErr.message,
        payload: { bucket: AUDIO_BUCKET, objectPath },
      });
      return NextResponse.json(
        { error: `audio upload failed: ${upErr.message} (bucket=${AUDIO_BUCKET})`, case_id: caseId },
        { status: 500 }
      );
    }
    const { data: signed, error: signErr } = await supabase.storage
      .from(AUDIO_BUCKET)
      .createSignedUrl(objectPath, 60 * 60 * 24);
    if (signErr || !signed) {
      return NextResponse.json(
        { error: `audio sign failed: ${signErr?.message ?? "unknown"}`, case_id: caseId },
        { status: 500 }
      );
    }
    audioUrl = signed.signedUrl;
  }

  // 3. Update the row with the new ingest data + transition to 'received'
  // so the existing pipeline can run.
  const update: Record<string, unknown> = {
    state: "received",
  };
  if (transcript !== undefined) update.transcript_text = transcript;
  if (audioUrl !== undefined) update.audio_blob_url = audioUrl;
  if (evaluatorPhone !== undefined) update.evaluator_phone = evaluatorPhone;

  const { data: updated, error: updErr } = await supabase
    .from("lead_cases")
    .update(update)
    .eq("id", caseId)
    .select("id, state, audio_blob_url")
    .single();

  if (updErr || !updated) {
    await log({
      case_id: caseId,
      task_id: "cases.post-call",
      component,
      level: "ERROR",
      event: "post_call_update_failed",
      error_message: updErr?.message ?? "no row",
    });
    return NextResponse.json(
      { error: `update failed: ${updErr?.message ?? "unknown"}`, case_id: caseId },
      { status: 500 }
    );
  }

  await log({
    case_id: caseId,
    task_id: "cases.post-call",
    component,
    event: "post_call_ingested",
    latency_ms: Date.now() - started,
    payload: {
      previous_state: row.state,
      has_transcript: !!transcript,
      has_audio: !!audioUrl,
      evaluator_phone_set: !!evaluatorPhone,
    },
  });

  return NextResponse.json({
    case_id: caseId,
    state: updated.state,
    has_transcript: !!transcript,
    audio_url: updated.audio_blob_url ?? null,
    next: `/api/cases/${caseId}/generate`,
  });
}
