/**
 * Task 2.3 — two-pass concern → question extractor (BLUEPRINT §3.2 Q3).
 *
 *   Pass 1 (Haiku):   transcript turns → concerns[] (stated + implicit, LEAD-only)
 *   Pass 2 (Sonnet):  concerns[] → retrievable questions with evidence_type
 *   Fallback (Haiku): if Sonnet 5xx, Haiku re-frames with a simpler schema
 *
 * The point of two passes is to surface implicit doubt like
 *   "the math doesn't work" → "Realistic salary-jump ROI analysis for mid-career TCS SDE"
 * that a single-pass extractor would miss entirely.
 *
 * Output conforms to the DB enum types in 0001_init.sql (concern_type, evidence_type).
 */
import { claudeMessage, extractToolUse } from "./anthropic";
import { log } from "./log";
import { sanitizeForPrompt } from "./sanitize";
import type Anthropic from "@anthropic-ai/sdk";

export type ConcernType =
  | "cost"
  | "outcome"
  | "curriculum"
  | "timeline"
  | "credibility"
  | "placement"
  | "prereq"
  | "format"
  | "refund"
  | "logistics"
  | "other";

export type EvidenceType =
  | "factual"
  | "anecdotal"
  | "comparative"
  | "policy"
  | "unknown";

export type SpeakerLabel = "LEAD" | "BDA" | "UNKNOWN";

export interface Turn {
  idx: number;
  speaker: SpeakerLabel;
  start?: number;
  end?: number;
  text: string;
}

export interface Concern {
  turn_idx: number;
  span: [number, number];
  text_excerpt: string;
  concern_type: ConcernType;
  is_stated: boolean;
  speaker_hint: SpeakerLabel;
}

export interface ExtractedQuestion {
  question_rewritten: string;
  concern_type: ConcernType;
  evidence_type: EvidenceType;
  source_turn_idx: number;
  source_span: [number, number];
  is_stated: boolean;
  text_excerpt: string;
}

export interface ExtractResult {
  questions: ExtractedQuestion[];
  concerns_raw: Concern[];
  degraded: boolean;
  pass1_model: string;
  pass2_model: string;
}

const CONCERN_ENUM: ConcernType[] = [
  "cost",
  "outcome",
  "curriculum",
  "timeline",
  "credibility",
  "placement",
  "prereq",
  "format",
  "refund",
  "logistics",
  "other",
];

const EVIDENCE_ENUM: EvidenceType[] = [
  "factual",
  "anecdotal",
  "comparative",
  "policy",
  "unknown",
];

const EXTRACTOR_VERSION = "extract-2.3-v1";

const PASS1_SYSTEM = `You are a sales-conversation analyst at Scaler. Your job is to read the LEAD side of a conversation and surface concerns — explicit questions AND implicit doubts — that the post-call PDF must address.

Rules, hard:
- Only the LEAD's turns matter. Ignore BDA/advisor turns completely.
- Stated concerns end in a '?' or are phrased as an ask ("tell me about X").
- Implicit concerns are resistance, confusion, framing anxiety, comparison ("Andrew Ng is free"), or unspoken math ("the ROI doesn't feel right"). These are the high-value extractions.
- Every concern MUST cite turn_idx + [start,end] char offsets in that turn's text.
- Classify concern_type strictly from the enum provided. Use "other" only when nothing fits.
- Do not paraphrase yet — record the raw excerpt.
- Output zero concerns rather than fabricate one. An empty list is a valid answer.

Consolidation (critical for downstream cost and PDF quality):
- Output AT MOST 7 distinct concerns. If the LEAD raised more than 7, prioritise the ones the BDA most needs to address in the follow-up PDF (cost > placement > curriculum/format > timeline > comparison > other).
- Consolidate near-duplicates: if the LEAD raises the same underlying topic twice (e.g. "is 8 hours a week enough?" and "I can't do 15 hours weekly"), merge them into ONE concern with the most representative span — do not list both.
- Anchor every concern to a verbatim LEAD phrase: if you cannot quote a specific span from a LEAD turn that supports the concern, drop it. Inferring topics from product knowledge ("they probably also want to know about X") or from typical sales objections is forbidden — the lead must have actually said something traceable to it.`;

