import { log } from "./log";
import { withRetry } from "./fallback";

const VOYAGE_API_BASE = "https://api.voyageai.com/v1";

export const VOYAGE_EMBED_MODEL = "voyage-3-large";
export const VOYAGE_RERANK_MODEL = "rerank-2.5";
export const VOYAGE_EMBED_DIM = 1024;

export type VoyageInputType = "document" | "query";

interface EmbeddingsResponse {
  object: "list";
  data: Array<{ object: "embedding"; embedding: number[]; index: number }>;
  model: string;
  usage: { total_tokens: number };
}

interface RerankResponse {
  object: "list";
  data: Array<{ relevance_score: number; index: number }>;
  model: string;
  usage: { total_tokens: number };
}

function apiKey(): string {
  const k = process.env.VOYAGE_API_KEY;
  if (!k) throw new Error("VOYAGE_API_KEY missing");
  return k;
}

/** Embed texts. For ingest pass input_type="document"; for queries pass "query". */
export async function voyageEmbed(args: {
  texts: string[];
  inputType: VoyageInputType;
  caseId?: string;
  taskId: string;
  component: string;
}): Promise<number[][]> {
  const started = Date.now();

  const res = await withRetry(
    async () => {
      const r = await fetch(`${VOYAGE_API_BASE}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey()}`,
        },
        body: JSON.stringify({
          input: args.texts,
          model: VOYAGE_EMBED_MODEL,
          input_type: args.inputType,
        }),
      });
      if (!r.ok) {
        const body = await r.text();
        throw new Error(`voyage embed ${r.status}: ${body.slice(0, 300)}`);
      }
      return (await r.json()) as EmbeddingsResponse;
    },
    {
      ctx: { caseId: args.caseId, taskId: args.taskId, component: args.component },
      providerName: "voyage",
    }
  );

  await log({
    case_id: args.caseId,
    task_id: args.taskId,
    component: args.component,
    event: "voyage_embed_ok",
    provider: "voyage",
    model: VOYAGE_EMBED_MODEL,
    tokens_in: res.usage.total_tokens,
    latency_ms: Date.now() - started,
    payload: { count: args.texts.length, input_type: args.inputType },
  });

  return res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

/** Rerank candidate documents against a query. Returns scores in original index order. */
export async function voyageRerank(args: {
  query: string;
  documents: string[];
  topK?: number;
  caseId?: string;
  taskId: string;
  component: string;
}): Promise<Array<{ index: number; score: number }>> {
  const started = Date.now();

  const res = await withRetry(
    async () => {
      const r = await fetch(`${VOYAGE_API_BASE}/rerank`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey()}`,
        },
        body: JSON.stringify({
          query: args.query,
          documents: args.documents,
          model: VOYAGE_RERANK_MODEL,
          top_k: args.topK ?? args.documents.length,
          return_documents: false,
        }),
      });
      if (!r.ok) {
        const body = await r.text();
        throw new Error(`voyage rerank ${r.status}: ${body.slice(0, 300)}`);
      }
      return (await r.json()) as RerankResponse;
    },
    {
      ctx: { caseId: args.caseId, taskId: args.taskId, component: args.component },
      providerName: "voyage",
    }
  );

  await log({
    case_id: args.caseId,
    task_id: args.taskId,
    component: args.component,
    event: "voyage_rerank_ok",
    provider: "voyage",
    model: VOYAGE_RERANK_MODEL,
    tokens_in: res.usage.total_tokens,
    latency_ms: Date.now() - started,
    payload: { candidates: args.documents.length, top_k: args.topK ?? args.documents.length },
  });

  return res.data.map((d) => ({ index: d.index, score: d.relevance_score }));
}
