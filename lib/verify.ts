/**
 * Task 3.3 — three-moat anti-hallucination verifier (BLUEPRINT §2.5.2).
 *
 *   Moat 1: structural — a sentence with empty chunk_ids AND certainty!="inferred"|"refused" is DROPPED.
 *   Moat 2: semantic — Haiku judges each remaining fact-sentence against its cited chunks.
 *           supported="no" ⇒ DROP; "partial" ⇒ flag + degrade certainty to "inferred".
 *   Moat 3: surface — regex-guarded literals (₹amounts, LPA figures, URLs) must appear
 *           verbatim somewhere in a cited chunk; mismatched sentence is REWRITTEN as
 *           an honest-uncertainty template. Banned words ("guarantee", "promise",
 *           "best", "top") are only allowed if verbatim in a cited chunk.
 *
 * Returns the cleaned PDFContent plus a stats object. Calling code updates
 * lead_cases.pdf_content with the verified version.
 *
 * Stats note:
 *   claims_dropped_count = sentences removed entirely (moat-1 structural drops,
 *                          moat-2 "no" verdicts).
 *   rewritten_count      = sentences replaced with an honest-uncertainty stub
 *                          (moat-3 literal/banned-word misses; empty-section stubs).
 *   These counters are mutually exclusive — a sentence is either dropped OR rewritten,
 *   never both.
 *
 * Fallback: if Haiku moat 2 throws, we skip moat 2 only, log DEGRADED, and
 * raise the downstream retrieve threshold (caller responsibility).
 */
import { claudeMessage, extractToolUse } from "./anthropic";
import { log } from "./log";
import { renderRefusal } from "./retrieve";
import type Anthropic from "@anthropic-ai/sdk";
import type { PDFContent, PDFSection, Sentence, Certainty } from "./pdfContent";

const VERIFIER_VERSION = "verify-3.3-v1";

const VERIFY_BATCH_SIZE = 8;

const BANNED_WORDS = ["guarantee", "promise", "best", "top"] as const;

const RUPEE_RE = /₹\s*\d[\d,]*(?:\.\d+)?(?:\s*(?:lakh|crore|cr|lac|k))?/gi;
const LPA_RE = /\b\d+(?:\.\d+)?\s*(?:LPA|CTC|lakhs?\s*per\s*annum)\b/gi;
const URL_RE = /https?:\/\/[^\s)<>\]"']+/gi;
const BANNED_RE = new RegExp(`\\b(${BANNED_WORDS.join("|")})\\b`, "gi");

export interface VerifyStats {
  total_sentences: number;
  total_fact_sentences: number;
  claims_dropped_count: number;
  claims_flagged_count: number;
  rewritten_count: number;
  ok_rate: number; // fact sentences surviving / total fact sentences
  moat2_skipped: boolean;
}

export interface VerifyResult {
  content: PDFContent;
  stats: VerifyStats;
}

export interface ChunkLike {
  id: string;
  text: string;
  url: string;
}

export type ChunkLookup = Map<string, ChunkLike> | Record<string, ChunkLike>;

function lookup(map: ChunkLookup, id: string): ChunkLike | undefined {
  return map instanceof Map ? map.get(id) : map[id];
}

function citedText(sentence: Sentence, chunks: ChunkLookup): string {
  return sentence.chunk_ids
    .map((id) => lookup(chunks, id)?.text ?? "")
    .join("\n---\n");
}

function verbatimInCited(needle: string, sentence: Sentence, chunks: ChunkLookup): boolean {
  const hay = citedText(sentence, chunks).toLowerCase();
  if (!hay) return false;
  return hay.includes(needle.toLowerCase().trim());
}

function honestUncertaintySentence(originalText: string): Sentence {
  return {
    text: `${renderRefusal(originalText.slice(0, 120))}`,
    chunk_ids: [],
    certainty: "refused",
  };
}

function moat1Drop(sentence: Sentence): boolean {
  if (sentence.chunk_ids.length > 0) return false;
  if (sentence.certainty === "inferred" || sentence.certainty === "refused") return false;
  return true; // drop
}

function surfaceLiterals(text: string): string[] {
  const literals: string[] = [];
  const capture = (re: RegExp) => {
    const m = text.matchAll(re);
    for (const hit of m) literals.push(hit[0]);
  };
  capture(RUPEE_RE);
  capture(LPA_RE);
  capture(URL_RE);
  return literals;
}

