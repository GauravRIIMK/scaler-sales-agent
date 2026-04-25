/**
 * Task 3.1 — pre-call BDA nudge generator (BLUEPRINT §2.5.5, R01-R04).
 *
 * Produces both a ~350-word markdown nudge (for the BDA dashboard / Slack)
 * and a ≤1500-char WhatsApp plaintext rendering (for send_text to the BDA's
 * phone) in a single Sonnet call. Falls back to Haiku on 5xx.
 *
 * Tone rule (R03, acceptance criterion): reads like a teammate's WhatsApp.
 *   NO "Dear …", NO "Best regards", NO bullet-in-bullet nesting.
 * Honesty rule (R02): every inferred angle must carry "(inferred)".
 */
import { claudeMessage, extractToolUse } from "./anthropic";
import { log } from "./log";
import { sanitizeForPrompt, sanitizeProfile } from "./sanitize";
import type Anthropic from "@anthropic-ai/sdk";
import type { ExtractedQuestion } from "./extract";
import type { PersonaVector } from "./persona";
import type { GroundingHit } from "./retrieve";
import { formatCitation } from "./retrieve";

const NUDGE_VERSION = "nudge-3.1-v2";
const WHATSAPP_CHAR_LIMIT = 1500;

const SYSTEM = `You brief Scaler BDAs on leads ~2 minutes before the call. Your voice is a teammate's WhatsApp — short, scannable, zero corporate tone.

Structure the MARKDOWN nudge in this order (1200-5000 chars total):
1. Who they are — 2 lines of plain English
2. Persona + why — 1 line with 1 evidence quote
3. 2-3 angles that will resonate — each tied to a real signal (profile, question, persona)
4. 2-3 objections to expect + one-line handle each
5. Opening hook — 1 line, ready to read aloud
6. Flags — what's inferred, what's fact, what's missing

Strict rules:
- NEVER write "Dear", "Hi team", "Best regards", "Regards", "Sincerely", or any salutation/signoff.
- Mark every inferred claim with the literal tag "(inferred)" immediately after the claim.
- If you don't have evidence for an angle, omit it. Do not invent.
- Reference retrieved chunks by their bracketed [url] source when citing a Scaler fact.
- Keep bullets one level deep. Short sentences. Second person ("they …") when referring to the lead.

The WHATSAPP plaintext version must be ≤1500 characters, no markdown syntax, no asterisks, no hyphens as bullets.
It must include ALL FIVE of the following sections using these exact labels on their own line:
  Who: <1 line — name, role, company, years exp>
  Hooks: <2 strongest angles, each on its own sub-line starting with a dash>
  Objections: <2 most likely objections + a micro-handle for each, one per line as "Obj → Handle">
  Open with: <the exact opening line the BDA should use verbatim>
  Flag: <any high-risk inferred claims or missing data; write "None" if clean>
Keep each section tight. Total must not exceed 1500 chars.`;

function nudgeTool(): Anthropic.Tool {
  return {
    name: "record_nudge",
    description: "Emit the BDA nudge as both markdown (full) and plaintext (≤1500 chars for WhatsApp).",
    input_schema: {
      type: "object",
      properties: {
        markdown: { type: "string", minLength: 1200, maxLength: 5000 },
        whatsapp_plaintext: { type: "string", minLength: 80, maxLength: WHATSAPP_CHAR_LIMIT },
        inferred_angles: {
          type: "array",
          description: "Angles that were marked (inferred) in the nudge, by 1-based index.",
          items: { type: "integer", minimum: 1 },
        },
        sources_used: {
          type: "array",
          description: "Chunk URLs or section_path breadcrumbs cited in the markdown body.",
          items: { type: "string" },
        },
      },
      required: ["markdown", "whatsapp_plaintext", "inferred_angles", "sources_used"],
    },
  };
}

export interface LeadProfile {
  name?: string;
  role?: string;
  company?: string;
  years_experience?: number;
  current_salary?: string | number;
  location?: string;
  [k: string]: unknown;
}

export interface NudgeInput {
  profile: LeadProfile;
  questions: ExtractedQuestion[];
  persona: PersonaVector;
  /**
   * Retrieved chunks already filtered to the top ~3 by rerank_score (caller's
   * responsibility to pool + rerank across the question set). Empty list is
   * allowed — the nudge will degrade gracefully with fewer cited facts.
   */
  topChunks: GroundingHit[];
  caseId?: string;
  component?: string;
  language?: string;
}

export interface NudgeResult {
  markdown: string;
  whatsapp_plaintext: string;
  inferred_angles: number[];
  sources_used: string[];
  model: "sonnet-4.6" | "haiku-4.5-fallback";
  degraded: boolean;
  char_count_whatsapp: number;
}

