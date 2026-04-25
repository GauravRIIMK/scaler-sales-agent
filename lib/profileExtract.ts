/**
 * Profile extractor — turns free-text prose (LinkedIn bio, intake notes,
 * call transcript) into a structured LeadProfile via forced tool-use.
 *
 * Follows the exact conventions established in lib/extract.ts:
 *   - claudeMessage / extractToolUse from @/lib/anthropic
 *   - tier: "sonnet" (Sonnet 4.6)
 *   - toolChoice: { type: "tool", name: "..." }
 *   - temperature: 0, maxTokens: 1500
 *   - sanitizeForPrompt on all raw inputs
 *   - log() at _start / _ok / _failed
 */
import { claudeMessage, extractToolUse } from "@/lib/anthropic";
import { log } from "@/lib/log";
import { sanitizeForPrompt } from "@/lib/sanitize";
import type Anthropic from "@anthropic-ai/sdk";

// ─── Public types ────────────────────────────────────────────────────────────

export interface ExtractInput {
  profile_text: string;    // primary source — paragraph(s) describing the lead
  transcript?: string;     // optional — call transcript helps fill gaps
  notes?: string;          // optional — free-form intake notes
  language?: string;       // optional — "en-IN" | "en-US" | "hi" — affects langHint
  caseId?: string;         // optional — for log correlation
}

export interface ExtractedProfile {
  name: string;
  role: string;
  company: string;
  years_experience: number | null;
  location: string;
  education: string;
  budget_range: string;
  goals: string[];
  concerns: string[];
}

export interface ExtractResult {
  profile: ExtractedProfile;
  confidence: "high" | "medium" | "low";
  missing_fields: string[];
  reasoning: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const TOOL_NAME = "extract_lead_profile";
const PROMPT_VERSION = "v1";
const TASK_ID = "profile-extract";
const COMPONENT = "profile_extract";

const CONFIDENCE_ENUM = ["high", "medium", "low"] as const;

const SYSTEM_PROMPT = `You are a sales-intake assistant at Scaler. Extract a structured lead profile from the input the user provides.

Rules:
- Never invent specific facts (numbers, employers, certifications, school names, salary figures) that are not present in the input. Leave that field empty and add its name to missing_fields.
- Inferences from context are allowed (e.g. "wants AI roles" from "I want to work on LLMs") but you must downgrade confidence to "medium" or "low" whenever you infer rather than read literally.
- goals and concerns: 1-5 short bullet phrases each, each under 100 characters. If none are derivable, return an empty array.
- years_experience: derive from graduation year, employment history, or explicit mention. Return null — not 0 — when not derivable. Students with no work experience = 0.
- budget_range: express as a range or descriptor (e.g. "INR 3-5L", "price-sensitive", "not a constraint"). Empty string if not derivable.
- Output via the ${TOOL_NAME} tool. Do not write prose.`;

// ─── Tool definition ─────────────────────────────────────────────────────────

function profileTool(): Anthropic.Tool {
  return {
    name: TOOL_NAME,
    description: "Extract a structured lead profile from the supplied text.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Full name. Empty string if not stated.",
        },
        role: {
          type: "string",
          description: "Current job title. Empty string if not stated.",
        },
        company: {
          type: "string",
          description: "Current employer. Empty string if not stated.",
        },
        years_experience: {
          type: ["integer", "null"],
          description:
            "Years of professional experience. Null if not derivable. Students = 0.",
        },
        location: {
          type: "string",
          description: "City or city, country. Empty string if not stated.",
        },
        education: {
          type: "string",
          description:
            "Highest degree + institution + year if available. Empty string if not stated.",
        },
        budget_range: {
          type: "string",
          description:
            "e.g. 'INR 3-5L', 'price-sensitive', 'not a constraint'. Empty string if not derivable.",
        },
        goals: {
          type: "array",
          items: { type: "string" },
          description:
            "1-5 short bullet phrases of what the lead wants from the program. Each <100 chars.",
        },
        concerns: {
          type: "array",
          items: { type: "string" },
          description:
            "1-5 short bullet phrases of objections, blockers, or anxieties. Each <100 chars.",
        },
        confidence: {
          type: "string",
          enum: ["high", "medium", "low"],
          description: "Self-assessed confidence in the extracted profile.",
        },
        missing_fields: {
          type: "array",
          items: { type: "string" },
          description:
            "List of field names where input was sparse — used downstream to flag for human review.",
        },
        reasoning: {
          type: "string",
          description: "1-2 sentences on what was inferred vs literal.",
        },
      },
      required: [
        "name",
        "role",
        "company",
        "years_experience",
        "location",
        "education",
        "budget_range",
        "goals",
        "concerns",
        "confidence",
        "missing_fields",
        "reasoning",
      ],
    },
  };
}

