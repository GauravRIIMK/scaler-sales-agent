# Scaler Sales Agent

AI-assisted pre-call briefs and post-call personalised PDFs for Scaler BDAs. Both pieces delivered on WhatsApp. Every lead-facing send goes through an Approve / Edit / Skip gate.

## Live demo

**→ https://scaler-sales-agent-theta.vercel.app**

No setup, no install — open the URL, enter your WhatsApp number once, and click any of the three pre-loaded persona cards (Rohan / Karthik / Meera) to walk the full two-stage flow. A custom-persona path is one click below the cards. Both Twilio sandbox numbers (`+1 415 523 8886`) need a `join <code>` opt-in from the recipient phone before WhatsApp will accept the messages.

The deployment runs the same code that's in this repo. `/api/health` reports the live commit SHA. The BDA approval code for the demo deployment is `SCALER-APPROVE-9421` (pre-filled in the UI from `localStorage`).

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
- **Two-stage flow modelling the assignment.** `/leads/new` (Stage A) collects only what the BDA actually has *before* the call — profile + scheduled call time + recipients — and parks the row in `nudge_scheduled`. A cron tick (`/api/cron/fire-nudges`, every 5 min) auto-fires the profile-only WhatsApp nudge to the BDA `NUDGE_LEAD_MINUTES` (default 60) ahead of the scheduled call, with a manual override (`/api/leads/[id]/fire-nudge-now`) for the demo. After the call the BDA returns to `/cases/[id]` and uses the **Post-call ingest** panel to upload transcript or audio, which triggers `/post-call → /generate` and lands at `awaiting_approval`. The legacy single-shot `/cases/new` is still wired for power-users and the smoke script.

### Pipeline (routes)

**Stage A — pre-call (assignment-correct two-stage path):**

```
POST /api/leads                       create lead row in 'nudge_scheduled' + schedule call
GET  /api/cron/fire-nudges            cron tick: fire BDA nudges whose call is within LEAD min
POST /api/leads/[id]/fire-nudge-now   manual override (demo button + seed scripts)
```

**Stage B — post-call:**

```
POST /api/cases/[id]/audio-upload-url issues a Supabase signed PUT URL so the browser
                                      can upload audio direct (bypasses Vercel 4.5MB
                                      function payload cap). Returns { signed_upload_url, path }.
POST /api/cases/[id]/post-call        accepts transcript / audio_path / audio_url / multipart audio
                                      → 'received'
POST /api/cases/[id]/generate         STT → extract → persona → retrieve (PBR-augmented)
                                      → pdfContent → verify
POST /api/cases/[id]/pdf              render PDF via @react-pdf/renderer + upload to Storage
POST /api/cases/[id]/decision         record Approve / Edit / Skip (gates /pdf and /deliver)
POST /api/cases/[id]/deliver          WhatsApp the PDF + covering message to the lead;
                                      polls Twilio for actual delivery and throws on terminal failure
```

**Legacy single-shot (still wired; used by `scripts/smoke.mjs` and `scripts/seed-personas.mjs`):**

```
POST /api/cases/new                   create row with profile + transcript/audio bundled
POST /api/cases/[id]/nudge            generate BDA nudge + persist markdown
POST /api/cases/[id]/nudge/send       WhatsApp the nudge to the BDA
```

**Shared:**

```
POST /api/twilio/status               Twilio statusCallback webhook (signature-verified)
GET  /api/health                      env + integration readiness
```

### Stack

Next.js 14 (App Router, Node runtime) · Supabase (Postgres + pgvector + pg_trgm + Storage) · Voyage AI (`voyage-3-large` embed + `voyage-rerank-2.5`) · Anthropic Claude (Haiku 4.5 / Sonnet 4.6 / Opus 4.7) · Deepgram Nova-3 STT with diarisation · Twilio WhatsApp · `@react-pdf/renderer`.

## One failure

Refuse gate passes but the LLM paraphrases rather than quotes — e.g. `"What's the refund policy if I drop out?"` where refund-adjacent corpus language avoids rejection. Moat 2 (Haiku `partial` verdict) catches it. What fraction of flagged sentences are genuinely unsafe? That decides whether threshold `0.35` is too lax.

## Scale plan

At 20–30 cases/day the binding constraint is Opus latency: one call per extracted question (4–7 typical), so ~30–60s per case.

Three unblocks:

1. **Parallelise per-section generation.** `lib/pdfContent.ts:generatePDFContent` is a serial `for`-loop; sections are independent once chunks are retrieved. `Promise.all` cuts wall-clock ~3–5×.
2. **Switch hot-path sections to Sonnet.** Opus earns its keep on section one; Sonnet handles follow-on sections equivalently. Revert if verifier `ok_rate < 0.7`.
3. **Move verifier off critical path.** Queue Haiku batch-calls via Supabase realtime; re-render on catch. First pass arrives faster.

Beyond 200 cases/day: weekly recrawl with content-hash dedup keeps corpus fresh without re-embedding unchanged chunks.

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

Apply migrations in order: `0001_init.sql` → `0002_retrieve_rpc.sql` → `0003_bda_whatsapp.sql` → `0004_language_constraint.sql` → `0005_nudge_states.sql` → `0006_pre_call_columns.sql`. The 0002 RPC is the hybrid BM25+dense+RRF retrieval primitive; 0003 adds BDA-side columns (`bda_whatsapp`, `bda_name`, `language`, `bda_nudge_whatsapp_plaintext`) so the nudge-send route can dispatch the LLM-crafted plaintext verbatim instead of regex-stripping markdown; 0005–0006 introduce the two-stage state machine (`nudge_scheduled` / `nudge_sent`) plus `scheduled_call_at`, `nudge_sent_at`, `nudge_fired_by`, `audio_blob_url`, and the `persona_vector` JSONB column populated by the pre-call nudge generator. Run `node scripts/apply_migrations.mjs` to apply all in order against the env in `.env.local`.