function verifierTool(): Anthropic.Tool {
  return {
    name: "record_verdicts",
    description: "Judge each sentence against its cited chunks. Output a verdict per input sentence, same order.",
    input_schema: {
      type: "object",
      properties: {
        verdicts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              idx: { type: "integer", minimum: 0 },
              supported: { type: "string", enum: ["yes", "partial", "no"] },
              reason: { type: "string", maxLength: 240 },
            },
            required: ["idx", "supported", "reason"],
          },
        },
      },
      required: ["verdicts"],
    },
  };
}

interface BatchItem {
  idx: number;
  sentence: Sentence;
  citedBody: string;
}

interface Verdict {
  idx: number;
  supported: "yes" | "partial" | "no";
  reason: string;
}

async function haikuBatchVerify(
  items: BatchItem[],
  caseId: string | undefined,
  component: string
): Promise<Verdict[]> {
  if (items.length === 0) return [];

  const allVerdicts: Verdict[] = [];

  // Process items in chunks of VERIFY_BATCH_SIZE sequentially to keep latency
  // transparent and avoid JSON-truncation on large sections.
  for (let start = 0; start < items.length; start += VERIFY_BATCH_SIZE) {
    const chunk = items.slice(start, start + VERIFY_BATCH_SIZE);

    const user = [
      "For each sentence, decide whether the cited chunks SUPPORT the claim. Output one verdict per sentence, in input order.",
      "",
      ...chunk.map(
        (it) =>
          `--- sentence ${it.idx} (certainty=${it.sentence.certainty}) ---\nSENTENCE: ${it.sentence.text}\n\nCITED CHUNKS:\n${it.citedBody || "(none)"}`
      ),
    ].join("\n\n");

    const maxTokens = Math.min(Math.max(800, chunk.length * 180), 4096);

    const msg = await claudeMessage({
      tier: "haiku",
      system: `You are a strict grounding auditor. Output 'yes' only if the cited chunks state (not imply) the claim.
'partial' = the chunks state a weaker version. 'no' = chunks do not support the claim at all.
Be conservative — when in doubt, say 'partial' or 'no'.`,
      messages: [{ role: "user", content: user }],
      tools: [verifierTool()],
      toolChoice: { type: "tool", name: "record_verdicts" },
      maxTokens,
      temperature: 0,
      caseId,
      taskId: "3.3-verify",
      component,
      promptVersion: `${VERIFIER_VERSION}-moat2`,
    });
    const out = extractToolUse<{ verdicts: Verdict[] }>(msg, "record_verdicts");
    const chunkVerdicts = out?.verdicts ?? [];
    allVerdicts.push(...chunkVerdicts);

    // If the verifier returned fewer verdicts than sentences in this chunk,
    // synthesise conservative "partial" verdicts for the missing items so they
    // are flagged + downgraded to certainty="inferred" rather than silently
    // passing as fact.
    const returnedIdxs = new Set(chunkVerdicts.map((v) => v.idx));
    for (const it of chunk) {
      if (!returnedIdxs.has(it.idx)) {
        allVerdicts.push({
          idx: it.idx,
          supported: "partial",
          reason: "verifier output truncated — downgraded conservatively",
        });
      }
    }
  }

  return allVerdicts;
}

export interface VerifyOpts {
  caseId?: string;
  component?: string;
  /** Skip moat 2 (batch LLM audit) — used when caller explicitly degrades. */
  skipMoat2?: boolean;
}

