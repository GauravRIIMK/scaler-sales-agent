/**
 * POST /api/cases/extract-profile
 *
 * Accepts a free-text lead description (and optional transcript/notes) and
 * returns a structured LeadProfile extracted by Sonnet 4.6.
 *
 * This route is unprivileged — no DB writes, no external sends. No BDA
 * approval gate is applied.
 *
 * Runtime: nodejs (matches other API routes in this project).
 */
import { NextResponse } from "next/server";
import { extractProfile } from "@/lib/profileExtract";
import type { ExtractInput } from "@/lib/profileExtract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Hard caps applied before passing to the extractor.
const MAX_PROFILE_TEXT = 8_000;
const MAX_TRANSCRIPT = 24_000;
const MAX_NOTES = 4_000;
const MIN_PROFILE_TEXT = 20;

function badRequest(msg: string) {
  return NextResponse.json({ error: msg }, { status: 400 });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("invalid JSON body");
  }

  if (!body || typeof body !== "object") {
    return badRequest("request body must be a JSON object");
  }

  const raw = body as Record<string, unknown>;

  // Validate profile_text.
  if (typeof raw.profile_text !== "string" || raw.profile_text.trim().length < MIN_PROFILE_TEXT) {
    return badRequest(`profile_text must be a non-empty string of at least ${MIN_PROFILE_TEXT} characters`);
  }

  // Cap lengths defensively before handing off.
  const input: ExtractInput = {
    profile_text: raw.profile_text.slice(0, MAX_PROFILE_TEXT),
    transcript:
      typeof raw.transcript === "string" && raw.transcript.length > 0
        ? raw.transcript.slice(0, MAX_TRANSCRIPT)
        : undefined,
    notes:
      typeof raw.notes === "string" && raw.notes.length > 0
        ? raw.notes.slice(0, MAX_NOTES)
        : undefined,
    language:
      typeof raw.language === "string" && raw.language.length > 0
        ? raw.language
        : undefined,
    // No case_id at this stage — extraction is pre-ingest.
  };

  try {
    const result = await extractProfile(input);
    return NextResponse.json({
      profile: result.profile,
      confidence: result.confidence,
      missing_fields: result.missing_fields,
      reasoning: result.reasoning,
      model_tier: "sonnet",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: `extraction failed: ${msg.slice(0, 200)}` },
      { status: 500 }
    );
  }
}
