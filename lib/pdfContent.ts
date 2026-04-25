/**
 * Task 3.2 — section-wise PDF content generator (BLUEPRINT §2.5.4, §3.3 G2).
 *
 * One Opus call per extracted question. Each call:
 *   - receives its own retrieved chunk bundle (caller supplies, or we pull it)
 *   - returns a single PDFSection with Sentence[] carrying chunk_ids + certainty
 *   - marks sentences refused when retrieval gave no grounding
 *
 * The covering_msg is generated as a final pass over the finished sections.
 *
 * Fallback: Sonnet 4.6 per-section if Opus 5xx. Flagged degraded=true.
 *
 * Downstream: lib/verify.ts applies the three-moat check and drops / rewrites
 * any Sentence that fails grounding. pdfContent.ts ONLY generates — it does
 * not enforce honesty; verify.ts does.
 */
import { claudeMessage, extractToolUse, MODELS, type ModelTier } from "./anthropic";
import { log } from "./log";
import { retrieveGrounding, renderRefusal, type GroundingHit } from "./retrieve";
import { sanitizeForPrompt, sanitizeProfile } from "./sanitize";
import type Anthropic from "@anthropic-ai/sdk";
import type { ExtractedQuestion } from "./extract";
import type { PersonaVector } from "./persona";

const PDF_VERSION = "pdf-content-3.2-v1";

// ---------------------------------------------------------------------------
// Fix 6 — Rupee glyph sanitization.
// @react-pdf/renderer's fontkit maps U+20B9 (₹) to U+00B9 (¹) when using
// bundled Inter v20. Replace at string level before any content reaches the
// PDF renderer so "₹3.5 lakhs" renders as "Rs 3.5 lakhs" rather than "¹3.5 lakhs".
// ---------------------------------------------------------------------------
function sanitizeRupee(s: string): string {
  return s.replace(/\u20B9/g, "Rs ").replace(/₹/g, "Rs ");
}

function sanitizeSections(sections: PDFSection[]): PDFSection[] {
  return sections.map((sec) => ({
    ...sec,
    name: sanitizeRupee(sec.name),
    sentences: sec.sentences.map((sent) => ({
      ...sent,
      text: sanitizeRupee(sent.text),
    })),
  }));
}

export type Certainty = "fact" | "inferred" | "refused";

export interface Sentence {
  text: string;
  chunk_ids: string[];
  certainty: Certainty;
  verifier_score?: number | null;
}

export interface PDFSection {
  name: string;
  section_type: string; // concern_type from the source question
  sentences: Sentence[];
  refused: boolean;
  source_question_idx: number;
  chunks_cited: string[]; // unique chunk_ids referenced anywhere in this section
}

export interface PDFContent {
  sections: PDFSection[];
  covering_msg: string;
  persona_tokens: {
    archetype_label: string;
    career_stage: string;
    financial_sensitivity: string;
    technical_depth: string;
    stakeholder_context: string;
    risk_posture: string;
  };
  generated_with: { primary: string; fallback_used: boolean; degraded: boolean };
}

export interface PdfContentInput {
  profile: Record<string, unknown>;
  questions: ExtractedQuestion[];
  persona: PersonaVector;
  /**
   * Optional pre-computed chunks per question. If not provided we call
   * retrieveGrounding ourselves — this keeps the function callable as a
   * single entry point from the API route.
   */
  retrievedChunksByQuestion?: Record<number, GroundingHit[]>;
  caseId?: string;
  component?: string;
  language?: string;
}

function sectionTool(): Anthropic.Tool {
  return {
    name: "record_pdf_section",
    description:
      "Emit one PDFSection answering a single question. Every Sentence must declare chunk_ids (by 1-based index into the provided chunks) or mark certainty='refused'.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 3, maxLength: 120 },
        sentences: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: {
            type: "object",
            properties: {
              text: { type: "string", minLength: 8, maxLength: 500 },
              chunk_indices: {
                type: "array",
                description:
                  "1-based indices into the chunk list shown in the prompt. Empty [] requires certainty='refused' or 'inferred'.",
                items: { type: "integer", minimum: 1 },
              },
              certainty: { type: "string", enum: ["fact", "inferred", "refused"] },
            },
            required: ["text", "chunk_indices", "certainty"],
          },
        },
      },
      required: ["name", "sentences"],
    },
  };
}

