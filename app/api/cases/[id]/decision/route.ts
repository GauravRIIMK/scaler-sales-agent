/**
 * Task 4.2 route — POST /api/cases/[id]/decision
 *
 * BDA Approve/Edit/Skip gate. Body:
 *   { action: "approved" | "edited" | "skipped",
 *     covering_msg_after?: string,
 *     section_edits?: Array<{ section_idx: number, patch: string, reason?: string }>,
 *     bda_identifier?: string }
 *
 * Inserts a row in bda_edits, updates lead_cases.state + covering_msg.
 * Does NOT send WhatsApp; /api/cases/[id]/deliver is called separately so
 * the UI can confirm before the outbound message leaves.
 *
 * Approved with no edits is still recorded (for analytics on BDA trust).
 */
import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase";
import { log } from "@/lib/log";
import { requireBdaCode } from "@/lib/bdaAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Action = "approved" | "edited" | "skipped";

interface SectionEdit {
  section_idx: number;
  patch: string;
  reason?: string;
}

interface DecisionBody {
  action?: Action;
  covering_msg_after?: string;
  section_edits?: SectionEdit[];
  bda_identifier?: string;
}

const VALID: Action[] = ["approved", "edited", "skipped"];

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const caseId = params.id;
  const component = "decision";
  if (!caseId) return NextResponse.json({ error: "missing case id" }, { status: 400 });

  const authErr = requireBdaCode(req, caseId);
  if (authErr) return authErr;

  const body = (await req.json().catch(() => null)) as DecisionBody | null;
  if (!body || !body.action) return NextResponse.json({ error: "action required" }, { status: 400 });
  if (!VALID.includes(body.action)) {
    return NextResponse.json(
      { error: `invalid action; must be one of ${VALID.join(", ")}` },
      { status: 400 }
    );
  }

  const supabase = supabaseServer();

  const { data: row, error } = await supabase
    .from("lead_cases")
    .select("id, covering_msg, state")
    .eq("id", caseId)
    .single();
  if (error || !row) {
    return NextResponse.json(
      { error: `case not found: ${error?.message ?? "no row"}` },
      { status: 404 }
    );
  }

  if (row.state === "delivered") {
    return NextResponse.json(
      { error: "case already delivered — decisions are locked" },
      { status: 409 }
    );
  }

  const before = (row.covering_msg as string | null) ?? null;
  const after =
    body.action === "skipped"
      ? before
      : body.covering_msg_after && body.covering_msg_after.trim().length > 0
      ? body.covering_msg_after.trim()
      : before;

  // 1. Record the edit row.
  const { error: insertErr } = await supabase.from("bda_edits").insert({
    case_id: caseId,
    action: body.action,
    covering_msg_before: before,
    covering_msg_after: after,
    section_edits: body.section_edits ?? [],
    bda_identifier: body.bda_identifier ?? null,
  });
  if (insertErr) {
    await log({
      case_id: caseId,
      task_id: "4.2-decision",
      component,
      level: "ERROR",
      event: "bda_edits_insert_failed",
      error_message: insertErr.message,
    });
    return NextResponse.json(
      { error: `bda_edits insert failed: ${insertErr.message}` },
      { status: 500 }
    );
  }

  // 2. Update lead_cases state + bda_decision snapshot + any edited covering_msg.
  const decisionPayload = {
    action: body.action,
    edited_at: new Date().toISOString(),
    bda_identifier: body.bda_identifier ?? null,
    section_edits_count: body.section_edits?.length ?? 0,
  };
  const update: Record<string, unknown> = {
    state: body.action,
    bda_decision: decisionPayload,
  };
  if (after && after !== before) update.covering_msg = after;

  const { error: updateErr } = await supabase.from("lead_cases").update(update).eq("id", caseId);
  if (updateErr) {
    await log({
      case_id: caseId,
      task_id: "4.2-decision",
      component,
      level: "ERROR",
      event: "lead_cases_state_update_failed",
      error_message: updateErr.message,
    });
    return NextResponse.json(
      { error: `state update failed: ${updateErr.message}` },
      { status: 500 }
    );
  }

  await log({
    case_id: caseId,
    task_id: "4.2-decision",
    component,
    event: "bda_decision_recorded",
    payload: {
      action: body.action,
      section_edits: body.section_edits?.length ?? 0,
      covering_msg_changed: (after ?? "") !== (before ?? ""),
    },
  });

  return NextResponse.json({
    case_id: caseId,
    state: body.action,
    covering_msg: after,
    section_edits_count: body.section_edits?.length ?? 0,
  });
}
