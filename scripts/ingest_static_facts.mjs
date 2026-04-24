#!/usr/bin/env node
/**
 * Ingest static Scaler facts into grounding_chunks.
 *
 * Reads data/scaler_static_facts.json, embeds each fact with voyage-3-large,
 * and upserts into the grounding_chunks table keyed on (url, content_hash).
 *
 * Run: node scripts/ingest_static_facts.mjs
 *      (reads .env.local automatically via inline loader below)
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ── Load .env.local ────────────────────────────────────────────────────────────
const envPath = join(ROOT, ".env.local");
if (!existsSync(envPath)) {
  console.error("[ingest_static_facts] .env.local not found at", envPath);
  process.exit(1);
}
const raw = readFileSync(envPath, "utf8");
for (const line of raw.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq <= 0) continue;
  const key = trimmed.slice(0, eq).trim();
  let val = trimmed.slice(eq + 1).trim();
  if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
  if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
  process.env[key] = val;
}

// ── Config ─────────────────────────────────────────────────────────────────────
const VOYAGE_API_BASE = "https://api.voyageai.com/v1";
const VOYAGE_EMBED_MODEL = "voyage-3-large";
const VOYAGE_EMBED_DIM = 1024;
const EMBED_BATCH = 32; // smaller batch for static facts (fewer items)

// ── Helpers ────────────────────────────────────────────────────────────────────
function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

async function voyageEmbed(texts) {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error("VOYAGE_API_KEY missing");

  const r = await fetch(`${VOYAGE_API_BASE}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      input: texts,
      model: VOYAGE_EMBED_MODEL,
      input_type: "document",
    }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`voyage embed ${r.status}: ${body.slice(0, 300)}`);
  }
  const json = await r.json();
  return json.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

function supabaseHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY missing");
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Prefer: "return=minimal,resolution=ignore-duplicates",
  };
}

function supabaseUrl(path) {
  const base = process.env.SUPABASE_URL;
  if (!base) throw new Error("SUPABASE_URL missing");
  return `${base}/rest/v1${path}`;
}

async function supabaseSelect(table, select, filters) {
  const params = new URLSearchParams({ select });
  for (const [k, v] of Object.entries(filters)) params.append(k, v);
  const r = await fetch(`${supabaseUrl(`/${table}`)}?${params}`, {
    headers: supabaseHeaders(),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`supabase select ${r.status}: ${body.slice(0, 300)}`);
  }
  return r.json();
}

async function supabaseUpsert(table, rows, onConflict) {
  const headers = { ...supabaseHeaders() };
  // Override Prefer to use upsert semantics
  headers["Prefer"] = `resolution=merge-duplicates,return=minimal`;
  const r = await fetch(
    `${supabaseUrl(`/${table}`)}?on_conflict=${encodeURIComponent(onConflict)}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(rows),
    }
  );
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`supabase upsert ${r.status}: ${body.slice(0, 300)}`);
  }
  return r;
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const factsPath = join(ROOT, "data", "scaler_static_facts.json");
  if (!existsSync(factsPath)) {
    throw new Error(`Facts file not found: ${factsPath}`);
  }

  const facts = JSON.parse(readFileSync(factsPath, "utf8"));
  console.log(`[ingest_static_facts] loaded ${facts.length} facts from ${factsPath}`);

  // Build chunk rows from facts
  const chunks = facts.map((fact) => {
    const chunkText = `[${fact.topic} / ${fact.program}] ${fact.text}`;
    const contentHash = sha256(chunkText);
    return {
      fact_id: fact.id,
      topic: fact.topic,
      program: fact.program,
      source_url: fact.source_url,
      section_path: fact.section_path,
      chunk_text: chunkText,
      content_hash: contentHash,
      effective_date: fact.effective_date,
    };
  });

  // Check which content_hashes already exist to avoid redundant embedding
  const hashes = chunks.map((c) => c.content_hash);
  const existingSet = new Set();
  // PostgREST in() filter: content_hash=in.(hash1,hash2,...)
  const inFilter = `(${hashes.map((h) => `"${h}"`).join(",")})`;
  const existing = await supabaseSelect(
    "grounding_chunks",
    "content_hash",
    { "content_hash": `in.${inFilter}` }
  );
  for (const row of existing) existingSet.add(row.content_hash);

  const todo = chunks.filter((c) => !existingSet.has(c.content_hash));
  console.log(
    `[ingest_static_facts] ${existingSet.size} already in DB; ${todo.length} new chunks to embed + upsert`
  );

  if (todo.length === 0) {
    console.log("[ingest_static_facts] nothing new — done.");
    await printSummary(facts);
    return;
  }

  // Embed in batches
  let upserted = 0;
  for (let i = 0; i < todo.length; i += EMBED_BATCH) {
    const batch = todo.slice(i, i + EMBED_BATCH);
    const texts = batch.map((c) => c.chunk_text);
    const vectors = await voyageEmbed(texts);

    if (vectors.length !== batch.length) {
      throw new Error(
        `voyage returned ${vectors.length} vectors for ${batch.length} inputs`
      );
    }
    if (vectors[0].length !== VOYAGE_EMBED_DIM) {
      throw new Error(
        `unexpected embed dim ${vectors[0].length} — schema expects ${VOYAGE_EMBED_DIM}`
      );
    }

    const now = new Date().toISOString();
    const rows = batch.map((c, j) => ({
      // grounding_chunks schema: url, section_path (text[]), text, span_chars (int4range), content_hash, fetched_at, embedding
      url: c.source_url,
      section_path: c.section_path.split(" > "), // convert string path to array
      text: c.chunk_text,
      span_chars: null, // static facts have no character span
      content_hash: c.content_hash,
      fetched_at: now,
      embedding: vectors[j], // pgvector accepts JSON array
    }));

    await supabaseUpsert("grounding_chunks", rows, "url,content_hash");
    upserted += batch.length;
    console.log(
      `[ingest_static_facts] embedded + upserted ${upserted}/${todo.length}`
    );
  }

  await printSummary(facts);
}

async function printSummary(facts) {
  // Count by topic
  const byTopic = {};
  for (const f of facts) {
    byTopic[f.topic] = (byTopic[f.topic] || 0) + 1;
  }
  const sorted = Object.entries(byTopic).sort((a, b) => b[1] - a[1]);
  console.log(`\n[ingest_static_facts] Summary: ${facts.length} total facts`);
  console.log("  Top 3 topics:");
  for (const [topic, count] of sorted.slice(0, 3)) {
    console.log(`    ${topic}: ${count} facts`);
  }

  // Query total grounding_chunks count
  const headers = { ...supabaseHeaders() };
  headers["Prefer"] = "count=exact";
  const r = await fetch(
    `${supabaseUrl("/grounding_chunks")}?select=id&limit=1`,
    { method: "HEAD", headers }
  );
  const total = r.headers.get("content-range");
  console.log(`\n[ingest_static_facts] grounding_chunks total rows = ${total ?? "(unknown)"}`);
}

main().catch((e) => {
  console.error("[ingest_static_facts] fatal:", e);
  process.exit(1);
});
