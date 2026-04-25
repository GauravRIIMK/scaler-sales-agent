/**
 * Pre-call BDA nudge generator — PROFILE-ONLY mode.
 *
 * This module is the assignment-correct path for the Stage-A nudge:
 *   "Sent to the BDA on their own WhatsApp, AHEAD of the call, so they walk
 *    in prepared and the first 30 seconds of the call don't sound generic."
 *   (assignment §1, "Pre-sales WhatsApp nudge to the BDA").
 *
 * At T-1h (or whenever the cron fires) the only thing we have is the lead's
 * CRM form data — no transcript, no extracted questions, no live persona
 * inference grounded in lead utterances. Everything has to be derived from
 * the profile + Scaler.com retrieval over profile-derived queries.
 *
 * Existing lib/nudge.ts ALSO produces a nudge but consumes extracted
 * transcript questions + persona vector inferred from lead utterances. That
 * path silently leaks future data into a pre-call brief — useful as a
 * post-call summary, wrong as a pre-call brief. We keep it for the legacy
 * single-shot pipeline and call THIS module from the cron / manual fire
 * routes.
 *
 * Flow:
 *   1. derive 3-5 retrieval queries from the profile (role/goals/concerns)
 *   2. retrieve top scaler.com chunks for each query, pool + dedupe
 *   3. infer 5-axis persona from the profile alone (existing inferPersona
 *      with empty questions[] and empty transcript — the prompt already
 *      handles "(no questions extracted)" and "(no transcript provided)")
 *   4. call Sonnet with profile + persona + chunks; emit markdown +
 *      ≤1500-char WhatsApp plaintext via the same record_nudge tool
 *
 * Honesty rules carry over: every inferred angle gets "(inferred)", every
 * factual claim about Scaler is grounded in a retrieved chunk.
 */
import { claudeMessage, extractToolUse } from "./anthropic";
import { log } from "./log";
import { sanitizeForPrompt, sanitizeProfile } from "./sanitize";
import type Anthropic from "@anthropic-ai/sdk";
import { retrieveGrounding, formatCitation, type GroundingHit } from "./retrieve";
import { inferPersona, type PersonaVector } from "./persona";

const NUDGE_VERSION = "pre-call-nudge-v1";
const WHATSAPP_CHAR_LIMIT = 1500;
const TOP_CHUNKS_FOR_NUDGE = 4;
const PER_QUERY_TOPK = 3;

const SYSTEM = `You brief Scaler BDAs on a lead BEFORE the call has happened. The BDA is reading this on their phone 2 minutes before dialling — short, scannable, zero corporate tone.

You only have the lead's CRM form data (profile, intent line, LinkedIn fields). No transcript exists yet. You MUST NOT pretend the BDA has spoken to them. Frame everything as preparation: "likely concerns", "expect them to ask", "open with this and see if it lands".

Structure the MARKDOWN nudge in this order (1200-5000 chars total):
1. Who they are — 2 lines of plain English from the profile
2. Persona + why — 1 line, with one supporting profile signal (verbatim quote from the profile JSON if possible)
3. 2-3 angles likely to resonate — each tied to something real in the profile (years of experience, role, intent line, LinkedIn detail). Mark anything you cannot anchor to a profile field with "(inferred)".
4. 2-3 objections to expect + a one-line handle each. These are predictions, not from a real conversation — phrase them that way.
5. Opening hook — 1 line, ready to read aloud
6. Flags — clearly separate ✅ Fact (from profile or cited chunk), ⚠️ Inferred (your prediction), ❌ Missing (CRM field absent)

Strict rules:
- NEVER write "Dear", "Hi team", "Best regards", "Regards", "Sincerely", or any salutation/signoff.
- NEVER pretend the lead has said anything. Use phrasing like "expect them to ask", "likely to push back on", "may surface".
- Mark every inferred claim with the literal tag "(inferred)" immediately after the claim.
- Reference retrieved chunks by their bracketed [url] source when citing a Scaler fact. If no chunks were retrieved, say so in Flags and avoid making program-specific claims.
- Keep bullets one level deep. Short sentences. Second person ("they …") when referring to the lead.

The WHATSAPP plaintext version must be ≤1500 characters, no markdown syntax, no asterisks, no hyphens as bullets.
It must include ALL FIVE of the following sections using these exact labels on their own line:
  Who: <1 line — name, role, company, years exp>
  Hooks: <2 strongest angles, each on its own sub-line starting with a dash>
  Likely objections: <2 predicted objections + a micro-handle for each, one per line as "Obj -> Handle">
  Open with: <the exact opening line the BDA should use verbatim>
  Flag: <high-risk inferred claims or missing data; write "None" if clean>
Keep each section tight. Total must not exceed 1500 chars.`;

