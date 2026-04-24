/**
 * Task 1.1 — chunk + embed + upsert Scaler corpus into grounding_chunks.
 *
 * Pipeline:
 *   data/scaler_corpus.json
 *     → chunk (heading-prefixed, ~600 chars, 100 char overlap on long sections)
 *     → content-hash dedupe (idempotent across re-runs)
 *     → voyage-3-large embed (input_type=document, batch=64)
 *     → supabase upsert on conflict (url, content_hash)
 *
 * Run: `npm run ingest` (Node 20.6+ loads .env.local via --env-file)
 *   or: `tsx --env-file=.env.local scripts/ingest.ts`
 *
 * Re-running is safe — unchanged chunks are skipped by the unique constraint.
 *
 * ALSO RUN: `node scripts/ingest_static_facts.mjs`
 *   This companion script ingests curated static facts from
 *   data/scaler_static_facts.json into grounding_chunks. It covers topics
 *   that the crawler may not surface from SPA-rendered pages: fees, durations,
 *   schedule, mentor profiles, placement outcomes, curriculum structure,
 *   eligibility, certificates, and institutional partnerships.
 *   Run it after this script (or independently — it is fully idempotent).
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { supabaseServer } from "../lib/supabase";
import { voyageEmbed, VOYAGE_EMBED_DIM } from "../lib/voyage";

interface PageSection {
  heading: string;
  path: string[];
  text: string;
}

interface PageDoc {
  url: string;
  fetched_at: string;
  title: string;
  h1: string;
  sections: PageSection[];
  source: string;
}

interface Chunk {
  url: string;
  section_path: string[];
  text: string;
  span_start: number;
  span_end: number;
  content_hash: string;
  fetched_at: string;
}

const TARGET_CHARS = 600;
const OVERLAP_CHARS = 100;
const MIN_CHARS = 80;
const EMBED_BATCH = 64;

function sentenceSplit(text: string): string[] {
  // Naive but robust: split on ". ", "! ", "? " followed by a capital / digit,
  // plus newline-newline as a paragraph break.
  const parts = text
    .replace(/\n{2,}/g, "|||PARA|||")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9(])/g)
    .flatMap((s) => s.split("|||PARA|||"))
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [text];
}

function chunkSection(page: PageDoc, section: PageSection): Chunk[] {
  const breadcrumb = [page.h1 || page.title, ...section.path]
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i) // dedupe
    .join(" > ");
  const body = section.text.trim();
  if (body.length < MIN_CHARS) return [];

  // Short enough to emit whole.
  if (body.length <= TARGET_CHARS + OVERLAP_CHARS) {
    const text = breadcrumb ? `${breadcrumb}\n\n${body}` : body;
    return [
      {
        url: page.url,
        section_path: section.path,
        text,
        span_start: 0,
        span_end: body.length,
        content_hash: sha256(text),
        fetched_at: page.fetched_at,
      },
    ];
  }

  // Greedy sentence-aware split.
  const sentences = sentenceSplit(body);
  const chunks: Chunk[] = [];
  let buf: string[] = [];
  let bufChars = 0;
  let cursor = 0;

  const flush = () => {
    if (buf.length === 0) return;
    const segment = buf.join(" ").trim();
    if (segment.length < MIN_CHARS) {
      buf = [];
      bufChars = 0;
      return;
    }
    const text = breadcrumb ? `${breadcrumb}\n\n${segment}` : segment;
    chunks.push({
      url: page.url,
      section_path: section.path,
      text,
      span_start: cursor,
      span_end: cursor + segment.length,
      content_hash: sha256(text),
      fetched_at: page.fetched_at,
    });
    cursor += Math.max(1, segment.length - OVERLAP_CHARS);
    buf = [];
    bufChars = 0;
  };

  for (const s of sentences) {
    if (bufChars + s.length + 1 > TARGET_CHARS && bufChars > 0) {
      flush();
      // Re-seed buffer with tail-overlap from prior segment for entity continuity.
      const prior = chunks[chunks.length - 1];
      if (prior) {
        const tail = prior.text.slice(-OVERLAP_CHARS);
        buf.push(tail);
        bufChars += tail.length;
      }
    }
    buf.push(s);
    bufChars += s.length + 1;
  }
  flush();

  return chunks;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

async function main() {
  const corpusPath = join(process.cwd(), "data", "scaler_corpus.json");
  if (!existsSync(corpusPath)) {
    throw new Error(`corpus not found at ${corpusPath} — run \`npm run crawl\` first`);
  }
  const pages: PageDoc[] = JSON.parse(readFileSync(corpusPath, "utf8"));

  // Flatten pages → chunks.
  const chunks: Chunk[] = [];
  for (const page of pages) {
    for (const section of page.sections) {
      chunks.push(...chunkSection(page, section));
    }
  }

  // Deduplicate within this run (a phrase that repeats verbatim across pages → one row).
  const seen = new Set<string>();
  const unique = chunks.filter((c) => {
    const k = `${c.url}::${c.content_hash}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  console.log(
    `[ingest] ${pages.length} pages → ${chunks.length} chunks (${unique.length} after url+hash dedupe)`
  );
  if (unique.length === 0) throw new Error("no chunks produced — check corpus contents");

  const supabase = supabaseServer();

  // Skip already-ingested rows before we pay Voyage tokens.
  const hashes = unique.map((c) => c.content_hash);
  const existing = new Set<string>();
  for (let i = 0; i < hashes.length; i += 1000) {
    const batch = hashes.slice(i, i + 1000);
    const { data, error } = await supabase
      .from("grounding_chunks")
      .select("content_hash")
      .in("content_hash", batch);
    if (error) throw new Error(`[ingest] existence probe failed: ${error.message}`);
    data?.forEach((r: { content_hash: string }) => existing.add(r.content_hash));
  }
  const todo = unique.filter((c) => !existing.has(c.content_hash));
  console.log(`[ingest] ${existing.size} already in DB; ${todo.length} to embed + upsert`);
  if (todo.length === 0) {
    console.log("[ingest] nothing new — done.");
    return;
  }

  // Embed in batches.
  let embedded = 0;
  for (let i = 0; i < todo.length; i += EMBED_BATCH) {
    const batch = todo.slice(i, i + EMBED_BATCH);
    const vectors = await voyageEmbed({
      texts: batch.map((c) => c.text),
      inputType: "document",
      taskId: "1.1-ingest",
      component: "ingest",
    });
    if (vectors.length !== batch.length) {
      throw new Error(`voyage returned ${vectors.length} vectors for ${batch.length} inputs`);
    }
    if (vectors[0].length !== VOYAGE_EMBED_DIM) {
      throw new Error(`unexpected embed dim ${vectors[0].length} — schema expects ${VOYAGE_EMBED_DIM}`);
    }

    const rows = batch.map((c, j) => ({
      url: c.url,
      section_path: c.section_path,
      text: c.text,
      span_chars: `[${c.span_start},${c.span_end})`,
      content_hash: c.content_hash,
      fetched_at: c.fetched_at,
      embedding: vectors[j] as unknown as string, // pgvector accepts JSON array or string literal
    }));

    const { error } = await supabase
      .from("grounding_chunks")
      .upsert(rows, { onConflict: "url,content_hash", ignoreDuplicates: true });
    if (error) throw new Error(`[ingest] upsert failed at batch ${i}: ${error.message}`);

    embedded += batch.length;
    console.log(`[ingest] embedded + upserted ${embedded}/${todo.length}`);
  }

  // Final sanity check: confirm row counts.
  const { count, error: countErr } = await supabase
    .from("grounding_chunks")
    .select("*", { count: "exact", head: true });
  if (countErr) throw new Error(`[ingest] count failed: ${countErr.message}`);
  console.log(`[ingest] done. grounding_chunks total rows = ${count}`);
}

main().catch((e) => {
  console.error("[ingest] fatal:", e);
  process.exit(1);
});