const PASS2_SYSTEM = `You are a research librarian. Given a list of concerns extracted from a sales call, rewrite each as ONE retrievable question we can answer with scaler.com content.

Rules:
- One question per concern, in the LEAD's voice (not "the user wants to know" meta-framing).
- Keep the domain vocabulary the concern used (e.g. preserve "AI Engineering", "14 LPA", specific comparators).
- Assign evidence_type from the enum:
    factual     = answerable with one scaler.com fact (fee, duration, cohort size)
    comparative = "vs X" (Coursera, Andrew Ng, self-study)
    anecdotal   = alumni story / outcome narrative
    policy      = refund, eligibility, guarantee-style
    unknown     = unclear / not answerable from public content
- Preserve the original concern_type; do not re-label.
- Output exactly as many questions as you received concerns. Same order.`;

const FALLBACK_SYSTEM = `You are a sales-conversation analyst. Given a LEAD transcript, output the questions the post-call PDF must answer.
Each question cites its turn_idx. Evidence_type = "factual" when uncertain. Concern_type strict from enum.`;

function pass1Tool(): Anthropic.Tool {
  return {
    name: "record_concerns",
    description: "Record every concern raised by the LEAD, stated or implicit.",
    input_schema: {
      type: "object",
      properties: {
        concerns: {
          type: "array",
          items: {
            type: "object",
            properties: {
              turn_idx: { type: "integer", minimum: 0 },
              span: {
                type: "array",
                items: { type: "integer", minimum: 0 },
                minItems: 2,
                maxItems: 2,
              },
              text_excerpt: { type: "string", maxLength: 400 },
              concern_type: { type: "string", enum: CONCERN_ENUM },
              is_stated: { type: "boolean" },
              speaker_hint: { type: "string", enum: ["LEAD", "BDA", "UNKNOWN"] },
            },
            required: [
              "turn_idx",
              "span",
              "text_excerpt",
              "concern_type",
              "is_stated",
              "speaker_hint",
            ],
          },
        },
      },
      required: ["concerns"],
    },
  };
}

function pass2Tool(): Anthropic.Tool {
  return {
    name: "record_questions",
    description: "Rewrite each concern into one retrievable question with evidence_type.",
    input_schema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              question_rewritten: { type: "string", maxLength: 300 },
              evidence_type: { type: "string", enum: EVIDENCE_ENUM },
              source_index: { type: "integer", minimum: 0 },
            },
            required: ["question_rewritten", "evidence_type", "source_index"],
          },
        },
      },
      required: ["questions"],
    },
  };
}

function fallbackTool(): Anthropic.Tool {
  return {
    name: "record_questions",
    description: "Single-pass: extract LEAD questions directly with concern + evidence tags.",
    input_schema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              question_rewritten: { type: "string", maxLength: 300 },
              concern_type: { type: "string", enum: CONCERN_ENUM },
              evidence_type: { type: "string", enum: EVIDENCE_ENUM },
              turn_idx: { type: "integer", minimum: 0 },
              span: {
                type: "array",
                items: { type: "integer", minimum: 0 },
                minItems: 2,
                maxItems: 2,
              },
              text_excerpt: { type: "string", maxLength: 400 },
              is_stated: { type: "boolean" },
            },
            required: [
              "question_rewritten",
              "concern_type",
              "evidence_type",
              "turn_idx",
              "span",
              "text_excerpt",
              "is_stated",
            ],
          },
        },
      },
      required: ["questions"],
    },
  };
}

function formatTranscript(turns: Turn[]): string {
  return turns
    .map((t) => {
      const head = `[turn ${t.idx}] [${t.speaker}]`;
      const time = t.start != null && t.end != null ? ` (${t.start.toFixed(1)}–${t.end.toFixed(1)}s)` : "";
      return `${head}${time}\n${t.text}`;
    })
    .join("\n\n");
}

/** Coerce raw text (no diarisation) to a single-LEAD turn. Heuristic only. */
export function rawTextToTurns(raw: string): Turn[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  return [{ idx: 0, speaker: "LEAD", text: trimmed }];
}