function coveringTool(): Anthropic.Tool {
  return {
    name: "record_covering_msg",
    description: "Emit a single-paragraph WhatsApp covering message (≤320 chars) for this lead.",
    input_schema: {
      type: "object",
      properties: {
        covering_msg: { type: "string", minLength: 40, maxLength: 320 },
      },
      required: ["covering_msg"],
    },
  };
}

const SECTION_SYSTEM = `You write ONE section of a personalised post-call PDF for a Scaler lead.

Hard rules, non-negotiable:
1. Every sentence that states a Scaler-specific fact (fee, duration, curriculum item, placement outcome, partner) MUST cite at least one chunk_index. The chunk indices are listed in the user message as [1], [2], ….
2. If the chunk list is empty OR none of the chunks actually answer the question, emit 1-2 sentences with certainty="refused" explaining the information is not on scaler.com; DO NOT fabricate a plausible answer.
3. If you interpret, compare, or extrapolate beyond the chunks (e.g. "this means for a mid-career SDE…"), mark that sentence certainty="inferred" and cite the chunk you built from.
4. Never use "guarantee", "promise", "best", "top" unless a chunk contains that exact word verbatim. Prefer "placement assistance", "supports", "strong track record".
5. Frame Scaler facts through the lead's goal when possible. Use their numbers (salary, years, company) when they appeared in the profile.
6. 3-7 sentences total. Section name = a short noun phrase the lead would scan on their phone.`;

const COVERING_SYSTEM = `You write the one-line WhatsApp message that the PDF lands with.

Rules:
- Second person ("you/your"), first name only, no "Dear".
- One sentence. ≤320 characters.
- Mention ONE thing from the call that proves we listened (a question, a number, a concern).
- No "Best regards", no emojis, no "I am writing to…".`;

function renderChunks(hits: GroundingHit[]): string {
  if (hits.length === 0) return "(no chunks available — this question must be marked refused)";
  return hits
    .map((h, i) => {
      const path = h.section_path.filter(Boolean).join(" > ");
      return `[${i + 1}] (${path || "root"}) rerank=${h.rerank_score.toFixed(2)} id=${h.id}\nsource: ${h.url}\n${h.text.slice(0, 900)}`;
    })
    .join("\n\n---\n\n");
}

