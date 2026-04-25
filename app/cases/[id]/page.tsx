/**
 * Task 4.2 — BDA approval UI for a single case.
 *
 * Server component reads the case + any prior edits from Supabase, then
 * hands off to the client component for the Approve / Edit / Skip actions
 * (which POST to /api/cases/[id]/decision, then /api/cases/[id]/pdf, then
 * /api/cases/[id]/deliver when confirmed).
 */
import { notFound } from "next/navigation";
import { supabaseServer } from "@/lib/supabase";
import type { PDFContent, PDFSection } from "@/lib/pdfContent";
import type { PersonaVector } from "@/lib/persona";
import type { ExtractedQuestion } from "@/lib/extract";
import { ApprovalPanel } from "./ApprovalPanel";
import { PostCallPanel } from "./PostCallPanel";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface CaseRow {
  id: string;
  evaluator_phone: string | null;
  bda_whatsapp: string | null;
  bda_name: string | null;
  scheduled_call_at: string | null;
  nudge_sent_at: string | null;
  nudge_fired_by: string | null;
  bda_nudge_whatsapp_plaintext: string | null;
  audio_blob_url: string | null;
  lead_profile: Record<string, unknown> | null;
  transcript_text: string | null;
  extracted_questions: ExtractedQuestion[] | null;
  persona_vector: PersonaVector | null;
  pdf_content: PDFContent | null;
  covering_msg: string | null;
  pdf_url: string | null;
  bda_nudge_markdown: string | null;
  state: string;
  delivery_sid: string | null;
  created_at: string;
  delivered_at: string | null;
}

async function loadCase(id: string): Promise<CaseRow | null> {
  const supabase = supabaseServer();
  const { data, error } = await supabase
    .from("lead_cases")
    .select(
      "id, evaluator_phone, bda_whatsapp, bda_name, scheduled_call_at, nudge_sent_at, nudge_fired_by, bda_nudge_whatsapp_plaintext, audio_blob_url, lead_profile, transcript_text, extracted_questions, persona_vector, pdf_content, covering_msg, pdf_url, bda_nudge_markdown, state, delivery_sid, created_at, delivered_at"
    )
    .eq("id", id)
    .single();
  if (error || !data) return null;
  return data as unknown as CaseRow;
}