/** Split text into sentence-like turns when ``speaker:`` prefix is missing. */
export function parseLooseTranscript(raw: string): Turn[] {
  // Accept any "Name:" or "Name -" prefix. Classify:
  //   bda | advisor | counsellor | counselor | agent | sales | scaler  → BDA
  //   speaker 1 | speaker 2 | s1 | s2                                   → BDA (convention: lower-numbered speaker = advisor)
  //   everything else (including the lead's actual first name)          → LEAD
  // The LEAD's own name is almost never a reserved BDA keyword, so this biases
  // toward keeping their turns. Haiku pass 1 still filters defensively on speaker_hint.
  const labeled = raw
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const prefixRe = /^([A-Za-z][A-Za-z0-9 _.'-]{0,40})\s*[:\-]\s*(.*)$/;
  const BDA_TOKENS = new Set([
    "bda",
    "advisor",
    "counsellor",
    "counselor",
    "agent",
    "sales",
    "scaler",
    "rep",
    "representative",
    "speaker 1",
    "speaker1",
    "s1",
  ]);
  const LEAD_TOKENS = new Set(["lead", "user", "customer", "prospect", "candidate", "speaker 2", "speaker2", "s2"]);

  const hasLabels = labeled.some((l) => prefixRe.test(l));
  if (hasLabels) {
    const out: Turn[] = [];
    labeled.forEach((line, idx) => {
      const m = line.match(prefixRe);
      if (!m) return;
      const token = m[1].trim().toLowerCase();
      const speaker: SpeakerLabel = BDA_TOKENS.has(token)
        ? "BDA"
        : LEAD_TOKENS.has(token)
        ? "LEAD"
        : "LEAD"; // default: any named speaker who isn't the advisor is the lead
      const text = m[2].trim();
      if (text.length > 0) out.push({ idx, speaker, text });
    });
    return out;
  }
  return rawTextToTurns(raw);
}

async function pass1(
  turns: Turn[],
  ctx: { caseId?: string; component: string; language?: string }
): Promise<Concern[]> {
  const langHint = ctx.language ? `\nLanguage hint: ${ctx.language}` : "";
  const msg = await claudeMessage({
    tier: "haiku",
    system: PASS1_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Transcript:\n\n${formatTranscript(turns)}\n\nCall the record_concerns tool. If the LEAD raised nothing, return concerns: [].${langHint}`,
      },
    ],
    tools: [pass1Tool()],
    toolChoice: { type: "tool", name: "record_concerns" },
    temperature: 0,
    maxTokens: 2048,
    caseId: ctx.caseId,
    taskId: "2.3-extract",
    component: ctx.component,
    promptVersion: `${EXTRACTOR_VERSION}-pass1`,
  });
  const out = extractToolUse<{ concerns: Concern[] }>(msg, "record_concerns");
  const raw = out?.concerns ?? [];
  // Drop non-LEAD concerns defensively.
  const leadOnly = raw.filter((c) => c.speaker_hint === "LEAD");
  return leadOnly.map((c) => ({
    turn_idx: c.turn_idx,
    span: [Number(c.span?.[0] ?? 0), Number(c.span?.[1] ?? 0)] as [number, number],
    text_excerpt: String(c.text_excerpt ?? "").slice(0, 400),
    concern_type: CONCERN_ENUM.includes(c.concern_type) ? c.concern_type : "other",
    is_stated: Boolean(c.is_stated),
    speaker_hint: "LEAD",
  }));
}

async function pass2(
  concerns: Concern[],
  ctx: { caseId?: string; component: string; language?: string }
): Promise<ExtractedQuestion[]> {
  if (concerns.length === 0) return [];
  const indexed = concerns.map((c, i) => `[${i}] (${c.concern_type}, ${c.is_stated ? "stated" : "implicit"}) ${c.text_excerpt}`).join("\n");
  const langHint = ctx.language ? `\nLanguage hint: ${ctx.language}` : "";
  const msg = await claudeMessage({
    tier: "sonnet",
    system: PASS2_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Concerns to rewrite:\n\n${indexed}\n\nCall record_questions with one entry per concern, in the same order (source_index = 0..${concerns.length - 1}).${langHint}`,
      },
    ],
    tools: [pass2Tool()],
    toolChoice: { type: "tool", name: "record_questions" },
    temperature: 0,
    maxTokens: 2048,
    caseId: ctx.caseId,
    taskId: "2.3-extract",
    component: ctx.component,
    promptVersion: `${EXTRACTOR_VERSION}-pass2`,
  });
  const out = extractToolUse<{
    questions: { question_rewritten: string; evidence_type: EvidenceType; source_index: number }[];
  }>(msg, "record_questions");
  const rewritten = out?.questions ?? [];

  const byIdx = new Map(rewritten.map((q) => [q.source_index, q]));
  return concerns.map((c, i) => {
    const r = byIdx.get(i);
    return {
      question_rewritten: r?.question_rewritten?.trim() || c.text_excerpt,
      concern_type: c.concern_type,
      evidence_type: r?.evidence_type && EVIDENCE_ENUM.includes(r.evidence_type) ? r.evidence_type : "unknown",
      source_turn_idx: c.turn_idx,
      source_span: c.span,
      is_stated: c.is_stated,
      text_excerpt: c.text_excerpt,
    };
  });
}