function personaBullet(persona: PersonaVector): string {
  return [
    `archetype=${persona.archetype_label}`,
    `career_stage=${persona.career_stage}`,
    `financial_sensitivity=${persona.financial_sensitivity}`,
    `technical_depth=${persona.technical_depth}`,
    `stakeholder_context=${persona.stakeholder_context}`,
    `risk_posture=${persona.risk_posture}`,
    persona.degraded ? "(persona inferred via regex fallback)" : "",
    persona.signals.length > 0 ? `signals: ${persona.signals.slice(0, 3).join(" | ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function generateSection(
  tier: ModelTier,
  args: {
    input: PdfContentInput;
    question: ExtractedQuestion;
    questionIdx: number;
    chunks: GroundingHit[];
    refused: boolean;
  }
): Promise<PDFSection> {
  const { input, question, questionIdx, chunks, refused } = args;
  const safeProfile = sanitizeProfile(input.profile);
  const safeQuestionRewritten = sanitizeForPrompt(question.question_rewritten, { maxChars: 1000 });
  const safeTextExcerpt = sanitizeForPrompt(question.text_excerpt, { maxChars: 1000 });
  const langLine = input.language ? `Respond in language: ${input.language}.` : "";
  const userPrompt = [
    "## Lead profile",
    JSON.stringify(safeProfile, null, 2),
    "",
    "## Persona",
    personaBullet(input.persona),
    "",
    `## Question to answer (Q${questionIdx + 1}, concern=${question.concern_type}, evidence_type=${question.evidence_type}, stated=${question.is_stated})`,
    safeQuestionRewritten,
    safeTextExcerpt ? `Lead's own words: "${safeTextExcerpt}"` : "",
    "",
    "## Retrieved chunks",
    refused ? "(retrieval refused — no chunks met the similarity threshold)" : renderChunks(chunks),
    "",
    refused
      ? "Emit 1-2 sentences with certainty='refused'. State honestly that scaler.com did not contain a sourced answer, and that a Scaler BDA will follow up."
      : "Call record_pdf_section now. Remember: no chunk_indices ⇒ certainty must be 'refused' or 'inferred'.",
    langLine,
  ]
    .filter(Boolean)
    .join("\n");

  const msg = await claudeMessage({
    tier,
    system: SECTION_SYSTEM,
    messages: [{ role: "user", content: userPrompt }],
    tools: [sectionTool()],
    toolChoice: { type: "tool", name: "record_pdf_section" },
    maxTokens: 2000,
    temperature: 0.15,
    caseId: input.caseId,
    taskId: "3.2-pdf-content",
    component: input.component ?? "pdf_content",
    promptVersion: `${PDF_VERSION}-${tier}-section`,
  });

  const out = extractToolUse<{
    name: string;
    sentences: { text: string; chunk_indices: number[]; certainty: Certainty }[];
  }>(msg, "record_pdf_section");

  if (!out || !Array.isArray(out.sentences) || out.sentences.length === 0) {
    // Produce a hard refusal rather than crash — verifier will pick it up.
    const rawName = question.question_rewritten;
    const clippedName = rawName.length > 140 ? rawName.slice(0, 137) + "..." : rawName;
    return {
      name: clippedName,
      section_type: question.concern_type,
      sentences: [
        {
          text: renderRefusal(question.question_rewritten),
          chunk_ids: [],
          certainty: "refused",
        },
      ],
      refused: true,
      source_question_idx: questionIdx,
      chunks_cited: [],
    };
  }

  const sentences: Sentence[] = out.sentences.map((s) => {
    const indices = (s.chunk_indices ?? []).map(Number).filter((n) => n >= 1 && n <= chunks.length);
    const chunk_ids = indices.map((i) => chunks[i - 1].id);
    const certainty: Certainty =
      s.certainty === "refused" || s.certainty === "inferred" || s.certainty === "fact"
        ? s.certainty
        : chunk_ids.length === 0
        ? "refused"
        : "fact";
    return { text: s.text.trim(), chunk_ids, certainty };
  });

  const chunks_cited = Array.from(new Set(sentences.flatMap((s) => s.chunk_ids)));
  const sectionRefused = refused || sentences.every((s) => s.certainty === "refused");

  return {
    name: out.name.trim(),
    section_type: question.concern_type,
    sentences,
    refused: sectionRefused,
    source_question_idx: questionIdx,
    chunks_cited,
  };
}

async function generateCoveringMessage(
  input: PdfContentInput,
  sections: PDFSection[]
): Promise<string> {
  const rawFirstName = (input.profile as { name?: string }).name?.split?.(" ")?.[0] ?? "there";
  const firstName = sanitizeForPrompt(rawFirstName, { maxChars: 100, collapseWhitespace: true });
  const questionSummary = input.questions
    .slice(0, 3)
    .map((q) => `- ${sanitizeForPrompt(q.question_rewritten, { maxChars: 300 })}`)
    .join("\n");
  const sectionSummary = sections.map((s) => `• ${s.name} (${s.refused ? "refused" : "answered"})`).join("\n");
  const langLine = input.language ? `Respond in language: ${input.language}.` : "";

  const msg = await claudeMessage({
    tier: "sonnet",
    system: COVERING_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          `Lead first name: ${firstName}`,
          `Persona archetype: ${input.persona.archetype_label}`,
          "",
          "Their main questions on the call:",
          questionSummary,
          "",
          "Sections that landed in the PDF:",
          sectionSummary,
          "",
          "Write the one-line covering WhatsApp message now via record_covering_msg.",
          langLine,
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
    tools: [coveringTool()],
    toolChoice: { type: "tool", name: "record_covering_msg" },
    maxTokens: 400,
    temperature: 0.3,
    caseId: input.caseId,
    taskId: "3.2-pdf-content",
    component: input.component ?? "pdf_content",
    promptVersion: `${PDF_VERSION}-covering`,
  });
  const out = extractToolUse<{ covering_msg: string }>(msg, "record_covering_msg");
  return (
    out?.covering_msg?.trim().slice(0, 320) ??
    `Hi ${firstName}, attaching the PDF we put together from our call — sources cited on every page.`
  );
}

