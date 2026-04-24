# Scaler Sales Agent — Meticulous Build Plan (Ship-Today)
## Phase A — MVP today. Phase B — post-demo backlog.

> **Single source of truth for this build.** Every task below inherits the universal acceptance tests in §2, the logging / fallback / double-verify conventions in §3, and the agent roster in §4. Anything that contradicts this file loses.

---

## §1. Ship target (what "done" means today)

A publicly deployed Vercel URL where:

1. An evaluator lands on a form, enters their own WhatsApp number.
2. They upload **their own** lead profile (JSON or form fields) + call input (text transcript OR audio file) — **the system must not have hardcoded knowledge of the three demo personas or their data**.
3. Within ≤90 s (text path) or ≤180 s (audio path), the BDA-view shows a generated PDF preview + covering message with `Approve / Edit / Skip` buttons.
4. On **Approve** → a real PDF lands on the evaluator's WhatsApp with a personalised covering text.
5. A pre-call BDA nudge also lands on the evaluator's WhatsApp (BDA-facing, no approval gate).
6. scaler.com-grounded claims carry visible `[scaler.com · fetched Nd ago]` footers; unsupported claims refuse with "let me confirm and get back."
7. Three demo personas (Rohan, Karthik, Meera) produce **visibly different** PDFs AND **a novel 4th persona** (live-uploaded during demo review) also produces a distinct, non-generic PDF.

Throughput target: **20-30 cases/day**. Not scaling to 10k/day today; Phase B.

---

## §2. Universal acceptance tests (inherited by every task)

These are the two constraints you explicitly flagged, hardened into enforced gates:

| ID | Test | How verified |
|---|---|---|
| **AT-01** | **Dynamic persona handling** — a live-uploaded profile outside the three demo personas (e.g. *"Priya, 28, product-manager at a D2C startup, wants to understand if Scaler DS helps her make data-driven decisions without becoming a coder"*) runs end-to-end, emits a persona vector with **≥3 of 5 axes labelled non-unknown**, and renders a PDF whose visual identity is distinct from the 3 demo PDFs | Smoke test in Task 5.2 + post-gate reviewer on every generator task |
| **AT-02** | **Arbitrary upload** — evaluator uploads a profile with field names in different order, an audio file with different codec, or a transcript with unusual formatting → pipeline normalises and succeeds | Task 2.1 includes 8 fuzzed inputs as unit tests |
| **AT-03** | **No scaler.com hallucination** — a test question "does Scaler offer a 3-month AI bootcamp?" (no such program exists) → retrieve refuses, generator emits honest-uncertainty template, verifier approves | Task 3.3 unit test + smoke test 5.2 |
| **AT-04** | **Visible PDF differentiation** — for any triplet of personas, pairwise cosine similarity of rendered text embeddings < 0.85 AND primary color / section order differs | Task 3.4 post-gate check + Task 5.2 smoke |
| **AT-05** | **PDF lands on WhatsApp as native document** (not wa.me link) | Task 4.1 post-gate + Task 5.2 smoke |
| **AT-06** | **Approval gate is durable** — refresh the preview page mid-review, state survives | Task 4.2 post-gate |
| **AT-07** | **Every LLM call is logged** with model, tokens, latency, prompt-version, case_id | Global — reviewer-post checks `agent_logs` row count per case |
| **AT-08** | **Every external API call has a fallback path** exercised in at least one happy-path log | Global — reviewer-post greps code for try/catch + fallback invocation |

A task is **not** marked complete until its own acceptance criteria AND every inherited AT that touches its surface are green.

---

## §3. Universal conventions

### 3.1 Double-verify gate (per task — hybrid of (a) + (b))

```
┌──────────────────────────────────────────────────────────────┐
│  PRE-GATE (reviewer-pre)                                      │
│    Input:  task brief + BLUEPRINT.md reference + this file   │
│    Ask:    does this brief satisfy the cited requirements?   │
│            does it miss any inherited AT?                    │
│            does it over-scope (unnecessary work)?            │
│    Output: PASS | REVISE {reasons[]} | BLOCK {blocker}       │
│    MCP:    Read                                              │
│    Skill:  sequential-thinking                                │
└──────────────────────────────────────────────────────────────┘
                         │ PASS
                         ▼
┌──────────────────────────────────────────────────────────────┐
│  EXECUTOR                                                     │
│    writes code / runs commands / produces artefact            │
└──────────────────────────────────────────────────────────────┘
                         │ artefact
                         ▼
┌──────────────────────────────────────────────────────────────┐
│  POST-GATE (reviewer-post — MUST be different instance)      │
│    Input:  artefact + task brief + acceptance criteria        │
│    Ask:    does output meet every AC & inherited AT?          │
│            any hallucinated API / lib / magic number?        │
│            any edge case from §4.8 of BLUEPRINT missed?      │
│            are log points in place?                           │
│            is fallback wired?                                 │
│    Output: PASS | FIX {patch-list}                            │
│    MCPs:   Read, Grep, Bash (tests), Context7 (API verify)   │
│    Skill:  output-discipline                                  │
└──────────────────────────────────────────────────────────────┘
                         │ PASS
                         ▼
                  TASK COMPLETE
```

Pre-gate and post-gate are **different** sub-agent instances so critique is adversarial, not rubber-stamp. If post-gate returns FIX, executor patches and post-gate re-runs. Max 3 loops — if still failing, escalate to orchestrator.

### 3.2 Logging convention — every request inserts a row

```sql
-- Supabase table: agent_logs
CREATE TABLE agent_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       UUID,                    -- nullable for system events
  task_id       TEXT,                    -- e.g. "3.2"
  component     TEXT,                    -- e.g. "pdf_content_generator"
  level         TEXT CHECK (level IN ('DEBUG','INFO','WARN','ERROR','FATAL')),
  event         TEXT,                    -- e.g. "anthropic_call_start"
  provider      TEXT,                    -- e.g. "anthropic", "deepgram", "voyage"
  model         TEXT,                    -- e.g. "claude-opus-4-7"
  prompt_version TEXT,                   -- hash of prompt template
  tokens_in     INT,
  tokens_out    INT,
  latency_ms    INT,
  attempt       INT DEFAULT 1,           -- 1 = primary, 2+ = fallback/retry
  fallback_of   TEXT,                    -- primary provider name if fallback fired
  error_code    TEXT,
  error_message TEXT,
  payload       JSONB,                   -- redacted request/response snippets
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX agent_logs_case_idx ON agent_logs(case_id, created_at);
CREATE INDEX agent_logs_error_idx ON agent_logs(level, created_at) WHERE level IN ('ERROR','FATAL');
```