async function fallbackSinglePass(
  turns: Turn[],
  ctx: { caseId?: string; component: string; language?: string }
): Promise<ExtractedQuestion[]> {
  const langHint = ctx.language ? `\nLanguage hint: ${ctx.language}` : "";
  const msg = await claudeMessage({
    tier: "haiku",
    system: FALLBACK_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Transcript:\n\n${formatTranscript(turns)}\n\nCall record_questions once with every LEAD-originated question.${langHint}`,
      },
    ],
    tools: [fallbackTool()],
    toolChoice: { type: "tool", name: "record_questions" },
    temperature: 0,
    maxTokens: 2048,
    caseId: ctx.caseId,
    taskId: "2.3-extract",
    component: ctx.component,
    promptVersion: `${EXTRACTOR_VERSION}-fallback`,
  });
  const out = extractToolUse<{
    questions: {
      question_rewritten: string;
      concern_type: ConcernType;
      evidence_type: EvidenceType;
      turn_idx: number;
      span: [number, number];
      text_excerpt: string;
      is_stated: boolean;
    }[];
  }>(msg, "record_questions");
  const raw = out?.questions ?? [];
  return raw.map((q) => ({
    question_rewritten: String(q.question_rewritten).slice(0, 300),
    concern_type: CONCERN_ENUM.includes(q.concern_type) ? q.concern_type : "other",
    evidence_type: EVIDENCE_ENUM.includes(q.evidence_type) ? q.evidence_type : "unknown",
    source_turn_idx: Number(q.turn_idx ?? 0),
    source_span: [Number(q.span?.[0] ?? 0), Number(q.span?.[1] ?? 0)] as [number, number],
    is_stated: Boolean(q.is_stated),
    text_excerpt: String(q.text_excerpt ?? "").slice(0, 400),
  }));
}

export interface ExtractOpts {
  caseId?: string;
  component?: string;
  language?: string;
}

/**
 * Run the two-pass extractor. If Sonnet pass 2 throws, we degrade to the
 * single-pass Haiku fallback and mark the result `degraded: true`.
 */
export async function extractQuestions(
  turnsOrText: Turn[] | string,
  opts: ExtractOpts = {}
): Promise<ExtractResult> {
  const component = opts.component ?? "extract";
  const turns = typeof turnsOrText === "string" ? parseLooseTranscript(turnsOrText) : turnsOrText;

  // Sanitise each turn's text before interpolating into LLM prompts.
  const safeTurns = turns.map((t) => ({ ...t, text: sanitizeForPrompt(t.text, { maxChars: 6000 }) }));

  await log({
    case_id: opts.caseId,
    task_id: "2.3-extract",
    component,
    event: "extract_start",
    payload: { turn_count: safeTurns.length, lead_turns: safeTurns.filter((t) => t.speaker === "LEAD").length, language: opts.language ?? null },
  });

  if (safeTurns.length === 0) {
    return {
      questions: [],
      concerns_raw: [],
      degraded: false,
      pass1_model: "haiku",
      pass2_model: "sonnet",
    };
  }

  let concerns: Concern[] = [];
  try {
    concerns = await pass1(safeTurns, { caseId: opts.caseId, component, language: opts.language });
    await log({
      case_id: opts.caseId,
      task_id: "2.3-extract",
      component,
      event: "extract_pass1_ok",
      payload: { concern_count: concerns.length },
    });
  } catch (e) {
    await log({
      case_id: opts.caseId,
      task_id: "2.3-extract",
      component,
      level: "ERROR",
      event: "extract_pass1_failed",
      error_message: String(e).slice(0, 500),
    });
    throw e; // pass 1 failure is fatal — fallback still needs a Haiku call
  }

  try {
    const questions = await pass2(concerns, { caseId: opts.caseId, component, language: opts.language });
    await log({
      case_id: opts.caseId,
      task_id: "2.3-extract",
      component,
      event: "extract_pass2_ok",
      payload: { question_count: questions.length },
    });
    return { questions, concerns_raw: concerns, degraded: false, pass1_model: "haiku", pass2_model: "sonnet" };
  } catch (e) {
    await log({
      case_id: opts.caseId,
      task_id: "2.3-extract",
      component,
      level: "WARN",
      event: "extract_pass2_failed_falling_back",
      error_message: String(e).slice(0, 500),
    });
    const questions = await fallbackSinglePass(safeTurns, { caseId: opts.caseId, component, language: opts.language });
    await log({
      case_id: opts.caseId,
      task_id: "2.3-extract",
      component,
      event: "extract_fallback_ok",
      payload: { question_count: questions.length },
    });
    return {
      questions,
      concerns_raw: concerns,
      degraded: true,
      pass1_model: "haiku",
      pass2_model: "haiku-fallback",
    };
  }
}
