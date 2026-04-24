/**
 * Task 2.1 — POST /api/cases/new
 *
 * Single entry point that takes a lead profile + either a transcript or an
 * audio reference, creates a lead_cases row in state='received', and returns
 * the case id. Keeps ingest strictly a data-landing step — the pipeline runs
 * from POST /api/cases/[id]/generate.
 *
 * Accepts JSON OR multipart form. Multipart is used when the evaluator
 * uploads a raw audio blob in the same request; we push it to Storage and
 * persist the signed URL.
 *
 * Runtime: nodejs (we touch Buffer + Supabase storage).
 */
import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AUDIO_BUCKET = process.env.SUPABASE_BUCKET_AUDIO || "scaler-sales-audio";
const MAX_TRANSCRIPT_CHARS = 120_000; // ~30 min of speech at 4 chars/word
const MAX_AUDIO_BYTES = 40 * 1024 * 1024; // 40 MB

interface NewCaseBody {
  profile?: Record<string, unknown>;
  transcript?: string;
  audio_url?: string;
  evaluator_phone?: string;
  /** WhatsApp number for the BDA who receives the pre-call nudge. E.164 recommended. */
  bda_whatsapp?: string;
  /** Display name of the BDA shown on the nudge message. */
  bda_name?: string;
  /** Locale code for generated content: en-IN | en-US | hi */
  language?: string;
}

/** Soft-check: warn in logs when a phone value is provided but does not start with '+'. */
function isPhoneSuspect(value: string | undefined): boolean {
  return typeof value === "string" && value.length > 0 && !value.startsWith("+");
}

function badRequest(msg: string) {
  return NextResponse.json({ error: msg }, { status: 400 });
}

