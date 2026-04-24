/**
 * Task 3.4c — POST /api/cases/[id]/pdf
 *
 * Regenerates the LeadPDF for the given case. Assumes pdf_content and
 * persona_vector have already been written to lead_cases (Task 3.2 + 3.3).
 * Returns a signed URL into the SUPABASE_BUCKET_PDFS bucket.
 *
 * Runtime must be "nodejs" — @react-pdf/renderer depends on Node streams.
 */
import { NextResponse } from "next/server";
import { renderToBuffer, type DocumentProps } from "@react-pdf/renderer";
import React, { type ReactElement } from "react";
import { supabaseServer } from "@/lib/supabase";
import { log } from "@/lib/log";
import { LeadPDF } from "@/lib/pdf/LeadPDF";
import type { PDFContent } from "@/lib/pdfContent";
import type { PersonaVector } from "@/lib/persona";
import { requireBdaCode } from "@/lib/bdaAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface GroundingChunkRow {
  id: string;
  url: string;
  section_path: string[] | null;
  fetched_at: string;
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const caseId = params.id;
  const component = "pdf_render";
  const started = Date.now();

  if (!caseId) return NextResponse.json({ error: "missing case id" }, { status: 400 });

  const authErr = requireBdaCode(req, caseId);
  if (authErr) return authErr;

  await log({ case_id: caseId, task_id: "3.4-render", component, event: "pdf_render_start" });

  const supabase = supabaseServer();

  // 1. Load the case.
  const { data: row, error } = await supabase
    .from("lead_cases")
    .select("id, lead_profile, persona_vector, pdf_content, covering_msg")
    .eq("id", caseId)
    .single();

  if (error || !row) {
    await log({
      case_id: caseId,
      task_id: "3.4-render",
      component,
      level: "ERROR",
      event: "pdf_render_case_missing",
      error_message: error?.message ?? "no row",
    });
    return NextResponse.json({ error: `case not found: ${error?.message ?? "no row"}` }, { status: 404 });
  }

  const content = row.pdf_content as PDFContent | null;
  const persona = row.persona_vector as PersonaVector | null;
  const profile = (row.lead_profile as Record<string, unknown>) ?? {};

  if (!content || !persona) {
    await log({
      case_id: caseId,
      task_id: "3.4-render",
      component,
      level: "ERROR",
      event: "pdf_render_missing_prereqs",
      payload: { has_content: !!content, has_persona: !!persona },
    });
    return NextResponse.json(
      { error: "pdf_content or persona_vector missing — run /api/cases/[id]/generate first" },
      { status: 409 }
    );
  }

  // 2. Resolve chunk metadata for citation footnotes.
  const chunkIds = Array.from(
    new Set(content.sections.flatMap((s) => s.sentences.flatMap((x) => x.chunk_ids)))
  );
  const chunksMeta: Record<string, { url: string; section_path?: string[] }> = {};
  let corpusFetchedAt: string | undefined;
  if (chunkIds.length > 0) {
    const { data: chunkRows, error: chunkErr } = await supabase
      .from("grounding_chunks")
      .select("id, url, section_path, fetched_at")
      .in("id", chunkIds);
    if (chunkErr) {
      await log({
        case_id: caseId,
        task_id: "3.4-render",
        component,
        level: "WARN",
        event: "pdf_render_chunk_lookup_failed",
        error_message: chunkErr.message,
      });
    } else {
      (chunkRows as GroundingChunkRow[] | null)?.forEach((c) => {
        chunksMeta[c.id] = { url: c.url, section_path: c.section_path ?? undefined };
        if (!corpusFetchedAt || c.fetched_at < corpusFetchedAt) corpusFetchedAt = c.fetched_at;
      });
    }
  }

  // 3. Render PDF.
  let pdfBytes: Buffer;
  try {
    const element = React.createElement(LeadPDF, {
      content,
      persona,
      profile: profile as { name?: string } & Record<string, unknown>,
      chunks: chunksMeta,
      corpus_fetched_at: corpusFetchedAt,
      case_id: caseId,
    }) as unknown as ReactElement<DocumentProps>;
    pdfBytes = await renderToBuffer(element);
  } catch (e) {
    await log({
      case_id: caseId,
      task_id: "3.4-render",
      component,
      level: "ERROR",
      event: "pdf_render_failed",
      error_message: String(e).slice(0, 500),
    });
    return NextResponse.json({ error: `render failed: ${String(e).slice(0, 200)}` }, { status: 500 });
  }

  // 4. Upload to Supabase Storage.
  const bucket = process.env.SUPABASE_BUCKET_PDFS || "scaler-sales-pdfs";
  const objectPath = `cases/${caseId}/${Date.now()}.pdf`;

  const { error: uploadErr } = await supabase.storage.from(bucket).upload(objectPath, pdfBytes, {
    contentType: "application/pdf",
    upsert: false,
  });
  if (uploadErr) {
    await log({
      case_id: caseId,
      task_id: "3.4-render",
      component,
      level: "ERROR",
      event: "pdf_render_upload_failed",
      error_message: uploadErr.message,
      payload: { bucket, objectPath },
    });
    return NextResponse.json(
      { error: `upload failed: ${uploadErr.message} (bucket=${bucket})` },
      { status: 500 }
    );
  }

  // 5. Sign URL (30 days) for WhatsApp download.
  const { data: signed, error: signErr } = await supabase.storage
    .from(bucket)
    .createSignedUrl(objectPath, 60 * 60 * 24 * 30);
  if (signErr || !signed) {
    await log({
      case_id: caseId,
      task_id: "3.4-render",
      component,
      level: "ERROR",
      event: "pdf_render_sign_failed",
      error_message: signErr?.message ?? "no signed url",
    });
    return NextResponse.json(
      { error: `signing failed: ${signErr?.message ?? "unknown"}` },
      { status: 500 }
    );
  }
  const pdf_url = signed.signedUrl;

  // 6. Persist pdf_url on the case.
  const { error: updateErr } = await supabase
    .from("lead_cases")
    .update({ pdf_url, generated_at: new Date().toISOString() })
    .eq("id", caseId);
  if (updateErr) {
    await log({
      case_id: caseId,
      task_id: "3.4-render",
      component,
      level: "WARN",
      event: "pdf_render_url_persist_failed",
      error_message: updateErr.message,
    });
  }

  await log({
    case_id: caseId,
    task_id: "3.4-render",
    component,
    event: "pdf_render_ok",
    latency_ms: Date.now() - started,
    payload: {
      bucket,
      objectPath,
      bytes: pdfBytes.length,
      sections: content.sections.length,
    },
  });

  return NextResponse.json({
    pdf_url,
    bytes: pdfBytes.length,
    sections: content.sections.length,
    case_id: caseId,
  });
}