export async function generatePDFContent(input: PdfContentInput): Promise<PDFContent> {
  const component = input.component ?? "pdf_content";
  const started = Date.now();

  await log({
    case_id: input.caseId,
    task_id: "3.2-pdf-content",
    component,
    event: "pdf_content_start",
    payload: { question_count: input.questions.length, archetype: input.persona.archetype_label },
  });

  // 1. Resolve chunks per question (either passed in or retrieve now).
  const chunkMap: Record<number, { hits: GroundingHit[]; refused: boolean }> = {};
  for (let i = 0; i < input.questions.length; i++) {
    const q = input.questions[i];
    const pre = input.retrievedChunksByQuestion?.[i];
    if (pre) {
      chunkMap[i] = { hits: pre, refused: pre.length === 0 };
      continue;
    }
    const r = await retrieveGrounding(q.question_rewritten, {
      caseId: input.caseId,
      taskId: "3.2-pdf-content",
      component,
      topK: 6,
    });
    chunkMap[i] = { hits: r.hits, refused: r.refused };
  }

  // 2. Generate each section. Opus primary, Sonnet fallback per-section.
  let fallbackUsed = false;
  const sections: PDFSection[] = [];
  for (let i = 0; i < input.questions.length; i++) {
    const q = input.questions[i];
    const { hits, refused } = chunkMap[i];

    const sectionStarted = Date.now();
    await log({
      case_id: input.caseId,
      task_id: "3.2-pdf-content",
      component,
      event: "pdf_content_section_start",
      payload: { idx: i, concern_type: q.concern_type, chunks: hits.length, refused },
    });

    let section: PDFSection;
    try {
      section = await generateSection("opus", { input, question: q, questionIdx: i, chunks: hits, refused });
    } catch (e) {
      await log({
        case_id: input.caseId,
        task_id: "3.2-pdf-content",
        component,
        level: "WARN",
        event: "pdf_content_opus_failed_falling_back_sonnet",
        error_message: String(e).slice(0, 500),
        payload: { idx: i },
      });
      fallbackUsed = true;
      section = await generateSection("sonnet", {
        input,
        question: q,
        questionIdx: i,
        chunks: hits,
        refused,
      });
    }

    await log({
      case_id: input.caseId,
      task_id: "3.2-pdf-content",
      component,
      event: "pdf_content_section_ok",
      latency_ms: Date.now() - sectionStarted,
      payload: {
        idx: i,
        sentence_count: section.sentences.length,
        refused: section.refused,
        chunks_cited: section.chunks_cited.length,
      },
    });
    sections.push(section);
  }

  // 3. Covering message.
  const covering_msg = await generateCoveringMessage(input, sections).catch(async (e) => {
    await log({
      case_id: input.caseId,
      task_id: "3.2-pdf-content",
      component,
      level: "WARN",
      event: "covering_msg_failed_using_default",
      error_message: String(e).slice(0, 500),
    });
    const firstName = (input.profile as { name?: string }).name?.split?.(" ")?.[0] ?? "there";
    return `Hi ${firstName}, attaching the PDF we put together from our call — sources cited on every page.`;
  });

  const content: PDFContent = {
    sections: sanitizeSections(sections),
    covering_msg: sanitizeRupee(covering_msg),
    persona_tokens: {
      archetype_label: input.persona.archetype_label,
      career_stage: input.persona.career_stage,
      financial_sensitivity: input.persona.financial_sensitivity,
      technical_depth: input.persona.technical_depth,
      stakeholder_context: input.persona.stakeholder_context,
      risk_posture: input.persona.risk_posture,
    },
    generated_with: {
      primary: MODELS.opus,
      fallback_used: fallbackUsed,
      degraded: fallbackUsed || input.persona.degraded,
    },
  };

  await log({
    case_id: input.caseId,
    task_id: "3.2-pdf-content",
    component,
    event: "pdf_content_ok",
    latency_ms: Date.now() - started,
    payload: {
      section_count: sections.length,
      refused_count: sections.filter((s) => s.refused).length,
      total_sentences: sections.reduce((n, s) => n + s.sentences.length, 0),
      fallback_used: fallbackUsed,
    },
  });

  return content;
}