function buildUserPrompt(input: NudgeInput): string {
  const { profile, questions, persona, topChunks } = input;
  const safeProfile = sanitizeProfile(profile as Record<string, unknown>);
  const signals = persona.signals.filter(Boolean).slice(0, 5).join(" | ");
  const axes = [
    `career_stage=${persona.career_stage}`,
    `financial_sensitivity=${persona.financial_sensitivity}`,
    `technical_depth=${persona.technical_depth}`,
    `stakeholder_context=${persona.stakeholder_context}`,
    `risk_posture=${persona.risk_posture}`,
  ].join(", ");
  const qs = questions.length
    ? questions
        .map((q, i) => `Q${i + 1} (${q.concern_type}): ${sanitizeForPrompt(q.question_rewritten, { maxChars: 1200 })}`)
        .join("\n")
    : "(no questions extracted — prefer implicit-objection angles)";
  const chunks = topChunks.length
    ? topChunks
        .map(
          (c, i) =>
            `[${i + 1}] ${formatCitation(c)} (rerank=${c.rerank_score.toFixed(2)})\n${sanitizeForPrompt(c.text, { maxChars: 1200 }).slice(0, 600)}`
        )
        .join("\n\n")
    : "(no chunks passed through refuse threshold — flag in the 'Missing' section)";
  const langLine = input.language
    ? `Render the WhatsApp plaintext in language: ${input.language}. Use the matching greeting conventions.`
    : "";

  return [
    "## Lead profile",
    JSON.stringify(safeProfile, null, 2),
    "",
    "## Persona",
    `archetype = ${persona.archetype_label}`,
    `axes: ${axes}`,
    `signals: ${signals || "(none)"}`,
    persona.degraded ? "persona inferred via regex fallback — treat tentatively" : "",
    "",
    "## Open questions",
    qs,
    "",
    "## Top-ranked grounding chunks",
    chunks,
    "",
    langLine,
    "Call record_nudge with both markdown and whatsapp_plaintext filled in.",
  ]
    .filter(Boolean)
    .join("\n");
}

async function runOnce(tier: "sonnet" | "haiku", input: NudgeInput): Promise<NudgeResult> {
  const msg = await claudeMessage({
    tier,
    system: SYSTEM,
    messages: [{ role: "user", content: buildUserPrompt(input) }],
    tools: [nudgeTool()],
    toolChoice: { type: "tool", name: "record_nudge" },
    maxTokens: 2000,
    temperature: 0.2,
    caseId: input.caseId,
    taskId: "3.1-nudge",
    component: input.component ?? "nudge",
    promptVersion: `${NUDGE_VERSION}-${tier}`,
  });
  const out = extractToolUse<{
    markdown: string;
    whatsapp_plaintext: string;
    inferred_angles: number[];
    sources_used: string[];
  }>(msg, "record_nudge");
  if (!out) throw new Error("record_nudge tool returned no input");

  const md = cleanSalutations(out.markdown);
  const wa = truncateWhatsApp(out.whatsapp_plaintext);

  return {
    markdown: md,
    whatsapp_plaintext: wa,
    inferred_angles: (out.inferred_angles ?? []).map(Number).filter((n) => Number.isFinite(n)),
    sources_used: out.sources_used ?? [],
    model: tier === "sonnet" ? "sonnet-4.6" : "haiku-4.5-fallback",
    degraded: tier === "haiku",
    char_count_whatsapp: wa.length,
  };
}

const SALUTATION_RE = /^(dear|hi team|hey team|hello team|hi there|good (morning|afternoon|evening)).*$/gim;
const SIGNOFF_RE = /^(best regards|regards|sincerely|thanks(,)?$|cheers).*$/gim;

function cleanSalutations(md: string): string {
  return md
    .split("\n")
    .filter((line) => !SALUTATION_RE.test(line.trim()) && !SIGNOFF_RE.test(line.trim()))
    .join("\n")
    .trim();
}

function truncateWhatsApp(s: string): string {
  const cleaned = s.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (cleaned.length <= WHATSAPP_CHAR_LIMIT) return cleaned;
  // Truncate at a sentence boundary to avoid mid-word cut.
  const cut = cleaned.slice(0, WHATSAPP_CHAR_LIMIT - 1);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"));
  return (lastStop > 80 ? cut.slice(0, lastStop + 1) : cut).trimEnd() + "…";
}

export async function generateNudge(input: NudgeInput): Promise<NudgeResult> {
  const component = input.component ?? "nudge";
  await log({
    case_id: input.caseId,
    task_id: "3.1-nudge",
    component,
    event: "nudge_gen_start",
    payload: {
      question_count: input.questions.length,
      chunk_count: input.topChunks.length,
      archetype: input.persona.archetype_label,
    },
  });
  try {
    const res = await runOnce("sonnet", input);
    await log({
      case_id: input.caseId,
      task_id: "3.1-nudge",
      component,
      event: "nudge_gen_ok",
      payload: {
        model: res.model,
        md_chars: res.markdown.length,
        wa_chars: res.char_count_whatsapp,
        sources_used: res.sources_used.length,
        inferred_angles: res.inferred_angles.length,
      },
    });
    return res;
  } catch (e) {
    await log({
      case_id: input.caseId,
      task_id: "3.1-nudge",
      component,
      level: "WARN",
      event: "nudge_sonnet_failed_falling_back_haiku",
      error_message: String(e).slice(0, 500),
    });
    const res = await runOnce("haiku", input);
    await log({
      case_id: input.caseId,
      task_id: "3.1-nudge",
      component,
      event: "nudge_fallback_ok",
      payload: { model: res.model, md_chars: res.markdown.length, wa_chars: res.char_count_whatsapp },
    });
    return res;
  }
}