### Demo flow (two-stage — what the Loom records)

The four-step page banner on `/cases/[id]` mirrors this exactly: ① Pre-call nudge → BDA → ② Review PDF → ③ Approve → ④ Send to lead.

**Stage A — pre-call (BDA receives a profile-only WhatsApp nudge):**

1. **`/leads/new`** — fill the Stage-A form:
   1. **Lead profile** — paste a free-form paragraph (LinkedIn bio, intake notes, sales-ops note) and click **Extract profile**. Haiku parses it into structured fields you can edit. An *Advanced JSON* escape hatch is hidden in `<details>` for power-users.
   2. **Schedule the call** — `datetime-local` picker (defaults to T+75 min so the cron fires in ~15 min) plus language (`en-IN` / `en-US` / `hi`).
   3. **Recipients** — BDA's WhatsApp (required — that's where the nudge goes), BDA name, and the lead's WhatsApp (optional at this stage; can be added later for PDF delivery).
   Click **Create lead + schedule nudge**. The row lands in `state='nudge_scheduled'`.
2. **Pre-call nudge fires** — two paths:
   - **Cron**: `GET /api/cron/fire-nudges` runs every 5 min (Vercel Cron / Supabase scheduled function). It picks up rows whose `scheduled_call_at` is within `NUDGE_LEAD_MINUTES` (default 60) and fires.
   - **Manual** (Loom-friendly): click **Fire nudge now (skip cron)** on the success panel, or use the same button on `/cases/[id]`. Hits `POST /api/leads/[id]/fire-nudge-now`. State moves `nudge_scheduled → nudge_sent`. The BDA receives a 1500-char Who/Hooks/Objections/Open with/Flag plaintext via Twilio WhatsApp.

**Stage B — post-call (BDA uploads the call, lead receives a personalised PDF):**

3. **`/cases/[id]`** — once the call is done, the BDA opens the case page and sees the **Post-call ingest** panel. Pick *Transcript* (paste text) or *Audio* (upload `.wav`/`.mp3`/`.m4a`). The audio path runs Deepgram Nova-3 with diarisation; transcript path skips STT. Optionally fill in the lead's WhatsApp here if it wasn't set in Stage A. Click **Upload + run agent**. The page hits `POST /api/cases/[id]/post-call` then `POST /api/cases/[id]/generate`. State traces `received → transcribing → questions_extracted → persona_inferred → retrieved → generated → verified → awaiting_approval`.
4. **Review** — the page renders the inferred persona archetype + 5-axis chips, the extracted questions, the generated sections (with chunk-ID footers per fact-sentence), and the editable covering message.
5. **Approve** — paste the BDA approval code (pre-filled from `localStorage` in the demo build), click *Approve & lock*. State moves `awaiting_approval → approved`. The PDF is now renderable. *(Edit / Skip are also available — Edit captures a section-level diff into `bda_edits`; Skip terminates the case.)*
6. **Send to lead on WhatsApp** — same code, single click. State moves `approved → delivered`. Twilio dispatches the covering message + the rendered PDF as a media attachment to the lead's WhatsApp number (Twilio MM SID, not a link).

Check `/api/health` for env + integration readiness; `/cases` for the history index.

### Smoke / seed scripts

| Script | What it covers |
| --- | --- |
| `scripts/smoke.mjs` | Legacy single-shot path — `new → generate → pdf-without-code (expect 401) → decision approve → pdf-with-code → nudge`. Useful for sanity-checking the post-call pipeline in isolation. |
| `scripts/seed-personas.mjs` | Three canonical personas (Rohan / Karthik / Meera per R16) via the legacy single-shot path. Asserts pairwise-distinct archetypes (R37). |
| `scripts/seed-two-stage.mjs` | Same three personas via the **assignment-correct two-stage flow**: `POST /api/leads → fire-nudge-now → post-call → generate → decision approve → deliver`. This is what the Loom mirrors. |
| `scripts/test-audio-ingest.mjs` | R15 audio path — generates a TTS WAV, uploads it through `/post-call`, asserts STT transcribes it and the rest of the pipeline runs. |

Two-stage example (recommended):

```bash
PORT=3002 npm run dev
BASE=http://localhost:3002 \
  BDA_APPROVAL_CODE=SCALER-APPROVE-9421 \
  SEED_BDA_PHONE=whatsapp:+91XXXXXXXXXX \
  SEED_LEAD_PHONE=whatsapp:+91XXXXXXXXXX \
  node scripts/seed-two-stage.mjs
```

Production swap: `BASE=https://your-app.vercel.app` and the same env vars.

### Twilio sandbox note

Trial accounts have no approved WhatsApp sender. `TWILIO_WHATSAPP_FROM` must be `whatsapp:+14155238886`, and every recipient must first text `join <sandbox-code>` to that number to opt in. For a real deployment, request a Business sender + template approval first.

See [BUILD_PLAN.md](./BUILD_PLAN.md) for the full task DAG and [BLUEPRINT.md](./BLUEPRINT.md) for the research/architecture rationale.