A simple `/admin/logs` page streams last 200 rows; ERROR + FATAL bubble to a toast in the approval UI.

Every external-API wrapper must emit at least `*_start` and `*_end` (or `*_error`) rows.

### 3.3 Fallback pattern — every external dep has a chain

```typescript
// shared/fallback.ts
export async function withFallback<T>(
  chain: Array<{ name: string; fn: () => Promise<T> }>,
  ctx: { caseId: string; taskId: string; component: string },
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < chain.length; i++) {
    const { name, fn } = chain[i];
    const started = Date.now();
    try {
      await log({ ...ctx, event: `${name}_start`, provider: name, attempt: i + 1 });
      const result = await fn();
      await log({ ...ctx, event: `${name}_ok`, provider: name, attempt: i + 1,
                  latency_ms: Date.now() - started });
      return result;
    } catch (e) {
      lastError = e;
      await log({ ...ctx, event: `${name}_error`, provider: name, attempt: i + 1,
                  level: "WARN", error_message: String(e),
                  latency_ms: Date.now() - started });
    }
  }
  await log({ ...ctx, event: "all_fallbacks_exhausted", level: "ERROR",
              error_message: String(lastError) });
  throw lastError;
}
```

Per-component chains (P=primary, F=fallback, R=recovery):

| Component | P | F1 | F2 / R |
|---|---|---|---|
| STT | Deepgram Nova-3 | Whisper via Groq API | Client-side Web Speech API → manual-paste textbox |
| Reranker | Voyage rerank-2.5 | Cohere trial key (Phase B) | Score by raw dense+BM25 RRF only; raise refuse threshold from 0.35 → 0.55 to compensate |
| Embedder | Voyage-3-large | OpenAI text-embedding-3-small | Cached corpus embeddings only (no new queries; refuse unknown questions) |
| LLM (Haiku/Sonnet/Opus) | Anthropic direct | Anthropic retry with exp-backoff (3 attempts) | Haiku for all tiers with extended prompt; flag `degraded_mode=true` |
| PDF render | `@react-pdf/renderer` (Node) | HTML→PDF via Puppeteer on Vercel | Markdown-rendered `.md` as attachment + WhatsApp text |
| WhatsApp send | Twilio user's Business number | Twilio Sandbox | wa.me link with hosted Supabase Storage URL + visible warning banner |
| Supabase Storage | Supabase | Vercel Blob | Base64-inline in DB (last resort) |
| Corpus fetch | Firecrawl MCP | Direct `fetch()` + cheerio parse | Hand-curated seed corpus (committed JSON in repo) |

### 3.4 Error taxonomy & retry policy

| Code class | Retry? | Backoff |
|---|---|---|
| 408 / 429 / 5xx from any provider | Yes, up to 3× | exp: 1s → 3s → 8s |
| 4xx (non-429) | No | escalate to fallback chain |
| Network timeout | Yes, up to 2× | 2s → 5s |
| Verifier `no` on >30% of claims | Regenerate (G3 Reflexion loop) once | immediate |
| Cosine-convergence > 0.82 across demo triplet | Regenerate with stronger persona-weighting | immediate |
| Any FATAL | Stop case; mark `FAILED` in DB; toast in UI | — |

### 3.5 Universal env / secret contract

All written to Vercel env + `.env.local`:

```
ANTHROPIC_API_KEY
VOYAGE_API_KEY
DEEPGRAM_API_KEY
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
TWILIO_WHATSAPP_FROM          # +<user's business #> OR "whatsapp:+14155238886" (sandbox)
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_BUCKET_PDFS=scaler-sales-pdfs
SUPABASE_BUCKET_AUDIO=scaler-sales-audio
PUBLIC_APP_URL                # for Twilio statusCallback
OPENAI_API_KEY                # only if fallback fires; optional
GROQ_API_KEY                  # only if STT fallback fires; optional
```

Missing optional keys → fallback tier disabled; system logs WARN; primary still works.

---

## §4. Agent roster

All agents are spawned via the Claude Code `Agent` tool in this session. Subagent types:

| Agent role | Subagent type | MCPs available | Skills |
|---|---|---|---|
| **Orchestrator** (me, main thread) | — | all | meticulous-orchestrator, output-discipline, second-order-thinking |
| **Researcher** (`R1..Rn`) | `researcher` | Filesystem, Context7, Firecrawl, Perplexity, Sequential-thinking, Web{Fetch,Search}, `exa_web_search` | research-depth-discipline, sequential-thinking |
| **Executor** (`E1..En`) | `executor` | Filesystem, Context7, Playwright, Bash | output-discipline |
| **Reviewer-pre** (`Vpre-N.M`) | `reviewer` | Filesystem, Grep | sequential-thinking |
| **Reviewer-post** (`Vpost-N.M`) | `reviewer` | Filesystem, Grep, Context7, Bash (tests) | output-discipline, second-order-thinking |
| **Explore** | `Explore` | read-only scout for existing code | — |

Convention: within a single task, `Vpre` and `Vpost` are **separate Agent-tool calls** so they cannot collude. Executors can themselves sub-spawn researchers for one-shot API lookups (e.g. Context7 for Deepgram Node SDK surface).

---

## §5. Stack (final, locked)

| Layer | Choice | Why (ship-today) |
|---|---|---|
| Frontend | **Next.js 14 App Router + Tailwind + shadcn/ui** | v0-compatible, Vercel-native |
| Backend | **Next.js API routes + Vercel Functions (Node 20)** — Fluid compute for long timeouts | One runtime, one deploy |
| DB + vectors + storage + auth | **Supabase** (Postgres 15 + pgvector + Storage + RLS) | 1 account replaces 4 |
| Reranker | **Voyage rerank-2.5** (you have key) | Skip Cohere account |
| Embedder | **voyage-3-large** (you have key) | — |
| LLMs | **Anthropic** — Haiku 4.5 / Sonnet 4.6 / Opus 4.7 (you have key) | — |
| STT | **Deepgram Nova-3** (`language=multi`, `diarize=true`) | Hinglish code-switch verified |
| PDF render | **`@react-pdf/renderer`** | Pure Node, zero binary deps on Vercel |
| Corpus crawl | **Firecrawl MCP** (already in this env) | Handles scaler.com JS-rendered pages |
| WhatsApp | **Twilio** — first try user's Business number; fallback Sandbox | You have Twilio acct |
| Orchestration | **Direct `fetch` + hand-rolled state machine in Postgres** (no LangGraph today) | Cuts one dependency; state in DB row `state` column |
| Observability | **Supabase `agent_logs` table + `/admin/logs` page** | Langfuse deferred to Phase B |

