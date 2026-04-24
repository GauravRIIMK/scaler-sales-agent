# Scaler Sales Agent

AI-assisted pre-call briefs and post-call personalised PDFs for Scaler BDAs. Both pieces delivered on WhatsApp. Every lead-facing send goes through an Approve / Edit / Skip gate.

## What you built

An end-to-end pipeline that turns `(profile, call)` into two artefacts:

1. **Pre-call BDA nudge** — a ~600-word markdown + ≤1500-char WhatsApp rendering, structured as `Who:` / `Hooks:` / `Objections:` / `Open with:` / `Flag:`, with inferred claims tagged `(inferred)` and every Scaler fact tied back to a `scaler.com` URL.
2. **Post-call lead PDF** — a 3-page persona-tailored brief with a cover page (lead name, archetype chip, covering message, trust stats), numbered section pages, and a full-bleed CTA banner pointing to the Scaler Entrance Test. Every sentence carries either `chunk_ids` + `certainty="fact"` or an honest `"inferred"` / `"refused"` tag.

Key design calls:

- **No hard-coded persona class switch.** Five axes (`career_stage`, `financial_sensitivity`, `technical_depth`, `stakeholder_context`, `risk_posture`) are inferred per-lead and composed into a PDF style config at render time. Any tuple renders — the three evaluator personas are just three points in a 243-point space.
- **Three moats between the LLM and the lead.**
  1. *Structural* — drop any sentence with no `chunk_ids` and `certainty != inferred|refused`.
  2. *LLM verdict* — batch-judge each surviving fact-sentence with Haiku; `supported="no"` drops, `"partial"` downgrades to `inferred`.
  3. *Surface* — ₹-amounts, LPA figures, URLs, and banned words (`guarantee`, `promise`, `best`, `top`) must appear verbatim in a cited chunk or the sentence is rewritten as an honest-uncertainty line.
- **Two-pass question extraction.** Pass 1 (Haiku) surfaces implicit concerns like "the ROI doesn't feel right." Pass 2 (Sonnet) rewrites each into one retrievable question.
- **Hybrid retrieval with a refuse gate.** BM25 (`pg_trgm` tsvector) + dense cosine (`pgvector`, `voyage-3-large`, 1024d) fused via RRF (`k=60`), then reranked by `voyage-rerank-2.5`. If the top rerank score `< 0.35` → the gate returns `refused`, and downstream generators print `renderRefusal()` instead of hallucinating.
- **Persona-config compositional styling.** `lib/pdf/personaConfigs.ts` merges axis-specific overlays into a single `PDFStyleConfig`; `LeadPDF.tsx` builds the StyleSheet dynamically. Three sample personas are guaranteed to produce pairwise-distinct layouts (section order, callouts, density, colour).
- **Approval gate is first-class.** `/cases/[id]` renders the generated sections, the covering message as an editable textarea, a step banner (① Review → ② Approve → ③ Send), and Approve / Edit / Skip buttons. Every state-mutating route (`/decision`, `/pdf`, `/deliver`, `/nudge/send`) requires the `x-bda-approval-code` header — checked against the `BDA_APPROVAL_CODE` env var. The Approval Panel pre-fills the demo code from `localStorage`, persisting it across sessions. `bda_edits` stores a section-level diff history so DPO-style fine-tuning is an unlock, not a rewrite.
- **Single-screen evaluator intake.** `/cases/new` collects everything upfront with structured fields (lead name, role, company, experience, location, education, goals, concerns, budget) plus call source (transcript or audio) plus recipients (lead WhatsApp, BDA WhatsApp, BDA name, language). An Advanced JSON escape hatch is hidden in a `<details>` for power-users. A 10-step pipeline indicator + sticky submit summary make wait-time expectations explicit.

### Pipeline (routes)

```
POST /api/cases/new                   create row, store profile + transcript/audio
POST /api/cases/[id]/generate         STT → extract → persona → retrieve → pdfContent → verify
POST /api/cases/[id]/pdf              render PDF via @react-pdf/renderer + upload to Storage
POST /api/cases/[id]/nudge            generate BDA nudge + persist markdown
POST /api/cases/[id]/nudge/send       WhatsApp the nudge to the BDA
POST /api/cases/[id]/decision         record Approve / Edit / Skip
POST /api/cases/[id]/deliver          WhatsApp the PDF + covering message to the lead
POST /api/twilio/status               Twilio statusCallback webhook (signature-verified)
GET  /api/health                      env + integration readiness
```

### Stack

Next.js 14 (App Router, Node runtime) · Supabase (Postgres + pgvector + pg_trgm + Storage) · Voyage AI (`voyage-3-large` embed + `voyage-rerank-2.5`) · Anthropic Claude (Haiku 4.5 / Sonnet 4.6 / Opus 4.7) · Deepgram Nova-3 STT with diarisation · Twilio WhatsApp · `@react-pdf/renderer`.

## One failure

The refuse-test fixtures in `data/refuse_fixtures.json` hold 12 questions that are deliberately NOT answered on scaler.com (e.g. `"Does Scaler have a Singapore campus?"`, `"Can I transfer to MIT after the course?"`, `"Is there a 100% placement guarantee?"`). The verifier is the system's honesty floor — if retrieval returned a weak-but-not-rejected chunk and the LLM made the claim fit, the surface-regex moat would still catch `"100% placement guarantee"` because the banned word `guarantee` doesn't appear verbatim in any cited chunk. The failure mode I would actually expect to observe first is the *opposite*: a fixture like `"What's the refund policy if I drop out?"` where the corpus has enough refund-adjacent language that the refuse gate passes but the claim paraphrases rather than quotes. Moat 2 (Haiku `partial` verdict) is what's supposed to catch that — on repeated runs, we'd want to measure what fraction of flagged sentences are genuinely unsafe vs over-cautious. That number decides whether the refuse threshold `0.35` is too lax.