function nudgeTool(): Anthropic.Tool {
  return {
    name: "record_nudge",
    description: "Emit the pre-call BDA nudge as markdown (full) + plaintext (≤1500 chars for WhatsApp).",
    input_schema: {
      type: "object",
      properties: {
        markdown: { type: "string", minLength: 1000, maxLength: 5000 },
        whatsapp_plaintext: { type: "string", minLength: 80, maxLength: WHATSAPP_CHAR_LIMIT },
        inferred_angles: {
          type: "array",
          description: "Angles that were marked (inferred) in the markdown body, by 1-based index.",
          items: { type: "integer", minimum: 1 },
        },
        sources_used: {
          type: "array",
          description: "Chunk URLs cited in the markdown body. Empty array is OK if retrieval was empty.",
          items: { type: "string" },
        },
      },
      required: ["markdown", "whatsapp_plaintext", "inferred_angles", "sources_used"],
    },
  };
}

export interface PreCallProfile {
  name?: string;
  role?: string;
  company?: string;
  years_experience?: number;
  current_salary?: string | number;
  location?: string;
  education?: string;
  budget_range?: string;
  goals?: string[];
  concerns?: string[];
  intent?: string;
  linkedin?: string;
  [k: string]: unknown;
}

export interface PreCallNudgeInput {
  profile: PreCallProfile;
  caseId?: string;
  component?: string;
  language?: string;
}

export interface PreCallNudgeResult {
  markdown: string;
  whatsapp_plaintext: string;
  inferred_angles: number[];
  sources_used: string[];
  retrieved_chunk_count: number;
  persona: PersonaVector;
  derived_queries: string[];
  model: "sonnet-4.6" | "haiku-4.5-fallback";
  degraded: boolean;
  char_count_whatsapp: number;
}

/**
 * Derive 3-5 retrieval queries from a profile alone. Uses role + goals if
 * present, falls back to a generic "Scaler programs" query so we always have
 * at least one shot at retrieval. Each query is short, sales-relevant, and
 * worded the way a BDA might phrase it.
 */