---

## §6. Environment & secrets checklist (you action in parallel while I scaffold)

| # | Account | What to do | When to share with me |
|---|---|---|---|
| 1 | Vercel | Sign up (GitHub OAuth recommended). Connect a new project — name `scaler-sales-agent`. Get a personal token for CLI from `vercel.com/account/tokens`. | After Task 0.1 — I'll deploy first time together |
| 2 | Supabase | Sign up. Create project (pick AWS Singapore / Mumbai region). Copy `URL`, `anon key`, `service_role` key from Settings → API. Enable `vector` extension: Database → Extensions → search "vector" → enable. | After Task 0.2 |
| 3 | Deepgram | Sign up, free $200 credit. Copy API key from Console. | After Task 2.2 |
| 4 | Twilio WhatsApp | **Decision tree**: (a) Go to Twilio Console → Messaging → Try it out → Send a WhatsApp message. If your Business number shows a "WhatsApp enabled" badge, I use it directly. (b) If not, activate Sandbox — copy the "join <word>" phrase; you (and the evaluator) text it once from your WhatsApp. | After Task 4.1 |
| 5 | **Already live** | Anthropic, Voyage | Share now into `.env.local` |

---

## §7. Task DAG (timeline, parallelism marked)

```
  P0 ──┬── 0.1 repo scaffold ───────┐
       │                            │
       ├── 0.4 supabase schema ─────┤
       │                            ├──▶ P1 start
       ├── 0.5 scaler corpus crawl ─┘
       │                            ▼
       └── 0.6 env/secrets wire ──▶ 1.1 chunk+embed ──▶ 1.2 retrieve ──▶ 1.3 rerank+refuse
                                                                              │
                                        ┌─────────────────────────────────────┤
                                        ▼                                     ▼
  P2 ── 2.1 input ingester ──┬── 2.2 STT ─────┐                    (ready for P3)
                             │                 ▼
                             └── 2.3 extractor ──┬── 2.4 persona ──────────▶ P3
                                                 │
  P3 ──────────────────────────────────────────► 3.1 BDA nudge
                                                 3.2 PDF content ──▶ 3.3 verifier ──▶ 3.4 render
                                                                                         │
  P4 ──────────────────────────────────────────────────────────────────────────────────▶ 4.1 Twilio
                                                                                         4.2 approval UI
                                                                                         4.3 statusCallback
                                                                                         │
  P5 ──────────────────────────────────────────────────────────────────────────────────▶ 5.1 deploy
                                                                                         5.2 smoke
                                                                                         5.3 README
                                                                                         5.4 Loom
```

Parallel lanes collapse to ~7 hours wall clock if sub-agents execute independent tasks in parallel waves.

---

## §8. Task specifications

Each task uses the template:
> **Owner** · **Pre-gate** · **Post-gate** · **MCPs** · **Skills** · **Depends** · **Inputs** · **Output** · **AC** (acceptance criteria) · **Log points** · **Fallback** · **Time**

---

### Task 0.1 — Repo scaffold

- **Owner**: E-setup
- **Pre-gate**: Vpre-0.1 (reads BLUEPRINT §6.4 + this file §5)
- **Post-gate**: Vpost-0.1
- **MCPs**: Filesystem, Bash
- **Skills**: output-discipline
- **Depends**: none
- **Inputs**: blueprint stack table
- **Output**: `./package.json`, `./next.config.mjs`, `./tsconfig.json`, `./tailwind.config.ts`, `./app/layout.tsx`, `./app/page.tsx` (empty onboarding stub), `./lib/supabase.ts`, `./lib/log.ts`, `./lib/fallback.ts`, `./lib/anthropic.ts`, `./lib/voyage.ts`, `./lib/deepgram.ts`, `./lib/twilio.ts`, `./.env.example`, `./.gitignore`, `./README.md` (skeleton)
- **AC**: `pnpm install && pnpm build` succeeds locally. `pnpm dev` serves a blank page at `localhost:3000`.
- **Log points**: N/A at this stage; `lib/log.ts` implemented but no-ops until Supabase wired.
- **Fallback**: npm if pnpm unavailable on this box.
- **Time**: 20 min

---

### Task 0.2 — Supabase schema & migrations

- **Owner**: E-db
- **Pre-gate**: Vpre-0.2 (reads BLUEPRINT §6.3 schemas + §2.6.2 SQL)
- **Post-gate**: Vpost-0.2 (runs `pnpm supabase db diff`)
- **MCPs**: Filesystem, Bash
- **Skills**: sequential-thinking
- **Depends**: 0.1
- **Inputs**: BLUEPRINT §6.3 Pydantic schemas → translate to Postgres DDL
- **Output**: `supabase/migrations/0001_init.sql` with tables: `lead_cases`, `grounding_chunks` (w/ `embedding vector(1024)`), `bda_edits`, `agent_logs`, `prompt_templates`, `delivery_events`. pgvector + pg_trgm extensions enabled. RLS policies: service_role full, anon none.
- **AC**: migration applies clean to a new Supabase project; all 6 tables + 2 indexes + 1 vector index (`ivfflat` on `grounding_chunks.embedding`) present.
- **Log points**: — (schema)
- **Fallback**: if Supabase not yet signed-up when this runs, emit DDL to file; apply on arrival.
- **Time**: 25 min

---

### Task 0.3 — Secrets wiring + env validator

- **Owner**: E-setup
- **Pre-gate**: Vpre-0.3
- **Post-gate**: Vpost-0.3
- **MCPs**: Filesystem
- **Skills**: output-discipline
- **Depends**: 0.1
- **Inputs**: §3.5 env contract
- **Output**: `lib/env.ts` using `zod` to validate all required env vars at boot; `app/api/health/route.ts` returns `{status, missing_env[]}`.
- **AC**: with zero env vars set, `/api/health` reports every missing var by name; with full set, returns `ok`.
- **Log points**: `app_boot_env_missing` WARN on any missing optional, FATAL on missing required.
- **Fallback**: N/A
- **Time**: 15 min

---

### Task 0.4 — Scaler.com corpus crawl