## Scale plan

At 20–30 cases/day the binding constraint is **Opus latency**, not cost: the PDF generator makes one Opus call per extracted question (typically 4–7), so a single case spends ~30–60s in wall-clock generation. Three unblocks, in order:

1. **Parallelise per-section generation.** The `for`-loop in `lib/pdfContent.ts:generatePDFContent` is trivially `Promise.all`-ifiable — each section is independent once its chunks are retrieved. Expected ~3–5× wall-clock reduction, no architectural change.
2. **Switch hot-path sections to Sonnet by default.** Opus is worth it for the first section of each PDF (sets the tone). Sonnet handles follow-on sections indistinguishably in our test set. Keep Opus as a fallback when verifier `ok_rate < 0.7`.
3. **Move the verifier off the critical path.** Moat 2 adds a Haiku batch-call per section. At 20 cases/day that's negligible cost, but it's latency. Queue it via Supabase realtime + re-render if it catches anything — the user sees the first pass faster, and the (rare) recall-back case is an acceptable trade at this volume.

Beyond 200 cases/day, the real bottleneck is **ingest freshness**. The corpus currently reflects one crawl date. A weekly recrawl with content-hash dedup keeps the signal fresh without re-embedding unchanged chunks.

---

## Local dev

```bash
cp .env.example .env.local      # fill secrets (see below)
npm install
npm run typecheck                # strict TS, zero errors
npm run build                    # production build
npm run dev                      # http://localhost:3000
npm run ingest                   # one-shot corpus ingest into Supabase
```

Required secrets (see `.env.example` for the full list):

- `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY` — always required
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` — for delivery
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` — DB + Storage
- `DEEPGRAM_API_KEY` — only required for the audio-input path
- `PUBLIC_APP_URL` — used to compute Twilio `statusCallback` target
- `BDA_APPROVAL_CODE` — shared secret that gates Approve / PDF render / Deliver. Pick any string; the demo deployment uses `SCALER-APPROVE-9421`.

Apply migrations in order: `0001_init.sql` → `0002_retrieve_rpc.sql` → `0003_bda_whatsapp.sql`. The 0002 RPC is the hybrid BM25+dense+RRF retrieval primitive; 0003 adds BDA-side columns (`bda_whatsapp`, `bda_name`, `language`, `bda_nudge_whatsapp_plaintext`) so the nudge send route can dispatch the LLM-crafted plaintext verbatim instead of regex-stripping markdown.

### Demo flow

1. **`/cases/new`** — fill the structured form. Three sections, top to bottom:
   1. **Lead** — name, role, company, years of experience, location, education, goals (textarea), concerns (textarea), budget range.
   2. **Call** — pick *Transcript* (paste text) or *Audio* (upload `.wav`/`.mp3`/`.m4a`). The audio path runs Deepgram Nova-3 with diarisation; transcript path skips STT.
   3. **Recipients** — lead's WhatsApp number, the BDA's WhatsApp number, the BDA's display name, and the spoken language (`en-IN` / `en-US` / `hi`).
   Click **Run agent** and the page redirects to `/cases/[id]`.
2. **`/cases/[id]`** — the step banner shows ① Review PDF → ② Approve → ③ Send to lead. The page renders questions, persona archetype, all sections (with chunk-ID footers), and the BDA nudge (markdown + WhatsApp plaintext preview).
3. **Approve** — paste the BDA approval code (pre-filled in the demo build from `localStorage`). Click *Approve & lock*. State moves `awaiting_approval → approved`. The PDF is now renderable.
4. **Send to lead on WhatsApp** — same code, single click. State moves `approved → delivered`. Twilio dispatches the covering message + signed PDF link to the lead's number.
5. **Send pre-call nudge to BDA** — separate button, also code-gated. Twilio sends the 1500-char Who/Hooks/Objections/Open with/Flag plaintext to the BDA's WhatsApp.
6. Check `/api/health` for integration readiness; `/cases` for history.

### One-shot smoke test

```bash
# Local
PORT=3002 npm run dev
BASE=http://localhost:3002 \
  SMOKE_LEAD_PHONE=whatsapp:+91XXXXXXXXXX \
  SMOKE_BDA_PHONE=whatsapp:+91XXXXXXXXXX \
  node scripts/smoke.mjs

# Production
BASE=https://your-app.vercel.app \
  BDA_APPROVAL_CODE=SCALER-APPROVE-9421 \
  SMOKE_LEAD_PHONE=whatsapp:+91XXXXXXXXXX \
  SMOKE_BDA_PHONE=whatsapp:+91XXXXXXXXXX \
  node scripts/smoke.mjs
```

The script runs **new → generate → pdf-without-code (expect 401) → decision approve → pdf-with-code → nudge** and prints a compact report at each stage.

### Twilio sandbox note

Trial accounts have no approved WhatsApp sender. `TWILIO_WHATSAPP_FROM` must be `whatsapp:+14155238886`, and every recipient must first text `join <sandbox-code>` to that number to opt in. For a real deployment, request a Business sender + template approval first.

See [BUILD_PLAN.md](./BUILD_PLAN.md) for the full task DAG and [BLUEPRINT.md](./BLUEPRINT.md) for the research/architecture rationale.
