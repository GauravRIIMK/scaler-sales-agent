-- Scaler Sales Agent — hybrid retrieval RPC
-- Task 1.2 per BUILD_PLAN.md. Implements Reciprocal Rank Fusion (RRF, k=60) over
--   (a) BM25 via tsv @@ plainto_tsquery (ts_rank_cd)
--   (b) dense cosine via pgvector (<=> operator)
-- Returns the top match_k candidates; the Node layer reranks with voyage rerank-2.5
-- and gates on rerank_score < 0.35 → refuse, per BLUEPRINT §4.

-- Safe to re-run: `create or replace` everywhere.

-- ─────────────────────────────────────────────────────────────
-- retrieve_hybrid
-- Inputs:
--   query_text      plain search string (tsquery built server-side)
--   query_embedding 1024-d vector from voyage-3-large (input_type=query)
--   match_k         final rows returned (default 40 = fusion pool before rerank)
--   rrf_k           RRF damping constant (default 60, industry standard)
--   bm25_pool       rows to consider from BM25 side (default 80)
--   dense_pool      rows to consider from vector side (default 80)
-- Output:
--   id, url, section_path, text, bm25_rank (nullable), dense_rank (nullable), rrf_score
--   Ordered by rrf_score desc.
-- ─────────────────────────────────────────────────────────────
create or replace function retrieve_hybrid(
  query_text      text,
  query_embedding vector(1024),
  match_k         int default 40,
  rrf_k           int default 60,
  bm25_pool       int default 80,
  dense_pool      int default 80
)
returns table (
  id           uuid,
  url          text,
  section_path text[],
  text         text,
  bm25_rank    int,
  dense_rank   int,
  bm25_score   real,
  dense_score  real,
  rrf_score    double precision
)
language sql
stable
parallel safe
as $$
  with q as (
    select plainto_tsquery('english', coalesce(query_text, '')) as tsq
  ),
  bm25 as (
    select
      gc.id,
      ts_rank_cd(gc.tsv, q.tsq) as score,
      row_number() over (order by ts_rank_cd(gc.tsv, q.tsq) desc) as rank
    from grounding_chunks gc, q
    where gc.tsv @@ q.tsq
    order by score desc
    limit bm25_pool
  ),
  dense as (
    -- cosine similarity = 1 - cosine distance. <=> is distance, smaller = closer.
    select
      gc.id,
      (1 - (gc.embedding <=> query_embedding))::real as score,
      row_number() over (order by gc.embedding <=> query_embedding asc) as rank
    from grounding_chunks gc
    where gc.embedding is not null
    order by gc.embedding <=> query_embedding asc
    limit dense_pool
  ),
  fused as (
    select
      coalesce(b.id, d.id)                                    as id,
      b.rank::int                                             as bm25_rank,
      d.rank::int                                             as dense_rank,
      b.score                                                 as bm25_score,
      d.score                                                 as dense_score,
      coalesce(1.0 / (rrf_k + b.rank), 0.0)
        + coalesce(1.0 / (rrf_k + d.rank), 0.0)               as rrf_score
    from bm25 b
    full outer join dense d on d.id = b.id
  )
  select
    gc.id,
    gc.url,
    gc.section_path,
    gc.text,
    f.bm25_rank,
    f.dense_rank,
    f.bm25_score,
    f.dense_score,
    f.rrf_score
  from fused f
  join grounding_chunks gc on gc.id = f.id
  order by f.rrf_score desc, gc.id
  limit match_k;
$$;

comment on function retrieve_hybrid is
  'RRF (k=60) fusion of BM25 (tsv) + dense cosine (pgvector) over grounding_chunks.
   Returns top match_k rows; caller reranks with voyage rerank-2.5 and applies the
   refuse gate (score < 0.35 → refuse) per BLUEPRINT §4.';

-- ─────────────────────────────────────────────────────────────
-- retrieve_dense_only
-- Debugging helper — pure vector search. Useful when BM25 returns zero hits
-- (e.g. query in Hindi) or when diagnosing embedding drift.
-- ─────────────────────────────────────────────────────────────
create or replace function retrieve_dense_only(
  query_embedding vector(1024),
  match_k int default 20
)
returns table (
  id           uuid,
  url          text,
  section_path text[],
  text         text,
  score        real
)
language sql
stable
parallel safe
as $$
  select
    gc.id,
    gc.url,
    gc.section_path,
    gc.text,
    (1 - (gc.embedding <=> query_embedding))::real as score
  from grounding_chunks gc
  where gc.embedding is not null
  order by gc.embedding <=> query_embedding asc
  limit match_k;
$$;

comment on function retrieve_dense_only is
  'Pure dense cosine-similarity search against grounding_chunks. Debug / fallback only.';

-- ─────────────────────────────────────────────────────────────
-- Permissions
-- service_role bypasses; we explicitly revoke anon + authenticated so the RPC
-- is only callable server-side. Keeps attack surface tight.
-- ─────────────────────────────────────────────────────────────
revoke all on function retrieve_hybrid(text, vector, int, int, int, int) from public, anon, authenticated;
revoke all on function retrieve_dense_only(vector, int) from public, anon, authenticated;
grant execute on function retrieve_hybrid(text, vector, int, int, int, int) to service_role;
grant execute on function retrieve_dense_only(vector, int) to service_role;
