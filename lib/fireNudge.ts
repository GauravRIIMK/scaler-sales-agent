/**
 * Single-row pre-call nudge fire — shared by:
 *   - the cron tick     (app/api/cron/fire-nudges/route.ts)
 *   - the manual fire   (app/api/leads/[id]/fire-nudge-now/route.ts)
 *
 * Exists in /lib (not a route file) because Next.js App Router rejects
 * non-HTTP-method exports from route.ts files at typecheck time. Both
 * callsites are guaranteed to use the same generation, persistence, and
 * state-transition logic by pulling from here.
 *
 * Behaviour:
 *   - Skip (no state change) if bda_whatsapp is missing or Twilio not
 *     configured. Row stays in 'nudge_scheduled' so the next tick retries.
 *   - On generate or send failure: log ERROR, do NOT change state.
 *   - On success: persist markdown + plaintext + persona_vector + state =
 *     'nudge_sent' + nudge_fired_by stamp.
 *
 * The state transition uses a guard (.eq("state", "nudge_scheduled")) so
 * a cron tick racing a manual button can't double-transition.
 */
import { supabaseServer } from "./supabase";
import { log } from "./log";
import { generatePreCallNudge, type PreCallProfile } from "./preCallNudge";
import { isTwilioConfigured, sendWhatsAppText } from "./twilio";

export interface FireResult {
  case_id: string;
  status: "sent" | "skipped" | "failed";
  error?: string;
  to?: string;
  sid?: string;
  retrieved_chunks?: number;
  archetype?: string;
}

export interface FireOneArgs {
  caseId: string;
  profile: PreCallProfile;
  bdaWhatsapp: string | null;
  language?: string;
  firedBy: "cron" | "manual";
}

export async function fireOne(args: FireOneArgs): Promise<FireResult> {
  const { caseId, profile, bdaWhatsapp, language, firedBy } = args;
  const component = "fire-nudge/fire-one";
  const supabase = supabaseServer();

  if (!bdaWhatsapp) {
    await log({
      case_id: caseId,
      task_id: "fire-nudge",
      component,
      level: "WARN",
      event: "skip_no_bda_whatsapp",
    });
    return { case_id: caseId, status: "skipped", error: "no bda_whatsapp on row" };
  }
  if (!isTwilioConfigured()) {
    await log({
      case_id: caseId,
      task_id: "fire-nudge",
      component,
      level: "WARN",
      event: "skip_twilio_not_configured",
    });
    return { case_id: caseId, status: "skipped", error: "twilio not configured" };
  }

  // 1. Generate the profile-only nudge.
  let nudge;
  try {
    nudge = await generatePreCallNudge({
      profile,
      caseId,
      component,
      language,
    });
  } catch (e) {
    await log({
      case_id: caseId,
      task_id: "fire-nudge",
      component,
      level: "ERROR",
      event: "nudge_generate_failed",
      error_message: String(e).slice(0, 500),
    });
    return { case_id: caseId, status: "failed", error: `generate: ${String(e).slice(0, 180)}` };
  }

  // 2. Persist the artifact BEFORE sending so a flaky Twilio send doesn't
  // cost us the LLM output on retry.
  {
    const { error: persistErr } = await supabase
      .from("lead_cases")
      .update({
        bda_nudge_markdown: nudge.markdown,
        bda_nudge_whatsapp_plaintext: nudge.whatsapp_plaintext,
        persona_vector: nudge.persona,
      })
      .eq("id", caseId);
    if (persistErr) {
      await log({
        case_id: caseId,
        task_id: "fire-nudge",
        component,
        level: "WARN",
        event: "nudge_persist_failed",
        error_message: persistErr.message,
      });
      // continue — we still want to attempt the send
    }
  }

  // 3. Send WhatsApp to the BDA.
  let send;
  try {
    send = await sendWhatsAppText(bdaWhatsapp, nudge.whatsapp_plaintext, {
      caseId,
      component,
    });
  } catch (e) {
    await log({
      case_id: caseId,
      task_id: "fire-nudge",
      component,
      level: "ERROR",
      event: "nudge_send_failed",
      error_message: String(e).slice(0, 500),
    });
    // Bump slice to 500 so the full Twilio remediation message (e.g. for
    // error_code 63015 — "have them text join <sandbox-code> again") is
    // surfaced to the API caller, not just the first 180 chars.
    return { case_id: caseId, status: "failed", error: `send: ${String(e).slice(0, 500)}` };
  }

  // 4. Transition state. Guarded update so a cron-vs-manual race can't
  // double-transition.
  //
  // IMPORTANT: do NOT write to `delivery_sid` here. That column is the
  // atomic lock for the lead-facing PDF delivery (see deliver/route.ts —
  // it requires `delivery_sid IS NULL` to begin). The BDA nudge Twilio
  // SID is captured in the `nudge_fired_ok` log event instead.
  const sentAt = new Date().toISOString();
  const { data: updated, error: updErr } = await supabase
    .from("lead_cases")
    .update({
      state: "nudge_sent",
      nudge_sent_at: sentAt,
      nudge_fired_by: firedBy,
    })
    .eq("id", caseId)
    .eq("state", "nudge_scheduled")
    .select("id, state")
    .single();

  if (updErr || !updated) {
    await log({
      case_id: caseId,
      task_id: "fire-nudge",
      component,
      level: "WARN",
      event: "nudge_state_transition_skipped",
      error_message: updErr?.message ?? "row no longer in nudge_scheduled",
    });
  }

  await log({
    case_id: caseId,
    task_id: "fire-nudge",
    component,
    event: "nudge_fired_ok",
    payload: {
      sid: send.sid,
      to: send.to,
      fired_by: firedBy,
      retrieved_chunks: nudge.retrieved_chunk_count,
      archetype: nudge.persona.archetype_label,
      degraded: nudge.degraded,
    },
  });

  return {
    case_id: caseId,
    status: "sent",
    to: send.to,
    sid: send.sid,
    retrieved_chunks: nudge.retrieved_chunk_count,
    archetype: nudge.persona.archetype_label,
  };
}