export async function POST(req: Request) {
  const started = Date.now();
  const component = "cases_new";

  const ct = req.headers.get("content-type") ?? "";
  let profile: Record<string, unknown> | undefined;
  let transcript: string | undefined;
  let audioUrl: string | undefined;
  let evaluatorPhone: string | undefined;
  let bdaWhatsapp: string | undefined;
  let bdaName: string | undefined;
  let language: string | undefined;
  let audioBytes: Uint8Array | undefined;
  let audioContentType: string | undefined;

  try {
    if (ct.includes("multipart/form-data")) {
      const form = await req.formData();
      const profileRaw = form.get("profile");
      if (typeof profileRaw === "string" && profileRaw.length > 0) {
        profile = JSON.parse(profileRaw);
      }
      const t = form.get("transcript");
      if (typeof t === "string") transcript = t;
      const a = form.get("audio_url");
      if (typeof a === "string") audioUrl = a;
      const e = form.get("evaluator_phone");
      if (typeof e === "string") evaluatorPhone = e;
      const bw = form.get("bda_whatsapp");
      if (typeof bw === "string") bdaWhatsapp = bw || undefined;
      const bn = form.get("bda_name");
      if (typeof bn === "string") bdaName = bn || undefined;
      const lang = form.get("language");
      if (typeof lang === "string") language = lang || undefined;

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
      const body = (await req.json().catch(() => null)) as NewCaseBody | null;
      if (!body) return badRequest("invalid JSON body");
      profile = body.profile;
      transcript = body.transcript;
      audioUrl = body.audio_url;
      evaluatorPhone = body.evaluator_phone;
      bdaWhatsapp = body.bda_whatsapp || undefined;
      bdaName = body.bda_name || undefined;
      language = body.language || undefined;
    }
  } catch (e) {
    return badRequest(`parse error: ${String(e).slice(0, 180)}`);
  }

  if (!profile || typeof profile !== "object") {
    return badRequest("profile (object) is required");
  }
  if (!transcript && !audioUrl && !audioBytes) {
    return badRequest("one of transcript, audio_url, or audio file is required");
  }
  if (transcript && transcript.length > MAX_TRANSCRIPT_CHARS) {
    return badRequest(`transcript too long (>${MAX_TRANSCRIPT_CHARS} chars)`);
  }

  // Soft E.164 checks — not hard rejections, just logged warnings.
  const suspectPhones: string[] = [];
  if (isPhoneSuspect(evaluatorPhone)) suspectPhones.push("evaluator_phone");
  if (isPhoneSuspect(bdaWhatsapp)) suspectPhones.push("bda_whatsapp");

  const supabase = supabaseServer();

  // 1. Create the row first so the case_id exists for storage pathing.
  const { data: created, error: insertErr } = await supabase
    .from("lead_cases")
    .insert({
      lead_profile: profile,
      transcript_text: transcript ?? null,
      audio_blob_url: audioUrl ?? null,
      evaluator_phone: evaluatorPhone ?? null,
      bda_whatsapp: bdaWhatsapp ?? null,
      bda_name: bdaName ?? null,
      language: language ?? null,
      state: "received",
      received_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (insertErr || !created) {
    await log({
      task_id: "2.1-ingest",
      component,
      level: "ERROR",
      event: "case_create_failed",
      error_message: insertErr?.message ?? "no row",
    });
    return NextResponse.json(
      { error: `create failed: ${insertErr?.message ?? "unknown"}` },
      { status: 500 }
    );
  }

  const caseId = created.id as string;

  // 2. If audio was uploaded, push it to Storage and persist the URL on the row.
  if (audioBytes) {
    const ext = audioContentType?.includes("wav")
      ? "wav"
      : audioContentType?.includes("mp3")
      ? "mp3"
      : "bin";
    const objectPath = `cases/${caseId}/source.${ext}`;
    const { error: upErr } = await supabase.storage
      .from(AUDIO_BUCKET)
      .upload(objectPath, audioBytes, { contentType: audioContentType, upsert: false });
    if (upErr) {
      await log({
        case_id: caseId,
        task_id: "2.1-ingest",
        component,
        level: "ERROR",
        event: "audio_upload_failed",
        error_message: upErr.message,
        payload: { bucket: AUDIO_BUCKET, objectPath },
      });
      return NextResponse.json(
        {
          error: `audio upload failed: ${upErr.message} (bucket=${AUDIO_BUCKET})`,
          case_id: caseId,
        },
        { status: 500 }
      );
    }
    // Use a signed URL so later steps (Deepgram) can fetch.
    const { data: signed, error: signErr } = await supabase.storage
      .from(AUDIO_BUCKET)
      .createSignedUrl(objectPath, 60 * 60 * 24); // 24h
    if (signErr || !signed) {
      await log({
        case_id: caseId,
        task_id: "2.1-ingest",
        component,
        level: "ERROR",
        event: "audio_sign_failed",
        error_message: signErr?.message ?? "no signed url",
      });
      return NextResponse.json(
        {
          error: `audio sign failed: ${signErr?.message ?? "unknown"}`,
          case_id: caseId,
        },
        { status: 500 }
      );
    }
    audioUrl = signed.signedUrl;

    const { error: updErr } = await supabase
      .from("lead_cases")
      .update({ audio_blob_url: audioUrl })
      .eq("id", caseId);
    if (updErr) {
      await log({
        case_id: caseId,
        task_id: "2.1-ingest",
        component,
        level: "WARN",
        event: "audio_url_persist_failed",
        error_message: updErr.message,
      });
    }
  }

  await log({
    case_id: caseId,
    task_id: "2.1-ingest",
    component,
    event: "case_received",
    latency_ms: Date.now() - started,
    payload: {
      has_transcript: !!transcript,
      has_audio: !!audioUrl,
      evaluator_phone_set: !!evaluatorPhone,
      bda_whatsapp_set: !!bdaWhatsapp,
      bda_name_set: !!bdaName,
      language: language ?? null,
      suspect_phone_formats: suspectPhones.length > 0 ? suspectPhones : undefined,
    },
  });

  return NextResponse.json({
    case_id: caseId,
    state: "received",
    has_transcript: !!transcript,
    audio_url: audioUrl ?? null,
    next: `/api/cases/${caseId}/generate`,
  });
}
