/**
 * Task 1.3 — retrieval client with rerank + refuse gate.
 *
 * Flow:
 *   query → voyage embed (input_type=query)
 *        → supabase RPC retrieve_hybrid (RRF BM25 + cosine, k=60)
 *        → voyage rerank-2.5 over fusion pool
 *        → gate: top score < RERANK_REFUSE_THRESHOLD ⇒ refuse
 *        → return top N chunks with rerank_score and provenance
 *
 * Refuse gate is the *only* hard answer boundary for factual queries.
 * Everything downstream (PDF content gen, BDA nudge) consumes
 * RetrievalResult and must call renderRefusal() when refused=true.
 */
import { supabaseServer } from "./supabase";
import { voyageEmbed, voyageRerank } from "./voyage";
import { log } from "./log";

export const RERANK_REFUSE_THRESHOLD = 0.35;

export interface GroundingHit {
  id: string;
  url: string;
  section_path: string[];
  text: string;
  bm25_rank: number | null;
  dense_rank: number | null;
  bm25_score: number | null;
  dense_score: number | null;
  rrf_score: number;
  rerank_score: number;
}

export interface RetrievalResult {
  query: string;
  refused: boolean;
  top_rerank_score: number | null;
  hits: GroundingHit[];
  pool_size: number;
}

export interface RetrieveOptions {
  /** Final number of hits to return after rerank (default 6). */
  topK?: number;
  /** Fusion pool size from RPC (default 40). Cap at 80 to keep rerank latency sane. */
  matchK?: number;
  /** BM25 candidate pool inside RPC (default 80). */
  bm25Pool?: number;
  /** Dense candidate pool inside RPC (default 80). */
  densePool?: number;
  /** Override refuse threshold (tests / debugging). */
  refuseThreshold?: number;
  /** Trace metadata propagated into log rows. */
  caseId?: string;
  taskId?: string;
  component?: string;
  /** BCP-47 language hint. When set to a non-English code (e.g. 'hi'), retrieval routes to dense-only RPC because the BM25 tsquery is hardcoded to English. */
  language?: string;
}

interface HybridRow {
  id: string;
  url: string;
  section_path: string[];
  text: string;
  bm25_rank: number | null;
  dense_rank: number | null;
  bm25_score: number | null;
  dense_score: number | null;
  rrf_score: number;
}

