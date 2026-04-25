/**
 * Task 4.1 route — POST /api/cases/[id]/deliver
 *
 * Sends the verified PDF + covering message to the lead on WhatsApp. Only
 * callable after the BDA approve/edit/skip gate (case must be in state
 * 'approved' or 'edited'). 'skipped' is terminal and returns 409.
 *
 * Preconditions:
 *   - pdf_url present (Task 3.4c already ran)
 *   - covering_msg present (may have been edited via bda_edits → lead_cases)
 *   - evaluator_phone present on the case OR overridden via body { to }
 *
 * The send emits to Twilio; statusCallback→ /api/twilio/status will finalise
 * the delivery_events timeline (Task 4.3).
 */
import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase";
import { log } from "@/lib/log";
import { isTwilioConfigured, sendWhatsAppWithMedia } from "@/lib/twilio";
import { requireBdaCode } from "@/lib/bdaAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface DeliverBody {
  to?: string;
  override_body?: string;
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const caseId = params.id;
  const component = "deliver";
  if (!caseId) return NextResponse.json({ error: "missing case id" }, { status: 400 });

  const authErr = requireBdaCode(req, caseId);
  if (authErr) return authErr;

  if (!isTwilioConfigured()) {
    return NextResponse.json(
      { error: "Twilio not configured — set TWILIO_ACCOUNT_SID / AUTH_TOKEN / WHATSAPP_FROM" },
      { status: 503 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as DeliverBody;
  const supabase = supabaseServer();

  const { data: row, error } = await supabase
    .from("lead_cases")
    .select("id, evaluator_phone, pdf_url, covering_msg, state, lead_profile")
    .eq("id", caseId)
    .single();
  if (error || !row) {
    return NextResponse.json(
      { error: `case not found: ${error?.message ?? "no row"}` },
      { status: 404 }
    );
  }

  if (!row.pdf_url) {
    return NextResponse.json(
      { error: "pdf_url missing — run POST /api/cases/[id]/pdf first" },
      { status: 409 }
    );
  }
  if (row.state === "skipped") {
    return NextResponse.json({ error: "case was skipped by the BDA" }, { status: 409 });
  }
  if (row.state === "awaiting_approval") {
    return NextResponse.json(
      {
        error:
          "case is still awaiting BDA approval — approve or edit it first via POST /api/cases/[id]/decision",
        case_id: caseId,
        state: row.state,
      },
      { status: 409 }
    );
  }
  if (row.state !== "approved" && row.state !== "edited") {
    return NextResponse.json(
      {
        error: `delivery blocked — state '${row.state}' is not a valid post-approval state`,
        case_id: caseId,
        state: row.state,
      },
      { status: 409 }
    );
  }

  // ── Atomic compare-and-swap guard (Fix 1) ────────────────────────────────
  // "sending" is not in the case_state enum, so we cannot use a transient
  // state value without a migration.  Instead we use the delivery_sid column
  // as a boolean sentinel: we atomically stamp it to "in_flight" only when it
  // is currently NULL.  A concurrent second request will see delivery_sid IS
  // NOT NULL on the row it already loaded (state is still approved/edited) and
  // be blocked by the .is("delivery_sid", null) filter — it gets 0 rows back
  // and returns 409 without calling Twilio.
  // On success the final update overwrites "in_flight" with the real Twilio SID.
  // On failure we clear delivery_sid back to NULL so the case can be retried.
  const originalState = row.state as string; // "approved" | "edited" — for rollback
  const { data: lockRow, error: lockErr } = await supabase
    .from("lead_cases")
    .update({ delivery_sid: "in_flight" })
    .eq("id", caseId)
    .in("state", ["approved", "edited"])
    .is("delivery_sid", null)
    .select("id")
    .maybeSingle();

  if (lockErr || !lockRow) {
    return NextResponse.json(
      {
        error: "another delivery attempt is already in flight or state changed",
        case_id: caseId,
      },
      { status: 409 }
    );
  }

  const to = body.to ?? (row.evaluator_phone as string | null);
  if (!to) {
    return NextResponse.json(
      { error: "no recipient — provide body.to or set lead_cases.evaluator_phone" },
      { status: 400 }
    );
  }

  const firstName =
    (row.lead_profile as { name?: string } | null)?.name?.toString().split(" ")[0] ?? "there";
  const textBody =
    body.override_body ??
    (row.covering_msg as string | null) ??
    `Hi ${firstName}, attaching the personalised brief we put together from our call — sources cited on every page.`;

  let result;
  try {
    result = await sendWhatsAppWithMedia(to, textBody, row.pdf_url as string, {
      caseId,
      component,
    });
  } catch (e) {
    // Roll back the in_flight sentinel so the case can be retried.
    await supabase
      .from("lead_cases")
      .update({ delivery_sid: null })
      .eq("id", caseId)
      .eq("delivery_sid", "in_flight");
    await log({
      case_id: caseId,
      task_id: "4.1-deliver",
      component,
      level: "WARN",
      event: "deliver_in_flight_rollback",
      error_message: `Twilio send failed; rolled delivery_sid back to null. Original state: ${originalState}. Error: ${String(e).slice(0, 200)}`,
    });
    return NextResponse.json(
      { error: `twilio send failed: ${String(e).slice(0, 200)}`, case_id: caseId },
      { status: 502 }
    );
  }

  const { error: updErr } = await supabase
    .from("lead_cases")
    .update({
      state: "delivered",
      delivery_sid: result.sid,
      delivered_at: new Date().toISOString(),
    })
    .eq("id", caseId);
  if (updErr) {
    await log({
      case_id: caseId,
      task_id: "4.1-deliver",
      component,
      level: "WARN",
      event: "deliver_state_persist_failed",
      error_message: updErr.message,
    });
  }

  return NextResponse.json({
    case_id: caseId,
    state: "delivered",
    sid: result.sid,
    status: result.status,
    to: result.to,
    from: result.from,
  });
}