export function buildPreCallProfileQueries(profile: PreCallProfile): string[] {
  const queries: string[] = [];
  const role = (profile.role ?? "").toString();
  const company = (profile.company ?? "").toString();
  const yoe = typeof profile.years_experience === "number" ? profile.years_experience : null;
  const goals = Array.isArray(profile.goals) ? profile.goals.slice(0, 3) : [];
  const concerns = Array.isArray(profile.concerns) ? profile.concerns.slice(0, 2) : [];
  const intent = (profile.intent ?? "").toString();

  // Q1: best-fit Scaler program for this role/seniority — the BDA's
  // bedrock pitch.
  if (role || yoe != null) {
    const seniorityHint = yoe == null ? "" : yoe >= 8 ? " for senior engineers" : yoe >= 3 ? " for mid-career engineers" : " for early-career engineers";
    queries.push(
      `Scaler program best fit for ${role || "software engineer"}${seniorityHint}`.slice(0, 200)
    );
  } else {
    queries.push("Scaler Academy program overview eligibility outcomes");
  }

  // Q2-Q3: each top goal becomes a query so the nudge has a citable angle
  // for the lead's stated motivation.
  for (const goal of goals) {
    const g = String(goal).trim();
    if (g.length > 8) {
      queries.push(`Scaler curriculum and outcomes for: ${g}`.slice(0, 200));
    }
    if (queries.length >= 4) break;
  }

  // Q4: the loudest concern if present (cost / placements / curriculum).
  if (concerns.length > 0) {
    const c = String(concerns[0]).trim();
    if (c.length > 8) {
      queries.push(`Scaler answer to objection: ${c}`.slice(0, 200));
    }
  }

  // Q5: intent line — usually a one-liner from the CRM that captures why
  // they raised their hand. Worth retrieving against directly.
  if (intent && intent.length > 8) {
    queries.push(`Scaler match for intent: ${intent}`.slice(0, 200));
  }

  // Backstop: at least one query about Scaler so the prompt isn't naked.
  if (queries.length === 0) {
    queries.push("Scaler Academy AI Engineering curriculum placement");
  }

  // Dedupe (case-insensitive) and cap at 5.
  const seen = new Set<string>();
  return queries
    .filter((q) => {
      const key = q.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);
}

async function poolChunksForProfile(
  queries: string[],
  caseId: string | undefined,
  component: string,
  language: string | undefined
): Promise<GroundingHit[]> {
  const byId = new Map<string, GroundingHit>();
  for (const q of queries) {
    try {
      const r = await retrieveGrounding(q, {
        caseId,
        taskId: "pre-call-nudge",
        component,
        topK: PER_QUERY_TOPK,
        language,
      });
      for (const h of r.hits) {
        const prev = byId.get(h.id);
        if (!prev || prev.rerank_score < h.rerank_score) byId.set(h.id, h);
      }
    } catch (e) {
      await log({
        case_id: caseId,
        task_id: "pre-call-nudge",
        component,
        level: "WARN",
        event: "pre_call_retrieve_query_failed",
        error_message: String(e).slice(0, 500),
        payload: { query: q.slice(0, 200) },
      });
    }
  }
  return [...byId.values()]
    .sort((a, b) => b.rerank_score - a.rerank_score)
    .slice(0, TOP_CHUNKS_FOR_NUDGE);
}

function buildUserPrompt(args: {
  profile: PreCallProfile;
  persona: PersonaVector;
  topChunks: GroundingHit[];
  language?: string;
}): string {
  const { profile, persona, topChunks } = args;
  const safeProfile = sanitizeProfile(profile as Record<string, unknown>);
  const signals = persona.signals.filter(Boolean).slice(0, 5).join(" | ");
  const axes = [
    `career_stage=${persona.career_stage}`,
    `financial_sensitivity=${persona.financial_sensitivity}`,
    `technical_depth=${persona.technical_depth}`,
    `stakeholder_context=${persona.stakeholder_context}`,
    `risk_posture=${persona.risk_posture}`,
  ].join(", ");
  const chunks = topChunks.length
    ? topChunks
        .map(
          (c, i) =>
            `[${i + 1}] ${formatCitation(c)} (rerank=${c.rerank_score.toFixed(2)})\n${sanitizeForPrompt(c.text, { maxChars: 1200 }).slice(0, 600)}`
        )
        .join("\n\n")
    : "(no chunks retrieved — explicitly flag missing program details in Flags and avoid program-specific claims)";
  const langLine = args.language
    ? `Render the WhatsApp plaintext in language: ${args.language}. Use the matching greeting conventions.`
    : "";

  return [
    "## Lead profile (CRM form data only — call has NOT happened yet)",
    JSON.stringify(safeProfile, null, 2),
    "",
    "## Persona inferred from profile alone",
    `archetype = ${persona.archetype_label}`,
    `axes: ${axes}`,
    `signals: ${signals || "(none)"}`,
    persona.degraded ? "persona inferred via regex fallback — treat tentatively" : "",
    "",
    "## Top-ranked Scaler.com chunks (retrieved from queries derived from the profile)",
    chunks,
    "",
    langLine,
    "Call record_nudge with both markdown and whatsapp_plaintext filled in. Remember: this is a PRE-CALL brief. Never imply the lead has spoken yet.",
  ]
    .filter(Boolean)
    .join("\n");
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
  const cut = cleaned.slice(0, WHATSAPP_CHAR_LIMIT - 1);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"));
  return (lastStop > 80 ? cut.slice(0, lastStop + 1) : cut).trimEnd() + "…";
}

async function runOnce(
  tier: "sonnet" | "haiku",
  args: { profile: PreCallProfile; persona: PersonaVector; topChunks: GroundingHit[]; caseId?: string; component: string; language?: string }
): Promise<Omit<PreCallNudgeResult, "persona" | "derived_queries" | "retrieved_chunk_count">> {
  const msg = await claudeMessage({
    tier,
    system: SYSTEM,
    messages: [{ role: "user", content: buildUserPrompt(args) }],
    tools: [nudgeTool()],
    toolChoice: { type: "tool", name: "record_nudge" },
    maxTokens: 2000,
    temperature: 0.2,
    caseId: args.caseId,
    taskId: "pre-call-nudge",
    component: args.component,
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

export async function generatePreCallNudge(input: PreCallNudgeInput): Promise<PreCallNudgeResult> {
  const component = input.component ?? "pre-call-nudge";
  const caseId = input.caseId;
  const profile = input.profile;

  await log({
    case_id: caseId,
    task_id: "pre-call-nudge",
    component,
    event: "pre_call_nudge_start",
    payload: {
      profile_fields: Object.keys(profile).length,
      has_goals: Array.isArray(profile.goals) && profile.goals.length > 0,
      has_concerns: Array.isArray(profile.concerns) && profile.concerns.length > 0,
    },
  });

  // 1. Derive retrieval queries from profile alone.
  const queries = buildPreCallProfileQueries(profile);

  // 2. Retrieve + pool chunks. Empty pool is OK — the prompt handles it.
  const topChunks = await poolChunksForProfile(queries, caseId, component, input.language);

  // 3. Persona inference from profile alone. inferPersona's prompt already
  // accepts empty questions[] / empty transcript and degrades to the regex
  // fallback if the model refuses.
  let persona: PersonaVector;
  try {
    persona = await inferPersona({
      profile,
      questions: [],
      transcript_excerpt: "",
      caseId,
      component: `${component}/persona`,
      language: input.language,
    });
  } catch (e) {
    await log({
      case_id: caseId,
      task_id: "pre-call-nudge",
      component,
      level: "WARN",
      event: "pre_call_persona_failed_using_unknown",
      error_message: String(e).slice(0, 300),
    });
    // Final backstop: an "all unknown" persona so the nudge can still render.
    persona = {
      career_stage: "unknown",
      financial_sensitivity: "unknown",
      technical_depth: "unknown",
      stakeholder_context: "unknown",
      risk_posture: "unknown",
      axis_confidences: {
        career_stage: 0,
        financial_sensitivity: 0,
        technical_depth: 0,
        stakeholder_context: 0,
        risk_posture: 0,
      },
      archetype_label: "uncertain-lead",
      signals: [],
      degraded: true,
      model: "fallback-empty",
    };
  }

  // 4. Generate. Sonnet first, Haiku fallback.
  let inner;
  try {
    inner = await runOnce("sonnet", {
      profile,
      persona,
      topChunks,
      caseId,
      component,
      language: input.language,
    });
  } catch (e) {
    await log({
      case_id: caseId,
      task_id: "pre-call-nudge",
      component,
      level: "WARN",
      event: "pre_call_sonnet_failed_falling_back_haiku",
      error_message: String(e).slice(0, 500),
    });
    inner = await runOnce("haiku", {
      profile,
      persona,
      topChunks,
      caseId,
      component,
      language: input.language,
    });
  }

  await log({
    case_id: caseId,
    task_id: "pre-call-nudge",
    component,
    event: "pre_call_nudge_ok",
    payload: {
      model: inner.model,
      md_chars: inner.markdown.length,
      wa_chars: inner.char_count_whatsapp,
      sources_used: inner.sources_used.length,
      inferred_angles: inner.inferred_angles.length,
      retrieved_chunk_count: topChunks.length,
      derived_query_count: queries.length,
      persona_archetype: persona.archetype_label,
      persona_degraded: persona.degraded,
    },
  });

  return {
    ...inner,
    persona,
    derived_queries: queries,
    retrieved_chunk_count: topChunks.length,
  };
}