// ─── Fallback result ──────────────────────────────────────────────────────────

function fallbackResult(): ExtractResult {
  return {
    profile: {
      name: "",
      role: "",
      company: "",
      years_experience: null,
      location: "",
      education: "",
      budget_range: "",
      goals: [],
      concerns: [],
    },
    confidence: "low",
    missing_fields: ["all"],
    reasoning: "Extraction failed — model returned no tool call.",
  };
}

// ─── Main exported function ───────────────────────────────────────────────────

export async function extractProfile(input: ExtractInput): Promise<ExtractResult> {
  // Sanitise all raw inputs before interpolation.
  const safeProfileText = sanitizeForPrompt(input.profile_text, { maxChars: 8000 });
  const safeTranscript = input.transcript
    ? sanitizeForPrompt(input.transcript, { maxChars: 24000 })
    : undefined;
  const safeNotes = input.notes
    ? sanitizeForPrompt(input.notes, { maxChars: 4000 })
    : undefined;

  await log({
    case_id: input.caseId,
    task_id: TASK_ID,
    component: COMPONENT,
    event: "profile_extract_start",
    payload: {
      profile_text_len: safeProfileText.length,
      has_transcript: !!safeTranscript,
      has_notes: !!safeNotes,
      language: input.language ?? null,
    },
  });

  // Build user message with clear section headers.
  const sections: string[] = [];
  sections.push(`## Profile text\n${safeProfileText}`);
  if (safeTranscript) {
    sections.push(`## Call transcript (optional)\n${safeTranscript}`);
  }
  if (safeNotes) {
    sections.push(`## Intake notes (optional)\n${safeNotes}`);
  }

  const langHint = input.language
    ? `\nLanguage hint: ${sanitizeForPrompt(input.language, { maxChars: 20 })}`
    : "";

  const userContent = sections.join("\n\n") + langHint;

  let msg: Anthropic.Message;
  try {
    msg = await claudeMessage({
      tier: "sonnet",
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
      tools: [profileTool()],
      toolChoice: { type: "tool", name: TOOL_NAME },
      temperature: 0,
      maxTokens: 1500,
      caseId: input.caseId,
      taskId: TASK_ID,
      component: COMPONENT,
      promptVersion: PROMPT_VERSION,
    });
  } catch (e) {
    // 5xx from Anthropic — throw, let the caller decide.
    await log({
      case_id: input.caseId,
      task_id: TASK_ID,
      component: COMPONENT,
      level: "ERROR",
      event: "profile_extract_failed",
      error_message: String(e).slice(0, 500),
    });
    throw e;
  }

  type RawToolOutput = {
    name: string;
    role: string;
    company: string;
    years_experience: number | null;
    location: string;
    education: string;
    budget_range: string;
    goals: string[];
    concerns: string[];
    confidence: string;
    missing_fields: string[];
    reasoning: string;
  };

  const raw = extractToolUse<RawToolOutput>(msg, TOOL_NAME);

  if (!raw) {
    await log({
      case_id: input.caseId,
      task_id: TASK_ID,
      component: COMPONENT,
      level: "WARN",
      event: "profile_extract_no_tool_call",
    });
    return fallbackResult();
  }

  // Defensive coercion — match the pattern from extract.ts.
  const yeExp = raw.years_experience == null ? null : Number(raw.years_experience);
  const confidence: "high" | "medium" | "low" = CONFIDENCE_ENUM.includes(
    raw.confidence as "high" | "medium" | "low"
  )
    ? (raw.confidence as "high" | "medium" | "low")
    : "low";

  const result: ExtractResult = {
    profile: {
      name: String(raw.name ?? ""),
      role: String(raw.role ?? ""),
      company: String(raw.company ?? ""),
      years_experience: yeExp !== null && !isNaN(yeExp) ? yeExp : null,
      location: String(raw.location ?? ""),
      education: String(raw.education ?? ""),
      budget_range: String(raw.budget_range ?? ""),
      goals: Array.isArray(raw.goals)
        ? raw.goals.map((g) => String(g).slice(0, 100))
        : [],
      concerns: Array.isArray(raw.concerns)
        ? raw.concerns.map((c) => String(c).slice(0, 100))
        : [],
    },
    confidence,
    missing_fields: Array.isArray(raw.missing_fields)
      ? raw.missing_fields.map((f) => String(f))
      : [],
    reasoning: String(raw.reasoning ?? "").slice(0, 500),
  };

  await log({
    case_id: input.caseId,
    task_id: TASK_ID,
    component: COMPONENT,
    event: "profile_extract_ok",
    payload: {
      confidence: result.confidence,
      missing_count: result.missing_fields.length,
      goals_count: result.profile.goals.length,
      concerns_count: result.profile.concerns.length,
    },
  });

  return result;
}
