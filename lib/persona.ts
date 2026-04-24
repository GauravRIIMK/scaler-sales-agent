/**
 * Task 2.4 — compositional 5-axis persona inferencer (BLUEPRINT §3.1 P3, AT-01).
 *
 * Axes (each with its own DB enum):
 *   career_stage            early | mid | senior | unknown
 *   financial_sensitivity   high  | medium | low | unknown
 *   technical_depth         deep  | moderate | novice | unknown
 *   stakeholder_context     solo  | family-joint | team | unknown
 *   risk_posture            risk-averse | balanced | risk-tolerant | unknown
 *
 * Flow:
 *   Haiku reads {profile, extracted_questions, transcript_excerpt}
 *   → emits each axis with confidence ∈ [0,1] and supporting signal text
 *   → any axis confidence < 0.6 is snapped to "unknown"
 *   → archetype_label is derived DETERMINISTICALLY from the tuple
 *     (no hardcoded 3-class switch anywhere)
 *
 * Fallback: regex keyword classifier runs if Haiku throws; result is flagged
 * degraded: true so downstream reporting can show the amber state.
 */
import { claudeMessage, extractToolUse } from "./anthropic";
import { log } from "./log";
import type Anthropic from "@anthropic-ai/sdk";
import type { ExtractedQuestion } from "./extract";

export type CareerStage = "early" | "mid" | "senior" | "unknown";
export type FinSensitivity = "high" | "medium" | "low" | "unknown";
export type TechDepth = "deep" | "moderate" | "novice" | "unknown";
export type StakeholderCtx = "solo" | "family-joint" | "team" | "unknown";
export type RiskPosture = "risk-averse" | "balanced" | "risk-tolerant" | "unknown";

const CAREER_VALUES: CareerStage[] = ["early", "mid", "senior", "unknown"];
const FIN_VALUES: FinSensitivity[] = ["high", "medium", "low", "unknown"];
const TECH_VALUES: TechDepth[] = ["deep", "moderate", "novice", "unknown"];
const STAKE_VALUES: StakeholderCtx[] = ["solo", "family-joint", "team", "unknown"];
const RISK_VALUES: RiskPosture[] = ["risk-averse", "balanced", "risk-tolerant", "unknown"];

const CONFIDENCE_FLOOR = 0.6;

export interface AxisConfidences {
  career_stage: number;
  financial_sensitivity: number;
  technical_depth: number;
  stakeholder_context: number;
  risk_posture: number;
}

export interface PersonaVector {
  career_stage: CareerStage;
  financial_sensitivity: FinSensitivity;
  technical_depth: TechDepth;
  stakeholder_context: StakeholderCtx;
  risk_posture: RiskPosture;
  axis_confidences: AxisConfidences;
  archetype_label: string;
  signals: string[];
  degraded: boolean;
  model: string;
}

export interface LeadProfile {
  name?: string;
  role?: string;
  company?: string;
  years_experience?: number;
  current_salary?: string | number;
  location?: string;
  education?: string;
  [k: string]: unknown;
}

const SYSTEM = `You are a sales-analyst reading a lead's public profile, the questions they asked, and a transcript excerpt. Output a 5-axis persona vector with PER-AXIS confidence and a short signal quote per axis.

Axes and meanings:
- career_stage: early (< ~3y exp / student) | mid (~3-8y) | senior (~8y+ / staff+) | unknown
- financial_sensitivity: high (asks about EMI, cost burden, household) | medium (asks ROI but can pay) | low (cost not a blocker) | unknown
- technical_depth: deep (fluent in systems/ML specifics) | moderate (dev but not specialist) | novice (new to the domain) | unknown
- stakeholder_context: solo | family-joint (parents, spouse, "household decision") | team (company training) | unknown
- risk_posture: risk-averse (guarantees, refunds) | balanced (asks about placements AND curriculum) | risk-tolerant (already betting on self) | unknown

Hard rules:
- Every axis must return a value + confidence ∈ [0,1] + one signal quote.
- Confidence < 0.6 MUST pair with value "unknown" (we snap post-hoc but be honest).
- NEVER pick a value just because it's plausible for the demographic. No value is better than wrong value.
- Quote signals verbatim from the input; do not paraphrase.`;