export async function retrieveGrounding(
  query: string,
  opts: RetrieveOptions = {}
): Promise<RetrievalResult> {
  const taskId = opts.taskId ?? "1.3-retrieve";
  const component = opts.component ?? "retrieve";
  const topK = opts.topK ?? 6;
  const matchK = Math.min(opts.matchK ?? 40, 80);
  const threshold = opts.refuseThreshold ?? RERANK_REFUSE_THRESHOLD;
  const started = Date.now();

  const trimmed = query.trim();
  if (!trimmed) {
    return { query, refused: true, top_rerank_score: null, hits: [], pool_size: 0 };
  }

  // 1. Embed the query.
  const [qvec] = await voyageEmbed({
    texts: [trimmed],
    inputType: "query",
    caseId: opts.caseId,
    taskId,
    component,
  });

  // 2. Hybrid RPC — or dense-only for Hindi (BM25 tsquery is hardcoded to English).
  const supabase = supabaseServer();
  const isHindi = (opts.language ?? "").toLowerCase().startsWith("hi");
  const retrievalMode: "hybrid" | "dense_only_hi" = isHindi ? "dense_only_hi" : "hybrid";

  let pool: HybridRow[];
  if (isHindi) {
    const { data: denseData, error: denseError } = await supabase.rpc("retrieve_dense_only", {
      query_embedding: qvec as unknown as string,
      match_k: matchK,
    });
    if (denseError) {
      await log({
        case_id: opts.caseId,
        task_id: taskId,
        component,
        level: "ERROR",
        event: "retrieve_dense_only_failed",
        error_message: denseError.message,
      });
      throw new Error(`retrieve_dense_only RPC failed: ${denseError.message}`);
    }
    const denseRows = (denseData ?? []) as { id: string; url: string; section_path: string[]; text: string; score: number }[];
    pool = denseRows.map((row, i) => ({
      id: row.id,
      url: row.url,
      section_path: row.section_path,
      text: row.text,
      bm25_rank: null,
      dense_rank: i + 1,
      bm25_score: null,
      dense_score: row.score,
      rrf_score: row.score,
    }));
  } else {
    const { data, error } = await supabase.rpc("retrieve_hybrid", {
      query_text: trimmed,
      query_embedding: qvec as unknown as string, // pgvector accepts number[] serialised as JSON
      match_k: matchK,
      rrf_k: 60,
      bm25_pool: opts.bm25Pool ?? 80,
      dense_pool: opts.densePool ?? 80,
    });
    if (error) {
      await log({
        case_id: opts.caseId,
        task_id: taskId,
        component,
        level: "ERROR",
        event: "retrieve_hybrid_failed",
        error_message: error.message,
      });
      throw new Error(`retrieve_hybrid RPC failed: ${error.message}`);
    }
    pool = (data ?? []) as HybridRow[];
  }
  if (pool.length === 0) {
    await log({
      case_id: opts.caseId,
      task_id: taskId,
      component,
      level: "WARN",
      event: "retrieve_empty_pool",
      payload: { query: trimmed.slice(0, 200) },
    });
    return { query, refused: true, top_rerank_score: null, hits: [], pool_size: 0 };
  }

  // 3. Rerank the full pool.
  const rerank = await voyageRerank({
    query: trimmed,
    documents: pool.map((r) => r.text),
    topK: Math.min(pool.length, Math.max(topK, 10)),
    caseId: opts.caseId,
    taskId,
    component,
  });

  // rerank returns {index,score} over pool order. Join back and sort.
  const byIndex = new Map(rerank.map((r) => [r.index, r.score]));
  const scored: GroundingHit[] = pool.map((r, i) => ({
    id: r.id,
    url: r.url,
    section_path: r.section_path,
    text: r.text,
    bm25_rank: r.bm25_rank,
    dense_rank: r.dense_rank,
    bm25_score: r.bm25_score,
    dense_score: r.dense_score,
    rrf_score: r.rrf_score,
    rerank_score: byIndex.get(i) ?? -1,
  }));
  scored.sort((a, b) => b.rerank_score - a.rerank_score);

  const topScore = scored[0]?.rerank_score ?? -1;
  const refused = topScore < threshold;
  const hits = refused ? [] : scored.slice(0, topK);

  await log({
    case_id: opts.caseId,
    task_id: taskId,
    component,
    event: refused ? "retrieve_refused" : "retrieve_ok",
    latency_ms: Date.now() - started,
    payload: {
      query: trimmed.slice(0, 200),
      pool_size: pool.length,
      top_rerank_score: topScore,
      threshold,
      returned: hits.length,
      hit_urls: hits.map((h) => h.url),
      retrieval_mode: retrievalMode,
    },
  });

  return { query, refused, top_rerank_score: topScore, hits, pool_size: pool.length };
}

/**
 * Convenience for callers that need a single formatted citation line per chunk.
 * Used by PDF footer rendering and BDA nudge "sources:" annotations.
 */
export function formatCitation(hit: GroundingHit): string {
  const path = hit.section_path.filter(Boolean).join(" > ");
  return path ? `${hit.url} — ${path}` : hit.url;
}

/**
 * Standard refusal block. Any downstream gen module MUST use this when
 * RetrievalResult.refused is true — never paraphrase or hallucinate a fallback answer.
 */
export function renderRefusal(query: string): string {
  return (
    `I don't have a sourced answer for "${query.slice(0, 160)}" on scaler.com. ` +
    `A Scaler BDA will follow up with a verified response.`
  );
}