export async function verifyPDFContent(
  content: PDFContent,
  chunks: ChunkLookup,
  opts: VerifyOpts = {}
): Promise<VerifyResult> {
  const component = opts.component ?? "verify";
  const started = Date.now();

  await log({
    case_id: opts.caseId,
    task_id: "3.3-verify",
    component,
    event: "verify_start",
    payload: { section_count: content.sections.length },
  });

  let total = 0;
  let factTotal = 0;
  let dropped = 0;
  let flagged = 0;
  let rewritten = 0;
  let moat2Skipped = Boolean(opts.skipMoat2);

  const cleanedSections: PDFSection[] = [];

  for (const section of content.sections) {
    // Moat 1 + moat 3 (surface regex + banned words) — deterministic, per-sentence.
    const phase1: Sentence[] = [];
    for (const s of section.sentences) {
      total++;
      if (s.certainty === "fact") factTotal++;

      // Moat 1: structural.
      if (moat1Drop(s)) {
        dropped++;
        await log({
          case_id: opts.caseId,
          task_id: "3.3-verify",
          component,
          event: "hallucination_suppressed",
          payload: { moat: 1, reason: "no_chunk_ids_and_not_inferred", sentence: s.text.slice(0, 200) },
        });
        continue;
      }

      // Moat 3: surface literals must appear verbatim in at least one cited chunk.
      const literals = surfaceLiterals(s.text);
      const literalMiss = literals.find((lit) => !verbatimInCited(lit, s, chunks));
      if (literalMiss && s.certainty !== "refused") {
        await log({
          case_id: opts.caseId,
          task_id: "3.3-verify",
          component,
          event: "hallucination_suppressed",
          payload: {
            moat: 3,
            reason: "literal_not_in_chunks",
            literal: literalMiss,
            sentence: s.text.slice(0, 200),
          },
        });
        phase1.push(honestUncertaintySentence(s.text));
        rewritten++;
        continue;
      }

      // Moat 3b: banned words must be verbatim in a cited chunk.
      const banned = s.text.match(BANNED_RE) ?? [];
      const bannedMiss = banned.find((w) => !verbatimInCited(w, s, chunks));
      if (bannedMiss && s.certainty !== "refused") {
        await log({
          case_id: opts.caseId,
          task_id: "3.3-verify",
          component,
          event: "hallucination_suppressed",
          payload: { moat: 3, reason: "banned_word", word: bannedMiss, sentence: s.text.slice(0, 200) },
        });
        phase1.push(honestUncertaintySentence(s.text));
        rewritten++;
        continue;
      }

      phase1.push(s);
    }

    cleanedSections.push({ ...section, sentences: phase1 });
  }

  // Moat 2: LLM batch verify, section-by-section, for surviving fact sentences with citations.
  if (!moat2Skipped) {
    for (let sIdx = 0; sIdx < cleanedSections.length; sIdx++) {
      const section = cleanedSections[sIdx];
      const batch: BatchItem[] = [];
      section.sentences.forEach((sent, idx) => {
        if (sent.certainty === "refused") return;
        if (sent.chunk_ids.length === 0) return; // already OK-inferred
        batch.push({ idx, sentence: sent, citedBody: citedText(sent, chunks).slice(0, 3000) });
      });

      if (batch.length === 0) continue;

      let verdicts: Verdict[] = [];
      try {
        verdicts = await haikuBatchVerify(batch, opts.caseId, component);
      } catch (e) {
        await log({
          case_id: opts.caseId,
          task_id: "3.3-verify",
          component,
          level: "WARN",
          event: "verify_moat2_failed_skipping",
          error_message: String(e).slice(0, 500),
        });
        moat2Skipped = true;
        break;
      }

      // Map verdicts back onto the section.
      const byIdx = new Map(verdicts.map((v) => [v.idx, v]));
      const next: Sentence[] = section.sentences.map((sent, idx) => {
        const verdict = byIdx.get(idx);
        if (!verdict) return sent;
        if (verdict.supported === "yes") {
          return { ...sent, verifier_score: 1.0 };
        }
        if (verdict.supported === "partial") {
          flagged++;
          const nextCertainty: Certainty = sent.certainty === "refused" ? "refused" : "inferred";
          return { ...sent, verifier_score: 0.5, certainty: nextCertainty };
        }
        // supported === "no"
        dropped++;
        return null as unknown as Sentence;
      });

      cleanedSections[sIdx] = {
        ...section,
        sentences: next.filter((s): s is Sentence => s != null),
      };
    }
  }

  // Finalise: any section with zero sentences gets an honest-uncertainty stub.
  for (let i = 0; i < cleanedSections.length; i++) {
    const sec = cleanedSections[i];
    if (sec.sentences.length === 0) {
      cleanedSections[i] = {
        ...sec,
        sentences: [honestUncertaintySentence(sec.name)],
        refused: true,
        chunks_cited: [],
      };
      rewritten++;
    } else {
      cleanedSections[i] = {
        ...sec,
        refused: sec.sentences.every((s) => s.certainty === "refused"),
        chunks_cited: Array.from(new Set(sec.sentences.flatMap((s) => s.chunk_ids))),
      };
    }
  }

  const factSurvivors = cleanedSections.reduce(
    (n, s) => n + s.sentences.filter((x) => x.certainty === "fact").length,
    0
  );
  const ok_rate = factTotal === 0 ? 1 : factSurvivors / factTotal;

  const cleanedContent: PDFContent = {
    ...content,
    sections: cleanedSections,
    generated_with: {
      ...content.generated_with,
      degraded: content.generated_with.degraded || moat2Skipped,
    },
  };

  const stats: VerifyStats = {
    total_sentences: total,
    total_fact_sentences: factTotal,
    claims_dropped_count: dropped,
    claims_flagged_count: flagged,
    rewritten_count: rewritten,
    ok_rate,
    moat2_skipped: moat2Skipped,
  };

  await log({
    case_id: opts.caseId,
    task_id: "3.3-verify",
    component,
    event: "verify_ok",
    latency_ms: Date.now() - started,
    payload: { ...stats },
  });

  return { content: cleanedContent, stats };
}
