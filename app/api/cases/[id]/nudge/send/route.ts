/**
 * Task 4.4 route — POST /api/cases/[id]/nudge/send
 *
 * Sends the pre-generated BDA nudge (WhatsApp plaintext rendering) to a BDA
 * WhatsApp number. The nudge must have been generated already via
 * POST /api/cases/[id]/nudge.
 *
 * Request body:
 *   { to: string }  — BDA WhatsApp number in E.164 (or raw digits; we coerce)
 *
 * Recipient resolution order:
 *   body.to → lead_cases.bda_whatsapp → BDA_WHATSAPP_TO env var
 *
 * Plaintext resolution order:
 *   body.override_body → bda_nudge_whatsapp_plaintext (persisted) → mdToWhatsApp(markdown)
 */
import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase";
import { log } from "@/lib/log";
import { isTwilioConfigured, sendWhatsAppText } from "@/lib/twilio";
import { requireBdaCode } from "@/lib/bdaAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SendNudgeBody {
  to?: string;
  override_body?: string;
}

const WHATSAPP_CHAR_LIMIT = 1500;

function mdToWhatsApp(md: string): string {
  // Strip leading headings & bullet dashes, drop blank trailing lines,
  // collapse multiple blank lines. Truncate at a sentence boundary.
  const stripped = md
    .split("\n")
    .map((l) =>
      l
        .replace(/^#+\s+/, "")
        .replace(/^\s*[-*+]\s+/, "• ")
        .replace(/`{1,3}/g, "")
    )
    .filter((l) => l.trim().length > 0)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (stripped.length <= WHATSAPP_CHAR_LIMIT) return stripped;
  const cut = stripped.slice(0, WHATSAPP_CHAR_LIMIT - 1);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"));
  return (lastStop > 80 ? cut.slice(0, lastStop + 1) : cut).trimEnd() + "…";
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const caseId = params.id;
  const component = "nudge_send";
  if (!caseId) return NextResponse.json({ error: "missing case id" }, { status: 400 });

  const authErr = requireBdaCode(req, caseId);
  if (authErr) return authErr;

  if (!isTwilioConfigured()) {
    return NextResponse.json(
      { error: "Twilio not configured — set TWILIO_ACCOUNT_SID / AUTH_TOKEN / WHATSAPP_FROM" },
      { status: 503 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as SendNudgeBody;

  const supabase = supabaseServer();
  const { data: row, error } = await supabase
    .from("lead_cases")
    .select("id, bda_nudge_markdown, bda_nudge_whatsapp_plaintext, bda_whatsapp")
    .eq("id", caseId)
    .single();
  if (error || !row) {
    return NextResponse.json(
      { error: `case not found: ${error?.message ?? "no row"}` },
      { status: 404 }
    );
  }

  const to = body.to ?? (row.bda_whatsapp as string | null) ?? process.env.BDA_WHATSAPP_TO;
  if (!to) {
    return NextResponse.json(
      { error: "no recipient — provide body.to, set lead_cases.bda_whatsapp, or set BDA_WHATSAPP_TO" },
      { status: 400 }
    );
  }

  const md = row.bda_nudge_markdown as string | null;
  if (!md) {
    return NextResponse.json(
      { error: "bda_nudge_markdown missing — run POST /api/cases/[id]/nudge first" },
      { status: 409 }
    );
  }

  const persistedPlaintext = row.bda_nudge_whatsapp_plaintext as string | null;
  let plaintextSource: "override" | "persisted" | "regex_fallback";
  let plaintext: string;
  if (body.override_body) {
    plaintext = body.override_body;
    plaintextSource = "override";
  } else if (persistedPlaintext) {
    plaintext = persistedPlaintext;
    plaintextSource = "persisted";
  } else {
    plaintext = mdToWhatsApp(md);
    plaintextSource = "regex_fallback";
  }

  await log({
    case_id: caseId,
    task_id: "4.4-nudge-send",
    component,
    event: "nudge_plaintext_source",
    payload: { source: plaintextSource, chars: plaintext.length },
  });

  let result;
  try {
    result = await sendWhatsAppText(to, plaintext, { caseId, component });
  } catch (e) {
    return NextResponse.json(
      { error: `twilio send failed: ${String(e).slice(0, 200)}`, case_id: caseId },
      { status: 502 }
    );
  }

  await log({
    case_id: caseId,
    task_id: "4.4-nudge-send",
    component,
    provider: "twilio",
    event: "bda_nudge_sent",
    payload: { sid: result.sid, status: result.status, chars: plaintext.length },
  });

  return NextResponse.json({
    case_id: caseId,
    sid: result.sid,
    status: result.status,
    to: result.to,
    from: result.from,
    chars: plaintext.length,
  });
}