- **Owner**: R-corpus (researcher)
- **Pre-gate**: Vpre-0.4 (confirms URL list from BLUEPRINT §2.7.2)
- **Post-gate**: Vpost-0.4 (spot-checks that known facts like "₹3,99,000" appear verbatim in the output JSON)
- **MCPs**: **Firecrawl** primary (`firecrawl_scrape` with `onlyMainContent=true, waitFor=2000`), Filesystem, WebFetch as fallback
- **Skills**: research-depth-discipline
- **Depends**: 0.1
- **Inputs**: URL list: `/academy/`, `/ai-machine-learning-course/`, `/data-science-course/`, `/devops-course/`, `/`, `/blog/` (for alumni stories), `/testimonials/`
- **Output**: `data/scaler_corpus.json` — array of `{url, fetched_at, title, h1, sections: [{heading, path[], text, html}]}`
- **AC**: ≥4 program pages fetched, each with ≥6 distinct sections; known facts like "Domain-Specific RAG System" (AI/ML course) and "₹3,99,000" present verbatim somewhere in corpus.
- **Log points**: `corpus_fetch_{start,ok,error}` per URL
- **Fallback**: Firecrawl → Vercel WebFetch → cheerio+fetch → cached-in-repo JSON (included at commit time as last resort)
- **Time**: 20 min

---

### Task 0.5 — Hand-curated negative corpus + refuse-test fixtures

- **Owner**: E-corpus
- **Pre-gate**: Vpre-0.5 (confirms AT-03 intent)
- **Post-gate**: Vpost-0.5
- **MCPs**: Filesystem
- **Skills**: second-order-thinking
- **Depends**: 0.4
- **Inputs**: AT-03 + misuse modes from BLUEPRINT §4.2
- **Output**: `data/refuse_fixtures.json` — 12 questions Scaler does NOT answer on its site (e.g. "3-month AI bootcamp", "money-back placement guarantee", "Scaler Singapore campus"). Each with expected `refused=true`.
- **AC**: 12 fixtures committed; each test uses a lexical pattern NOT present in `scaler_corpus.json` (verified by `grep -q`).
- **Log points**: —
- **Fallback**: —
- **Time**: 10 min

---

### Task 1.1 — Chunk + embed + upsert to pgvector

- **Owner**: E-index
- **Pre-gate**: Vpre-1.1 (reads BLUEPRINT §2.4.3)
- **Post-gate**: Vpost-1.1 (`SELECT count(*) FROM grounding_chunks` ≥ 40)
- **MCPs**: Filesystem, **Context7** (to verify Voyage Node HTTP contract), Bash
- **Skills**: output-discipline
- **Depends**: 0.2, 0.4
- **Inputs**: `data/scaler_corpus.json`, Voyage API key
- **Output**: `scripts/ingest.ts` — chunks sections to 512-token windows with 64-token overlap, preserves `section_path`, embeds with `voyage-3-large` (input_type="document"), upserts to `grounding_chunks` with `content_hash`, `fetched_at`. Also generates `tsvector` column for BM25.
- **AC**: ≥40 chunks indexed; `pgvector` cosine search returns non-zero results for query "AI curriculum"; `pg_trgm`/tsvector search returns results for "₹3,99,000".
- **Log points**: `ingest_chunk_{embed,upsert}` per chunk; batch counts.
- **Fallback**: voyage → OpenAI `text-embedding-3-small` (dim 1536 — requires schema `embedding vector(1536)` variant OR re-pool to 1024; today we error out to WARN and emit half-ingest)
- **Time**: 30 min

---

### Task 1.2 — Hybrid retrieve RPC

- **Owner**: E-retrieve
- **Pre-gate**: Vpre-1.2 (BLUEPRINT §2.4.5)
- **Post-gate**: Vpost-1.2 (runs 5 fixture queries, asserts top-1 URL is expected)
- **MCPs**: Filesystem, Bash, Context7 (Supabase RPC syntax)
- **Skills**: sequential-thinking
- **Depends**: 1.1
- **Inputs**: —
- **Output**: `supabase/migrations/0002_retrieve_rpc.sql` — `retrieve_hybrid(query_text text, query_embedding vector, k int)` combining BM25 (ts_rank_cd) + cosine, RRF k=60, returns top-k. `app/api/retrieve/route.ts` wrapper.
- **AC**: for query "do you cover RAG", top chunk URL is `/ai-machine-learning-course/` and section_path contains "RAG".
- **Log points**: `retrieve_{start,ok,empty}` with query, k_bm25, k_dense, k_rrf.
- **Fallback**: dense-only cosine if tsvector missing.
- **Time**: 25 min

---

### Task 1.3 — Voyage rerank + refuse gate

- **Owner**: E-rerank
- **Pre-gate**: Vpre-1.3
- **Post-gate**: Vpost-1.3 (assert AT-03 passes against `refuse_fixtures.json`)
- **MCPs**: Context7 (Voyage rerank API), Filesystem, Bash
- **Skills**: output-discipline
- **Depends**: 1.2, 0.5
- **Inputs**: `voyage-rerank-2.5` API
- **Output**: `lib/retrieve.ts` wrapping the RPC, calls `voyage rerank-2.5` on top-20 hybrid hits, returns top-5 with `rerank_score`. If top-1 `rerank_score < 0.35` → `{refused: true, reason: "no_supporting_evidence"}`.
- **AC**: all 12 fixtures in `refuse_fixtures.json` return `refused: true`; all 5 fixtures of scaler.com-supported questions return `refused: false` with non-empty top-5.
- **Log points**: `rerank_{start,ok}`, `retrieve_refused` with question.
- **Fallback**: if voyage rerank 5xx, fall back to dense+bm25 RRF score with threshold raised to 0.55.
- **Time**: 25 min

---

### Task 2.1 — Input ingester (arbitrary profile + text OR audio)