function personaTool(): Anthropic.Tool {
  return {
    name: "record_persona",
    description: "Record 5-axis persona inference with per-axis confidence and signal evidence.",
    input_schema: {
      type: "object",
      properties: {
        career_stage: {
          type: "object",
          properties: {
            value: { type: "string", enum: CAREER_VALUES },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            signal: { type: "string", maxLength: 240 },
          },
          required: ["value", "confidence", "signal"],
        },
        financial_sensitivity: {
          type: "object",
          properties: {
            value: { type: "string", enum: FIN_VALUES },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            signal: { type: "string", maxLength: 240 },
          },
          required: ["value", "confidence", "signal"],
        },
        technical_depth: {
          type: "object",
          properties: {
            value: { type: "string", enum: TECH_VALUES },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            signal: { type: "string", maxLength: 240 },
          },
          required: ["value", "confidence", "signal"],
        },
        stakeholder_context: {
          type: "object",
          properties: {
            value: { type: "string", enum: STAKE_VALUES },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            signal: { type: "string", maxLength: 240 },
          },
          required: ["value", "confidence", "signal"],
        },
        risk_posture: {
          type: "object",
          properties: {
            value: { type: "string", enum: RISK_VALUES },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            signal: { type: "string", maxLength: 240 },
          },
          required: ["value", "confidence", "signal"],
        },
      },
      required: [
        "career_stage",
        "financial_sensitivity",
        "technical_depth",
        "stakeholder_context",
        "risk_posture",
      ],
    },
  };
}

interface AxisOutput<V extends string> {
  value: V;
  confidence: number;
  signal: string;
}

interface RawPersona {
  career_stage: AxisOutput<CareerStage>;
  financial_sensitivity: AxisOutput<FinSensitivity>;
  technical_depth: AxisOutput<TechDepth>;
  stakeholder_context: AxisOutput<StakeholderCtx>;
  risk_posture: AxisOutput<RiskPosture>;
}