function Badge({ state }: { state: string }) {
  const palette: Record<string, string> = {
    nudge_scheduled: "bg-violet-100 text-violet-800",
    nudge_sent: "bg-indigo-100 text-indigo-800",
    received: "bg-slate-200 text-slate-800",
    transcribing: "bg-slate-200 text-slate-800",
    questions_extracted: "bg-sky-100 text-sky-800",
    persona_inferred: "bg-sky-100 text-sky-800",
    retrieved: "bg-sky-100 text-sky-800",
    generated: "bg-amber-100 text-amber-800",
    verified: "bg-amber-100 text-amber-800",
    awaiting_approval: "bg-amber-100 text-amber-800",
    approved: "bg-emerald-100 text-emerald-800",
    edited: "bg-emerald-100 text-emerald-800",
    delivered: "bg-emerald-200 text-emerald-900",
    skipped: "bg-rose-100 text-rose-800",
    failed: "bg-rose-200 text-rose-900",
  };
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${
        palette[state] ?? "bg-slate-200 text-slate-800"
      }`}
    >
      {state}
    </span>
  );
}

function PersonaChip({ label, value, conf }: { label: string; value: string; conf?: number }) {
  const soft = conf != null && conf < 0.6;
  return (
    <div
      className={`rounded border px-2 py-1 text-xs ${
        soft ? "border-dashed border-slate-300 text-slate-500" : "border-slate-300 text-slate-800"
      }`}
    >
      <span className="font-semibold">{label}:</span> {value}
      {conf != null ? <span className="ml-1 text-slate-400">({(conf * 100).toFixed(0)}%)</span> : null}
    </div>
  );
}

function StepBanner({ state }: { state: string }) {
  // Special-case states that suppress the step list entirely
  if (state === "failed") {
    return (
      <section className="mb-6 rounded-xl border border-rose-300 bg-rose-50 px-4 py-3">
        <p className="text-sm font-medium text-rose-800">
          Generation failed — see console for details
        </p>
      </section>
    );
  }

  if (state === "skipped") {
    return (
      <section className="mb-6 rounded-xl border border-slate-300 bg-slate-100 px-4 py-3">
        <p className="text-sm font-medium text-slate-700">
          BDA skipped this case — nothing was sent
        </p>
      </section>
    );
  }

  // Two-stage flow steps:
  //   step0 = Pre-call nudge fired (active while nudge_scheduled; done at nudge_sent+)
  //   step1 = Post-call ingest (active during nudge_sent; done once received+)
  //   step2 = Generate + Review PDF (active during received..awaiting_approval; done at approved+)
  //   step3 = Approve + Send (active at approved/edited; done at delivered)

  const PRE_CALL = new Set(["nudge_scheduled"]);
  const PRE_INGEST = new Set(["nudge_sent"]);
  const PREPARING = new Set([
    "received",
    "transcribing",
    "questions_extracted",
    "persona_inferred",
    "retrieved",
    "generated",
    "verified",
    "awaiting_approval",
  ]);

  const step0Active = PRE_CALL.has(state);
  const step0Done = !PRE_CALL.has(state); // anything past nudge_scheduled means nudge sent

  const step1Active = PRE_INGEST.has(state);
  const step1Done = !PRE_CALL.has(state) && !PRE_INGEST.has(state);

  const step2Active = PREPARING.has(state);
  const step2Done = state === "approved" || state === "edited" || state === "delivered";

  const step3Done = state === "delivered";
  const step3Active = (state === "approved" || state === "edited") && !step3Done;

  function circle(n: number, active: boolean, done: boolean) {
    const base = "flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold shrink-0";
    const cls = done
      ? `${base} bg-emerald-600 text-white`
      : active
      ? `${base} bg-slate-900 text-white`
      : `${base} bg-slate-200 text-slate-400`;
    return (
      <span className={cls} aria-hidden="true">
        {n}
      </span>
    );
  }

  function label(text: string, active: boolean, done: boolean) {
    const cls = done
      ? "text-emerald-700 font-medium"
      : active
      ? "text-slate-900 font-medium"
      : "text-slate-400";
    return <span className={`text-sm ${cls}`}>{text}</span>;
  }

  const arrow = <span className="text-slate-300 text-sm font-light mx-1 shrink-0">{"→"}</span>;

  return (
    <section className="mb-6 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2">
          {circle(1, step0Active, step0Done)}
          {label("Pre-call nudge → BDA", step0Active, step0Done)}
        </div>
        {arrow}
        <div className="flex items-center gap-2">
          {circle(2, step1Active, step1Done)}
          {label("Upload post-call recording", step1Active, step1Done)}
        </div>
        {arrow}
        <div className="flex items-center gap-2">
          {circle(3, step2Active, step2Done)}
          {label("Review generated PDF", step2Active, step2Done)}
        </div>
        {arrow}
        <div className="flex items-center gap-2">
          {circle(4, step3Active, step3Done)}
          {label("Approve + send to lead", step3Active, step3Done)}
        </div>
      </div>
    </section>
  );
}

function SectionPreview({ section }: { section: PDFSection }) {
  return (
    <div className="rounded border border-slate-200 bg-slate-50 p-3">
      <div className="mb-1 flex items-center justify-between">
        <h4 className="text-sm font-semibold">{section.name}</h4>
        <span className="text-xs text-slate-500">
          {section.section_type} · {section.sentences.length} sentences
          {section.refused ? " · refused" : ""}
        </span>
      </div>
      <ul className="space-y-1">
        {section.sentences.map((s, i) => (
          <li key={i} className="text-sm text-slate-700">
            {s.text}
            {s.certainty === "inferred" ? (
              <span className="ml-1 text-xs font-semibold text-amber-700">(inferred)</span>
            ) : null}
            {s.certainty === "refused" ? (
              <span className="ml-1 text-xs italic text-slate-500">(not sourced)</span>
            ) : null}
            {s.chunk_ids.length ? (
              <span className="ml-1 text-xs text-sky-700">[{s.chunk_ids.length} ref]</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default async function CasePage({ params }: { params: { id: string } }) {
  const row = await loadCase(params.id);
  if (!row) return notFound();

  const name = (row.lead_profile?.name as string | undefined) ?? "Unknown lead";
  const role = row.lead_profile?.role as string | undefined;
  const company = row.lead_profile?.company as string | undefined;

  const persona = row.persona_vector;
  const sections = row.pdf_content?.sections ?? [];

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="mb-1 flex items-center gap-2 text-sm text-slate-500">
            <span>Case</span>
            <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{row.id.slice(0, 8)}</code>
            <Badge state={row.state} />
          </div>
          <h1 className="text-2xl font-semibold">{name}</h1>
          {(role || company) && (
            <p className="text-sm text-slate-600">
              {role ?? ""}
              {role && company ? " · " : ""}
              {company ?? ""}
            </p>
          )}
        </div>
        <div className="text-right text-xs text-slate-500">
          Created {new Date(row.created_at).toLocaleString()}
          {row.delivered_at ? (
            <div>Delivered {new Date(row.delivered_at).toLocaleString()}</div>
          ) : null}
        </div>
      </header>

      {persona && (
        <section className="mb-6 rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Persona
          </h2>
          <div className="flex flex-wrap gap-2">
            <PersonaChip
              label="career"
              value={persona.career_stage}
              conf={persona.axis_confidences?.career_stage}
            />
            <PersonaChip
              label="finance"
              value={persona.financial_sensitivity}
              conf={persona.axis_confidences?.financial_sensitivity}
            />
            <PersonaChip
              label="tech"
              value={persona.technical_depth}
              conf={persona.axis_confidences?.technical_depth}
            />
            <PersonaChip
              label="stake"
              value={persona.stakeholder_context}
              conf={persona.axis_confidences?.stakeholder_context}
            />
            <PersonaChip
              label="risk"
              value={persona.risk_posture}
              conf={persona.axis_confidences?.risk_posture}
            />
          </div>
          {persona.archetype_label && (
            <p className="mt-2 text-xs text-slate-500">
              archetype: <span className="font-mono">{persona.archetype_label}</span>
              {persona.degraded ? " · (regex fallback — treat tentatively)" : ""}
            </p>
          )}
        </section>
      )}

      <StepBanner state={row.state} />

      {/* Stage-A summary — visible from nudge_scheduled onward so the BDA can
          confirm what was scheduled / sent without bouncing back to /leads/new. */}
      {(row.scheduled_call_at || row.bda_whatsapp || row.nudge_sent_at) && (
        <section className="mb-6 rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Stage A — pre-call
          </h2>
          <dl className="grid grid-cols-1 gap-y-1 text-xs sm:grid-cols-[10rem_1fr]">
            {row.scheduled_call_at && (
              <>
                <dt className="text-slate-500">Scheduled call</dt>
                <dd className="text-slate-800">
                  {new Date(row.scheduled_call_at).toLocaleString()}
                </dd>
              </>
            )}
            {row.bda_whatsapp && (
              <>
                <dt className="text-slate-500">BDA WhatsApp</dt>
                <dd className="font-mono text-slate-800">
                  {row.bda_whatsapp}
                  {row.bda_name ? <span className="ml-2 text-slate-500">({row.bda_name})</span> : null}
                </dd>
              </>
            )}
            {row.nudge_sent_at && (
              <>
                <dt className="text-slate-500">Nudge sent</dt>
                <dd className="text-slate-800">
                  {new Date(row.nudge_sent_at).toLocaleString()}
                  {row.nudge_fired_by ? (
                    <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">
                      {row.nudge_fired_by}
                    </span>
                  ) : null}
                </dd>
              </>
            )}
          </dl>

          {row.bda_nudge_whatsapp_plaintext && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs font-medium text-slate-600 hover:text-slate-800">
                Show what was sent to the BDA
              </summary>
              <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-3 font-sans text-xs text-slate-800">
                {row.bda_nudge_whatsapp_plaintext}
              </pre>
            </details>
          )}
        </section>
      )}

      {/* Stage-B post-call panel — only renders before /generate has run. Once
          the row is awaiting_approval+ this section disappears and the existing
          ApprovalPanel takes over. */}
      {(["nudge_scheduled", "nudge_sent", "received", "transcribing"].includes(row.state) ||
        row.state === "failed") && (
        <PostCallPanel
          caseId={row.id}
          state={row.state}
          evaluatorPhone={row.evaluator_phone}
          bdaWhatsapp={row.bda_whatsapp}
          hasTranscript={!!row.transcript_text}
          hasAudio={!!row.audio_blob_url}
        />
      )}

      {row.extracted_questions && row.extracted_questions.length > 0 && (
        <section className="mb-6 rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Questions ({row.extracted_questions.length})
          </h2>
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            {row.extracted_questions.map((q, i) => (
              <li key={i}>
                <span className="font-medium">{q.question_rewritten}</span>
                <span className="ml-2 text-xs text-slate-500">
                  {q.concern_type} · {q.evidence_type}
                  {q.is_stated ? "" : " · implicit"}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {sections.length > 0 && (
        <section className="mb-6 rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            PDF sections ({sections.length})
          </h2>
          <div className="space-y-3">
            {sections.map((s, i) => (
              <SectionPreview key={i} section={s} />
            ))}
          </div>
        </section>
      )}

      {row.bda_nudge_markdown && (
        <section className="mb-6 rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            BDA nudge
          </h2>
          <pre className="whitespace-pre-wrap rounded bg-slate-50 p-3 font-sans text-sm text-slate-800">
            {row.bda_nudge_markdown}
          </pre>
        </section>
      )}

      {/* Approval gate — only relevant once we have something to approve.
          In pre-ingest / pre-generate states the PostCallPanel handles things. */}
      {[
        "awaiting_approval",
        "approved",
        "edited",
        "delivered",
        "skipped",
      ].includes(row.state) && (
        <ApprovalPanel
          caseId={row.id}
          initialCoveringMsg={row.covering_msg ?? ""}
          evaluatorPhone={row.evaluator_phone}
          pdfUrl={row.pdf_url}
          currentState={row.state}
        />
      )}
    </main>
  );
}