- **Owner**: E-ingest
- **Pre-gate**: Vpre-2.1 (reads AT-02 — arbitrary upload)
- **Post-gate**: Vpost-2.1 (runs 8 fuzzed inputs)
- **MCPs**: Filesystem, Context7 (Next.js file-upload patterns, Supabase Storage signed URL)
- **Skills**: generative-problem-solving
- **Depends**: 0.2
- **Inputs**: —
- **Output**: 
  - `app/api/cases/route.ts` (POST) — accepts `multipart/form-data` with either `transcript_text` OR `audio_file` + a `profile` JSON. Normalises profile field names (`name|fullName|lead_name` → `name`, etc.) via a permissive mapper. Writes `lead_cases` row with state `INGESTED`. Signed-upload URL for audio goes direct to Supabase Storage bucket `scaler-sales-audio` (client bypasses Next's 4 MB body limit).
  - `components/UploadForm.tsx` — a single page with phone + profile JSON textarea + file picker (accepts `.mp3,.m4a,.wav,.ogg,.mp4,.txt`).
- **AC (the AT-02 fuzz bank)**:
  1. profile with `full_name` instead of `name` → normalised
  2. profile with fields in reverse order → normalised
  3. profile missing `yoe` → persona inferencer gets `yoe: null`
  4. transcript with `\r\n` line endings → accepted
  5. audio upload of `.m4a` → signed-URL upload succeeds
  6. audio upload of 22 MB file → signed-URL upload succeeds (no 4MB block)
  7. both transcript AND audio provided → prefer transcript, log INFO
  8. neither provided → 400 with readable message
- **Log points**: `case_ingest_{start,ok}`, `audio_upload_{requested,ok,error}`.
- **Fallback**: if Supabase signed upload fails, accept smaller files (<4 MB) via Next.js body directly.
- **Time**: 45 min

---

### Task 2.2 — Deepgram STT with diarisation

- **Owner**: E-stt
- **Pre-gate**: Vpre-2.2 (BLUEPRINT §2.3.2)
- **Post-gate**: Vpost-2.2
- **MCPs**: Context7 (Deepgram Node SDK surface), Filesystem, Bash
- **Skills**: output-discipline
- **Depends**: 2.1
- **Inputs**: audio signed URL, `DEEPGRAM_API_KEY`
- **Output**: `app/api/cases/[id]/stt/route.ts` — calls Deepgram prerecorded API with `model=nova-3, diarize=true, utterances=true, language=multi, detect_language=true`. Persists turns array to `lead_cases.transcript_turns` JSONB. Heuristic speaker ID (see §2.3.4 blueprint — Scaler-word-match; default longest-utterance = LEAD).
- **AC**: for a sample Hinglish-ish test audio (a 30-s file I will generate via text-to-speech as fixture), returns ≥2 turns with labels `BDA` and `LEAD`; language `en-IN` or `multi`.
- **Log points**: `stt_{start,ok,error}`, `stt_fallback_invoked`.
- **Fallback**: Deepgram → Groq Whisper (`whisper-large-v3`) + heuristic speaker ID (no diarisation, so LEAD = second voice using pyannote-equivalent-lite: take first 3s of each speaker segment and cluster by MFCC if we have `node-ffmpeg`; else fall back to turn-index-parity heuristic). Final fallback: UI shows a textarea asking user to paste transcript.
- **Time**: 35 min

---

### Task 2.3 — Two-pass question extractor (Q3 from BLUEPRINT §3.2)

- **Owner**: E-extract
- **Pre-gate**: Vpre-2.3 (reads §3.2 pass1/pass2 design)
- **Post-gate**: Vpost-2.3 (runs against Rohan/Karthik/Meera transcripts — assert extract_f1 ≥ 0.85 against hand-labelled truth)
- **MCPs**: Context7 (Anthropic tool-use JSON schema), Filesystem
- **Skills**: output-discipline, sequential-thinking
- **Depends**: 2.1
- **Inputs**: `transcript_turns` or raw text, Anthropic key
- **Output**: `lib/extract.ts` — (a) Haiku structured-output pass extracts `concerns[]` from LEAD turns only (stated+implicit); (b) Sonnet rewrites each as a retrievable question + evidence_type tag. Persists to `lead_cases.extracted_questions` JSONB.
- **AC**:
  - Rohan transcript → ≥3 questions incl. "Andrew Ng free vs paid", "salary-jump ROI from 14 LPA TCS", "RAG/agents/evals depth"
  - Karthik → "what to learn beyond papers", "cohort calibre", "instructor production-AI credibility"
  - Meera → "placement guarantee", "affordability / EMI", "entrance test anxiety"
  - An **unseen 4th transcript** (I generate from a product-manager persona during post-gate) → ≥2 sensible questions, not garbage.
- **Log points**: `extract_pass1`, `extract_pass2`, tokens.
- **Fallback**: if Sonnet 5xx, single-pass Haiku with simpler schema.
- **Time**: 40 min

---

### Task 2.4 — Dynamic 5-axis persona inferencer (AT-01's backbone)

- **Owner**: E-persona
- **Pre-gate**: Vpre-2.4 (reads BLUEPRINT §3.1 P3 compositional vector + AT-01)
- **Post-gate**: Vpost-2.4 (4 fixtures incl. novel)
- **MCPs**: Context7, Filesystem
- **Skills**: generative-problem-solving
- **Depends**: 2.3
- **Inputs**: profile + extracted_questions + transcript excerpt
- **Output**: `lib/persona.ts` — Haiku classifier returns `{career_stage, financial_sensitivity, technical_depth, stakeholder_context, risk_posture, axis_confidences, archetype_label, signals[]}`. Low-confidence axes (<0.6) → "unknown". **No hardcoded class switch** — archetype_label is derived from the axis tuple via a deterministic hash map; any tuple is valid.
- **AC**:
  - Rohan → mid-career-switcher + ROI-sensitive + deep-tech + solo + balanced
  - Karthik → senior + low-financial-sensitivity + deep-tech + solo + risk-tolerant
  - Meera → early-career + high-financial-sensitivity + novice + family-joint + risk-averse
  - **Priya fixture (product-manager)** → mid-career + medium-financial-sensitivity + novice + solo + balanced — 5 axes populated, NOT thrown into one of the 3 demo classes.
  - **AT-01 gate:** novel fixture must populate ≥3 axes with confidence ≥0.6.
- **Log points**: `persona_infer_ok`, `persona_axis_unknown_count`.
- **Fallback**: regex-based fallback classifier using profile keywords ("SDE", "student", "product manager") — flagged `degraded: true`.
- **Time**: 35 min

---

### Task 3.1 — BDA nudge generator (Sonnet)

- **Owner**: E-nudge
- **Pre-gate**: Vpre-3.1 (BLUEPRINT §2.5.5)
- **Post-gate**: Vpost-3.1 (tone check against `teammate-not-memo` rubric; no "Dear BDA")
- **MCPs**: Context7, Filesystem
- **Skills**: output-discipline
- **Depends**: 2.3, 2.4, 1.3
- **Inputs**: profile, questions, persona, top-3 retrieved chunks
- **Output**: `lib/nudge.ts` + `app/api/cases/[id]/nudge/route.ts` — generates ~350-word markdown nudge using the §2.5.5 blueprint. Also generates a ≤600-char WhatsApp-compatible plaintext rendering.
- **AC**: generated for Rohan contains "AI engineering", "₹3.5L vs Coursera", "salary-jump math"; contains `(inferred)` marker on at least one angle; has no "Best regards" / "Dear".
- **Log points**: `nudge_{gen_start,gen_ok}` with tokens.
- **Fallback**: Haiku if Sonnet 5xx.
- **Time**: 30 min

---

### Task 3.2 — PDF content generator (Opus, section-wise G2)

- **Owner**: E-pdfcontent
- **Pre-gate**: Vpre-3.2 (BLUEPRINT §2.5.4 + §3.3 G2)
- **Post-gate**: Vpost-3.2 (checks every Sentence has chunk_ids or certainty="refused"; checks banned-word list)
- **MCPs**: Context7, Filesystem
- **Skills**: output-discipline
- **Depends**: 2.3, 2.4, 1.3
- **Inputs**: profile, questions, persona vector, per-question retrieved chunks
- **Output**: `lib/pdf_content.ts` — for each question, retrieves its own chunk bundle, then Opus generates one `PDFSection` with structured Sentence[] output. Combines into `PDFContent` with ordered sections per `persona.section_order`. `covering_msg` generated as last step.
- **AC**: for Rohan → `PDFContent` has ≥4 sections matching his question list + section_order; every Sentence either cites ≥1 chunk_id OR has `certainty="refused"`; no banned words ("guarantee", "promise", "best", "top") unless chunk contains verbatim.
- **Log points**: `pdf_content_{section_start,section_ok}` per section; total_tokens.
- **Fallback**: Sonnet if Opus 5xx; degraded_mode flag.
- **Time**: 45 min

---

### Task 3.3 — Anti-hallucination verifier (H2 three-moat)

- **Owner**: E-verify
- **Pre-gate**: Vpre-3.3 (BLUEPRINT §2.5.2)
- **Post-gate**: Vpost-3.3 (AT-03 scaler.com test + banned-word test)
- **MCPs**: Context7, Filesystem
- **Skills**: output-discipline, second-order-thinking
- **Depends**: 3.2
- **Inputs**: `PDFContent`, retrieved chunks
- **Output**: `lib/verify.ts` — (moat 1) drop sentences with empty chunk_ids AND certainty≠"inferred"; (moat 2) Haiku verifier per sentence supported/partial/no; (moat 3) regex `₹\d[\d,]*`, `\b\d+\s*LPA\b`, URLs must appear verbatim in a cited chunk; unmatched sentences rewritten as honest-uncertainty template. Returns `{ok_rate, claims_dropped_count, claims_flagged_count}`.
- **AC**: 
  - injecting a sentence "Scaler guarantees 100% placement" into input → dropped.
  - injecting "Our AI course is ₹2,50,000" (wrong number) → dropped (regex unmatched).
  - legitimate "The AI & ML program runs 12 months" → passes with supported citation.
  - AT-03: questions from `refuse_fixtures.json` → PDF section contains honest-uncertainty template, not a fabricated answer.
- **Log points**: `verify_{start,ok}`, `hallucination_suppressed` per drop.
- **Fallback**: if verifier Haiku 5xx → raise refuse threshold to 0.55 at retrieve layer and skip moat 2; log DEGRADED.
- **Time**: 40 min

---

### Task 3.4 — PDF renderer with persona-driven components

- **Owner**: E-render
- **Pre-gate**: Vpre-3.4 (BLUEPRINT §2.2.2, §2.2.4, AT-04)
- **Post-gate**: Vpost-3.4 (AT-04 cosine + visual-diff)
- **MCPs**: Context7 (`@react-pdf/renderer` API), Filesystem, Bash
- **Skills**: output-discipline
- **Depends**: 3.3
- **Inputs**: `PDFContent` + `PersonaVector` + `data/persona_configs.json`
- **Output**:
  - `lib/pdf/persona_configs.json` — 1 entry per 5-axis-tuple archetype + a neutral fallback. Each defines primary_color, accent, density, section_order_override (optional), font_sizes, include_salary_chart, include_emi, tone_header.
  - `lib/pdf/LeadPDF.tsx` — `@react-pdf/renderer` Document with sub-components (`TLDR`, `ROIMath`, `RAGDepth`, `CoursseraDiff`, `AlumniBridge`, `AppliedVsPapers`, `CohortCalibre`, `InstructorCredibility`, `HonestGuarantee`, `FinancingReality`, `TestPrep`, `PeerStories`, `NeutralOverview`). Each section renders only if present in `PDFContent`.
  - `app/api/cases/[id]/pdf/route.ts` — renders `PDFContent` + `PersonaVector` via `renderToStream` from `@react-pdf/renderer`, uploads to Supabase Storage, returns signed public URL.
  - Branded footer on every page: `[source: scaler.com · fetched {days}d ago]`.
- **AC**:
  - Rohan PDF: blue primary, `tldr → roi_math → rag_depth → coursera_diff → alumni_bridge`, has salary chart, comfortable density.
  - Karthik PDF: monochrome, `tldr → applied_vs_papers → cohort_calibre → instructor_credibility`, no chart, compact density.
  - Meera PDF: purple/amber, `tldr → honest_guarantee → financing_reality → test_prep → peer_stories`, EMI breakdown, generous density.
  - **AT-01 novel persona** (Priya PM fixture) → neutral_overview section used for axes where confidence<0.6, rendered with restrained palette + an explicit "we have limited signal on your [axis]" note. **Does not** reuse Rohan/Karthik/Meera templates.
  - **AT-04**: pairwise text-embedding cosine of the 3 demo PDFs < 0.85; Priya PDF < 0.85 against each of them.
  - PDF file size < 8 MB, 2-4 pages, valid PDF (verified by `pdfinfo`).
- **Log points**: `pdf_render_{start,ok}`, `pdf_size_bytes`.
- **Fallback**: Puppeteer+`@sparticuz/chromium-min` HTML→PDF (Phase B primary, today fallback); last-resort markdown-as-PDF via `md-to-pdf` library.
- **Time**: 70 min

---

### Task 4.1 — Twilio WhatsApp send (Business-first, Sandbox-fallback)

- **Owner**: E-whatsapp
- **Pre-gate**: Vpre-4.1 (BLUEPRINT §2.1, AT-05)
- **Post-gate**: Vpost-4.1 (actual send test to user's number)
- **MCPs**: Context7 (Twilio Node SDK), Filesystem, Bash
- **Skills**: output-discipline
- **Depends**: 3.4
- **Inputs**: Twilio creds, signed PDF URL, covering msg, recipient E.164
- **Output**: `lib/twilio.ts` + `app/api/cases/[id]/send/route.ts`. Startup check: probes Twilio API — if user's business number has `whatsapp` capability, use `TWILIO_WHATSAPP_FROM=whatsapp:+<their#>`; else fall back to Sandbox number and store Sandbox join phrase for onboarding UI display. Send uses `mediaUrl` param.
- **AC**: during Vpost-4.1, sending a test PDF to evaluator's own WhatsApp results in a received document message with file name `scaler-brief-<firstname>.pdf`; Twilio `statusCallback` logs `sent` then `delivered`.
- **Log points**: `twilio_{send_start,send_ok,status_*}`.
- **Fallback**: Business → Sandbox → wa.me link with Supabase public URL as final fallback (visibly warned in UI).
- **Time**: 40 min

---

### Task 4.2 — Approval gate UI (Approve / Edit / Skip, durable)

- **Owner**: E-gate
- **Pre-gate**: Vpre-4.2 (BLUEPRINT §2.6, AT-06)
- **Post-gate**: Vpost-4.2
- **MCPs**: Context7 (shadcn/ui, react-pdf-viewer), Filesystem, Bash, **Playwright** (to verify UI interaction)
- **Skills**: output-discipline
- **Depends**: 3.4, 4.1
- **Inputs**: —
- **Output**:
  - `app/cases/[id]/page.tsx` — BDA view: shows nudge (top), PDF preview (iframe of signed URL or `<PDFViewer>` embed), covering msg textarea, per-section edit buttons (Phase B: inline LLM-assist), 3 big action buttons.
  - `app/api/cases/[id]/decide/route.ts` (POST `{action: "approved"|"edited"|"skipped", covering_msg?, section_edits?[]}`) — persists decision; on `approved` triggers send; on `edited` re-runs 3.2→3.3→3.4 with edited seeds; on `skipped` marks state.
  - Durable: all state in Postgres; page refresh rehydrates; case_id in URL.
- **AC**: refreshing mid-review preserves draft edits; clicking Approve delivers PDF; clicking Skip marks `SKIPPED` and no send happens; every click writes a `bda_edits` row (DPO-grade capture).
- **Log points**: `decide_{received,ok}`, `bda_edit_captured`.
- **Fallback**: if edit re-generation fails, keep original draft but surface ERROR toast.
- **Time**: 55 min

---

### Task 4.3 — Twilio `statusCallback` + delivery_events

- **Owner**: E-whatsapp
- **Pre-gate**: Vpre-4.3
- **Post-gate**: Vpost-4.3
- **MCPs**: Filesystem, Context7
- **Skills**: output-discipline
- **Depends**: 4.1, 4.2
- **Inputs**: —
- **Output**: `app/api/webhooks/twilio/route.ts` — validates Twilio signature, parses form body, upserts into `delivery_events` table (`{case_id, message_sid, status, timestamp}`), updates `lead_cases.state` to `DELIVERED` / `READ` / `FAILED`.
- **AC**: actual send produces `queued → sent → delivered` rows; failed send (invalid number) produces `failed` with error code.
- **Log points**: `twilio_status_{received,validated,upserted}`.
- **Fallback**: if signature validation fails, log WARN but still upsert (dev); in prod, reject 403.
- **Time**: 20 min

---

### Task 4.4 — BDA nudge send path

- **Owner**: E-whatsapp
- **Pre-gate**: Vpre-4.4
- **Post-gate**: Vpost-4.4
- **MCPs**: Filesystem
- **Skills**: output-discipline
- **Depends**: 3.1, 4.1
- **Inputs**: nudge markdown, evaluator phone
- **Output**: `app/api/cases/[id]/send-nudge/route.ts` — **no approval gate** (per R04). Sends the plain-text nudge via Twilio to the onboarded phone. Renders as-is (markdown → plain text for WhatsApp's plain body).
- **AC**: calling endpoint sends a single text message with nudge content within ≤600 chars; no media.
- **Log points**: `nudge_send_{start,ok}`.
- **Fallback**: if Twilio 5xx, retry 3× exp-backoff; then store as unsent and surface in `/admin/logs`.
- **Time**: 15 min

---

### Task 5.1 — Vercel deploy + env propagation

- **Owner**: E-deploy
- **Pre-gate**: Vpre-5.1 (checks `.env.example` matches `§3.5`)
- **Post-gate**: Vpost-5.1 (hits `/api/health` on prod URL)
- **MCPs**: Bash, Filesystem
- **Skills**: output-discipline
- **Depends**: 4.2, 4.3, 4.4
- **Inputs**: Vercel token (you share)
- **Output**: deployed production URL; Twilio `statusCallback` URL updated to `{PROD_URL}/api/webhooks/twilio`; Vercel Function timeout set to Fluid (default) or Pro 60s.
- **AC**: `/api/health` returns `ok`; deployment logs show no missing env.
- **Log points**: `deploy_{pushed,built,live}` via `vercel --prod` output.
- **Fallback**: Railway if Vercel auth fails.
- **Time**: 20 min

---

### Task 5.2 — End-to-end smoke test (the big AT enforcement)

- **Owner**: E-smoke + reviewer-post
- **Pre-gate**: Vpre-5.2 (lists every AT to enforce)
- **Post-gate**: Vpost-5.2 (double-checks every AT with screenshots / evidence)
- **MCPs**: **Playwright** (automated browser flow), Bash, Filesystem
- **Skills**: output-discipline, second-order-thinking
- **Depends**: 5.1
- **Inputs**: —
- **Output**: `tests/e2e/smoke.spec.ts` Playwright spec running through:
  1. Onboard with evaluator phone
  2. Upload Rohan profile + transcript → approve → PDF lands
  3. Upload Karthik profile + transcript → approve → PDF lands (visibly different from 1)
  4. Upload Meera profile + transcript → approve → PDF lands (visibly different from 1 & 2)
  5. **Upload Priya PM profile + transcript** → approve → PDF lands (visibly different from 1-3) — **AT-01 live gate**
  6. Upload audio file (30s TTS-generated sample) → STT → extract → PDF lands
  7. Upload a 40-word gibberish "transcript" → extractor returns 0 questions → PDF still renders with `NeutralOverview` template
  8. Upload a refuse-fixture question → PDF includes honest-uncertainty section — **AT-03 live gate**
- **AC**: all 8 cases pass, all 4 PDFs pairwise cosine < 0.85, all 4 land on real WhatsApp.
- **Log points**: each scenario produces a `smoke_scenario_{N}_{ok|fail}` entry with screenshot path.
- **Fallback**: if Playwright fails locally, run curl-based API-level smoke as minimum coverage.
- **Time**: 45 min

---

### Task 5.3 — Hand-written README (hand-edited — R42 disqualifier)

- **Owner**: E-docs (me at main thread — NOT a subagent; brief explicitly flags LLM-generated README)
- **Pre-gate**: Vpre-5.3
- **Post-gate**: human-review by you before submit
- **MCPs**: Filesystem
- **Skills**: output-discipline
- **Depends**: 5.2
- **Inputs**: full system as shipped
- **Output**: `README.md` with exactly 3 sections:
  1. **What you built** — one paragraph, plain English
  2. **One failure** — 50 words, from the actual smoke test
  3. **Scale plan** — 100 words, BDA-approval throughput as named first bottleneck
- **AC**: reads human, not LLM; no bullet-vomit; passes your read-aloud test.
- **Log points**: —
- **Fallback**: —
- **Time**: 30 min

---

### Task 5.4 — Loom (≤6 min)

- **Owner**: you (I produce the shot-list + opening line)
- **Pre-gate**: Vpre-5.4
- **Post-gate**: you
- **MCPs**: —
- **Skills**: output-discipline
- **Depends**: 5.2, 5.3
- **Inputs**: prod URL, recording software
- **Output**: Loom URL
- **AC**: ≤6 min; shows onboarding, 3 personas side-by-side, novel persona, audio path once, approval gate visible, PDF landing on WhatsApp.
- **Log points**: —
- **Fallback**: —
- **Time**: 20 min

---

### Task 5.5 — Submission email

- **Owner**: me (draft) → you (send)
- **Pre-gate**: Vpre-5.5 (brief §"How to submit")
- **Post-gate**: you
- **MCPs**: Filesystem
- **Skills**: output-discipline
- **Depends**: 5.3, 5.4
- **Inputs**: README + Loom URL + repo + prod URL + your LinkedIn
- **Output**: `SUBMIT.md` with the exact email body per brief (name, LinkedIn, one-line motivation, **3 questions from BLUEPRINT §6.9**, prod URL, repo URL, Loom URL, README link).
- **AC**: under a screen of text; subject = `AI builder`.
- **Log points**: —
- **Time**: 15 min

---

## §9. Phase B backlog (explicitly deferred from today)

1. Langfuse self-host on Modal (trace+score+dataset)
2. LangGraph `interrupt()` + Postgres checkpointer (replaces hand-rolled state machine)
3. Inline-LLM-assist on approval edit UX (K3)
4. DPO-row capture auto-exported nightly for fine-tuning
5. Weekly corpus ingest cron + diff alerts
6. Adversarial red-team verifier (H3) as nightly batch
7. Freshness-aware retrieval demotion (C3 from §3.6)
8. 40-case golden eval set + nightly CI
9. Persona-drift monthly batch monitor
10. Qdrant migration if corpus exceeds ~10 k chunks
11. Modal warm-pool + `@sparticuz/chromium-min` Puppeteer path for layout-rich PDFs
12. Gupshup / MSG91 BSP abstraction for volume pricing

---

## §10. Total wall-clock estimate

| Phase | Serial mins | With parallel sub-agents | Critical-path |
|---|---|---|---|
| P0 (0.1 – 0.5) | 100 | 40 | 0.1 → 0.2 → 1.1 |
| P1 (1.1 – 1.3) | 80 | 60 | 1.1 → 1.2 → 1.3 |
| P2 (2.1 – 2.4) | 155 | 80 | 2.1 → 2.3 → 2.4 |
| P3 (3.1 – 3.4) | 185 | 120 | 3.2 → 3.3 → 3.4 |
| P4 (4.1 – 4.4) | 130 | 75 | 4.1 → 4.2 |
| P5 (5.1 – 5.5) | 130 | 80 | 5.1 → 5.2 → 5.3 |
| **Total** | **780 min ≈ 13 h** | **≈ 7.5 h** | — |

Serial: one agent, one task at a time. With sub-agent parallelism: ~7.5 h is a realistic ship-today number **given your availability to action 4 account signups and share keys when tasks request them**.

---

## §11. Runtime protocol (how I'll actually execute this)

1. I announce the task I'm starting.
2. I spawn `Vpre-N.M` (reviewer subagent) with the task brief + blueprint refs + this file § section — gets PASS / REVISE / BLOCK.
3. On PASS, I spawn the Executor (either a subagent or execute directly in main thread if the task is trivial and context-dependent).
4. On executor completion, I spawn `Vpost-N.M` (reviewer subagent, different instance) with the artefact + AC + inherited ATs.
5. On PASS, mark task complete in TodoWrite, announce to you, move on.
6. On FIX, pass patch-list to executor; loop up to 3×; if still failing, escalate to you.
7. When I need an API key you haven't shared yet, I pause and ask for it explicitly — I don't guess, don't commit placeholder values, don't skip the dependency.
8. At the end of each phase (P0 / P1 / …) I post a 3-line status: done / in-progress / blocked.

---

## §12. What I need from you right now to start

1. **Confirm** this plan (or flag any pushback on a task scope / stack choice).
2. Share these **three keys immediately** so I can scaffold and wire logging without stalling:
   - `ANTHROPIC_API_KEY`
   - `VOYAGE_API_KEY`
   - `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` (I won't send anything yet — just wires the client so Task 4.1 is ready)
3. **Start Vercel + Supabase + Deepgram signups in parallel** (the WhatsApp decision about your Business number I'll work out at Task 4.1). When you have the Supabase URL + keys and Deepgram key, drop them to me.
4. Tell me your **evaluator phone number** (where demo sends should go) — I'll store only in session, never commit.
5. One-line confirm: **"Go — start with Task 0.1"** and I begin immediately.

---

*End of plan. Single file. Ships today.*