function clamp01(n: unknown): number {
  const x = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function snap<V extends string>(axis: AxisOutput<V> | undefined, allowed: V[], fallback: V): AxisOutput<V> {
  const conf = clamp01(axis?.confidence);
  const v = axis?.value as V | undefined;
  const value = v && allowed.includes(v) && conf >= CONFIDENCE_FLOOR ? v : fallback;
  return { value, confidence: conf, signal: axis?.signal?.toString?.().slice(0, 240) ?? "" };
}

/**
 * Deterministic archetype label from the axis tuple. Pure function —
 * no hardcoded 3-class switch. Any tuple yields a valid label.
 */
export function deriveArchetype(v: {
  career_stage: CareerStage;
  financial_sensitivity: FinSensitivity;
  technical_depth: TechDepth;
  stakeholder_context: StakeholderCtx;
  risk_posture: RiskPosture;
}): string {
  const parts: string[] = [];
  if (v.career_stage !== "unknown") parts.push(`${v.career_stage}-career`);
  if (v.financial_sensitivity !== "unknown") parts.push(`${v.financial_sensitivity}-fin`);
  if (v.technical_depth !== "unknown") parts.push(`${v.technical_depth}-tech`);
  if (v.stakeholder_context !== "unknown") parts.push(`${v.stakeholder_context}-stakeholder`);
  if (v.risk_posture !== "unknown") parts.push(`${v.risk_posture}-risk`);
  return parts.length > 0 ? parts.join("·") : "uncertain-lead";
}

function buildPrompt(profile: LeadProfile, questions: ExtractedQuestion[], transcriptExcerpt: string): string {
  const prof = JSON.stringify(profile, null, 2);
  const qs =
    questions.length > 0
      ? questions.map((q, i) => `[Q${i}] (${q.concern_type}) ${q.question_rewritten} — excerpt: "${q.text_excerpt}"`).join("\n")
      : "(no questions extracted)";
  const xc = transcriptExcerpt.slice(0, 4000);
  return [
    "## Lead profile",
    prof,
    "",
    "## Extracted questions / concerns",
    qs,
    "",
    "## Transcript excerpt (LEAD lines only — may be truncated)",
    xc || "(no transcript provided)",
    "",
    "Call record_persona with one entry per axis.",
  ].join("\n");
}

/** Regex fallback — conservative, keyword-driven. Flagged degraded. */
export function regexPersona(profile: LeadProfile, questions: ExtractedQuestion[], transcript: string): PersonaVector {
  const hay = [
    JSON.stringify(profile).toLowerCase(),
    questions.map((q) => q.question_rewritten + " " + q.text_excerpt).join(" ").toLowerCase(),
    transcript.toLowerCase(),
  ].join(" \n ");

  // career_stage
  const yoe = typeof profile.years_experience === "number" ? profile.years_experience : null;
  let career: CareerStage = "unknown";
  let careerConf = 0;
  if (yoe != null) {
    if (yoe >= 8) { career = "senior"; careerConf = 0.8; }
    else if (yoe >= 3) { career = "mid"; careerConf = 0.8; }
    else { career = "early"; careerConf = 0.8; }
  } else if (/\bstudent|\bfinal year|\bcollege\b|\b(b\.?tech|bachelor)/i.test(hay)) {
    career = "early"; careerConf = 0.7;
  } else if (/staff|principal|\bvp\b|\bcto\b|\b10\+ years|\b15\+ years/i.test(hay)) {
    career = "senior"; careerConf = 0.7;
  } else if (/sde\s?2|\bsde\s?3|tech lead|\bteam lead\b/i.test(hay)) {
    career = "mid"; careerConf = 0.65;
  }

  // financial_sensitivity
  let fin: FinSensitivity = "unknown";
  let finConf = 0;
  if (/\bemi\b|installment|parents|household|affordab|loan|no.?cost emi/i.test(hay)) {
    fin = "high"; finConf = 0.7;
  } else if (/\broi\b|return on investment|salary.?jump|payback|worth the money/i.test(hay)) {
    fin = "medium"; finConf = 0.65;
  } else if (/\b(company|employer).?sponsor|reimburse|l&d budget/i.test(hay)) {
    fin = "low"; finConf = 0.7;
  }

  // technical_depth
  let tech: TechDepth = "unknown";
  let techConf = 0;
  if (/\brag\b|\bllm\b|\btransformer|agent|fine.?tun|kubernetes|distributed|low.?latency|system design/i.test(hay)) {
    tech = "deep"; techConf = 0.7;
  } else if (/\bsde\b|\bdeveloper|\bengineer|python|javascript|rest api/i.test(hay)) {
    tech = "moderate"; techConf = 0.6;
  } else if (/new to|never coded|no coding|first time|from scratch|non.?tech/i.test(hay)) {
    tech = "novice"; techConf = 0.65;
  }

  // stakeholder_context
  let stake: StakeholderCtx = "unknown";
  let stakeConf = 0;
  if (/my (parents|dad|mom|family|husband|wife|spouse)|household|we need|joint/i.test(hay)) {
    stake = "family-joint"; stakeConf = 0.7;
  } else if (/my (team|manager|company)|employer|l&d|group of us/i.test(hay)) {
    stake = "team"; stakeConf = 0.65;
  } else if (/\bi'(m|ve)\b|\bmyself\b|on my own/i.test(hay)) {
    stake = "solo"; stakeConf = 0.6;
  }

  // risk_posture
  let risk: RiskPosture = "unknown";
  let riskConf = 0;
  if (/guarantee|refund|placement assist|assurance|safe bet|worried/i.test(hay)) {
    risk = "risk-averse"; riskConf = 0.65;
  } else if (/already (quit|resigned|bootstrap|founded|side project)|betting on/i.test(hay)) {
    risk = "risk-tolerant"; riskConf = 0.7;
  } else if (/curriculum|placement|both/i.test(hay)) {
    risk = "balanced"; riskConf = 0.55;
  }

  const snapVal = <V extends string>(val: V, conf: number, fallback: V): V =>
    conf >= CONFIDENCE_FLOOR ? val : fallback;

  const tuple = {
    career_stage: snapVal(career, careerConf, "unknown" as CareerStage),
    financial_sensitivity: snapVal(fin, finConf, "unknown" as FinSensitivity),
    technical_depth: snapVal(tech, techConf, "unknown" as TechDepth),
    stakeholder_context: snapVal(stake, stakeConf, "unknown" as StakeholderCtx),
    risk_posture: snapVal(risk, riskConf, "unknown" as RiskPosture),
  };

  return {
    ...tuple,
    axis_confidences: {
      career_stage: careerConf,
      financial_sensitivity: finConf,
      technical_depth: techConf,
      stakeholder_context: stakeConf,
      risk_posture: riskConf,
    },
    archetype_label: deriveArchetype(tuple),
    signals: ["(regex fallback — no LLM available)"],
    degraded: true,
    model: "regex-keyword-fallback",
  };
}

export interface InferPersonaArgs {
  profile: LeadProfile;
  questions: ExtractedQuestion[];
  transcript_excerpt?: string;
  caseId?: string;
  component?: string;
}

export async function inferPersona(args: InferPersonaArgs): Promise<PersonaVector> {
  const component = args.component ?? "persona";
  const transcript = args.transcript_excerpt ?? "";
  await log({
    case_id: args.caseId,
    task_id: "2.4-persona",
    component,
    event: "persona_infer_start",
    payload: {
      has_transcript: !!transcript,
      question_count: args.questions.length,
    },
  });

  try {
    const msg = await claudeMessage({
      tier: "haiku",
      system: SYSTEM,
      messages: [{ role: "user", content: buildPrompt(args.profile, args.questions, transcript) }],
      tools: [personaTool()],
      toolChoice: { type: "tool", name: "record_persona" },
      temperature: 0,
      maxTokens: 1500,
      caseId: args.caseId,
      taskId: "2.4-persona",
      component,
      promptVersion: "persona-2.4-v1",
    });
    const raw = extractToolUse<RawPersona>(msg, "record_persona");
    if (!raw) throw new Error("persona tool produced no input");

    const career = snap<CareerStage>(raw.career_stage, CAREER_VALUES, "unknown");
    const fin = snap<FinSensitivity>(raw.financial_sensitivity, FIN_VALUES, "unknown");
    const tech = snap<TechDepth>(raw.technical_depth, TECH_VALUES, "unknown");
    const stake = snap<StakeholderCtx>(raw.stakeholder_context, STAKE_VALUES, "unknown");
    const risk = snap<RiskPosture>(raw.risk_posture, RISK_VALUES, "unknown");

    const tuple = {
      career_stage: career.value,
      financial_sensitivity: fin.value,
      technical_depth: tech.value,
      stakeholder_context: stake.value,
      risk_posture: risk.value,
    };
    const knownCount =
      (tuple.career_stage !== "unknown" ? 1 : 0) +
      (tuple.financial_sensitivity !== "unknown" ? 1 : 0) +
      (tuple.technical_depth !== "unknown" ? 1 : 0) +
      (tuple.stakeholder_context !== "unknown" ? 1 : 0) +
      (tuple.risk_posture !== "unknown" ? 1 : 0);

    const signals = [career.signal, fin.signal, tech.signal, stake.signal, risk.signal].filter(
      (s) => s && s.length > 0
    );

    const vector: PersonaVector = {
      ...tuple,
      axis_confidences: {
        career_stage: career.confidence,
        financial_sensitivity: fin.confidence,
        technical_depth: tech.confidence,
        stakeholder_context: stake.confidence,
        risk_posture: risk.confidence,
      },
      archetype_label: deriveArchetype(tuple),
      signals,
      degraded: false,
      model: "haiku-4.5",
    };

    await log({
      case_id: args.caseId,
      task_id: "2.4-persona",
      component,
      event: "persona_infer_ok",
      payload: {
        archetype_label: vector.archetype_label,
        known_axes: knownCount,
        axis_unknown_count: 5 - knownCount,
      },
    });

    return vector;
  } catch (e) {
    await log({
      case_id: args.caseId,
      task_id: "2.4-persona",
      component,
      level: "WARN",
      event: "persona_infer_fallback_regex",
      error_message: String(e).slice(0, 500),
    });
    return regexPersona(args.profile, args.questions, transcript);
  }
}
