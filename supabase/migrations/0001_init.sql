-- Scaler Sales Agent — initial schema
-- Task 0.2 per BUILD_PLAN.md. Translates BLUEPRINT §6.3 Pydantic schemas to Postgres.
-- Applies clean to a new Supabase project. Idempotent where possible.

-- ─────────────────────────────────────────────────────────────
-- Extensions
-- ─────────────────────────────────────────────────────────────
create extension if not exists "uuid-ossp";
create extension if not exists vector;
create extension if not exists pg_trgm;

-- ─────────────────────────────────────────────────────────────
-- Enums
-- ─────────────────────────────────────────────────────────────
do $$ begin
  create type case_state as enum (
    'received',
    'transcribing',
    'questions_extracted',
    'persona_inferred',
    'retrieved',
    'generated',
    'verified',
    'awaiting_approval',
    'approved',
    'edited',
    'skipped',
    'delivered',
    'failed'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type career_stage as enum ('early','mid','senior','unknown');
exception when duplicate_object then null; end $$;

do $$ begin
  create type fin_sensitivity as enum ('high','medium','low','unknown');
exception when duplicate_object then null; end $$;

do $$ begin
  create type tech_depth as enum ('deep','moderate','novice','unknown');
exception when duplicate_object then null; end $$;

do $$ begin
  create type stakeholder_ctx as enum ('solo','family-joint','team','unknown');
exception when duplicate_object then null; end $$;

do $$ begin
  create type risk_posture as enum ('risk-averse','balanced','risk-tolerant','unknown');
exception when duplicate_object then null; end $$;

do $$ begin
  create type concern_type as enum (
    'cost','outcome','curriculum','timeline','credibility',
    'placement','prereq','format','refund','logistics','other'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type evidence_type as enum ('factual','anecdotal','comparative','policy','unknown');
exception when duplicate_object then null; end $$;

do $$ begin
  create type certainty_kind as enum ('fact','inferred','refused');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bda_action as enum ('approved','edited','skipped');
exception when duplicate_object then null; end $$;

do $$ begin
  create type log_level as enum ('DEBUG','INFO','WARN','ERROR','FATAL');
exception when duplicate_object then null; end $$;

-- ─────────────────────────────────────────────────────────────
-- Table: lead_cases
-- One row per incoming lead. Holds end-to-end state + artifacts.
-- ─────────────────────────────────────────────────────────────
create table if not exists lead_cases (
  id                  uuid primary key default uuid_generate_v4(),
  evaluator_phone     text,
  lead_profile        jsonb not null,
  transcript_text     text,
  audio_blob_url      text,
  extracted_questions jsonb not null default '[]'::jsonb,
  persona_vector      jsonb,
  retrieved_chunks    jsonb not null default '{}'::jsonb,
  pdf_content         jsonb,
  covering_msg        text,
  pdf_url             text,
  bda_nudge_markdown  text,
  state               case_state not null default 'received',
  bda_decision        jsonb,
  delivery_sid        text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  received_at         timestamptz,
  transcribed_at      timestamptz,
  extracted_at        timestamptz,
  retrieved_at        timestamptz,
  generated_at        timestamptz,
  verified_at         timestamptz,
  delivered_at        timestamptz
);

create index if not exists lead_cases_state_idx on lead_cases (state, created_at desc);
create index if not exists lead_cases_evaluator_idx on lead_cases (evaluator_phone) where evaluator_phone is not null;

-- ─────────────────────────────────────────────────────────────
-- Table: grounding_chunks
-- Scaler.com corpus chunks with dense embedding (voyage-3-large, 1024d)
-- + tsvector for BM25. Hybrid retrieve RPC lives in 0002.
-- ─────────────────────────────────────────────────────────────
create table if not exists grounding_chunks (
  id             uuid primary key default uuid_generate_v4(),
  url            text not null,
  section_path   text[] not null default '{}',
  text           text not null,
  span_chars     int4range,
  content_hash   text not null,
  fetched_at     timestamptz not null,
  embedding      vector(1024),
  tsv            tsvector generated always as (to_tsvector('english', coalesce(text,''))) stored,
  created_at     timestamptz not null default now(),
  unique (url, content_hash)
);

create index if not exists grounding_chunks_tsv_gin on grounding_chunks using gin (tsv);
create index if not exists grounding_chunks_trgm on grounding_chunks using gin (text gin_trgm_ops);
-- ivfflat ANN index; list count is a rough sqrt(rows) — tune after ingest.
create index if not exists grounding_chunks_embedding_ivfflat
  on grounding_chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);
create index if not exists grounding_chunks_url_idx on grounding_chunks (url);

-- ─────────────────────────────────────────────────────────────
-- Table: bda_edits
-- Captures approval / edit / skip decisions. DPO-grade: section-level diffs.
-- ─────────────────────────────────────────────────────────────
create table if not exists bda_edits (
  id                  uuid primary key default uuid_generate_v4(),
  case_id             uuid not null references lead_cases(id) on delete cascade,
  action              bda_action not null,
  covering_msg_before text,
  covering_msg_after  text,
  section_edits       jsonb not null default '[]'::jsonb,
  bda_identifier      text,
  created_at          timestamptz not null default now()
);

create index if not exists bda_edits_case_idx on bda_edits (case_id, created_at desc);
create index if not exists bda_edits_action_idx on bda_edits (action, created_at desc);

-- ─────────────────────────────────────────────────────────────
-- Table: agent_logs
-- Matches lib/log.ts LogRow contract. Write-heavy; queried ad-hoc.
-- ─────────────────────────────────────────────────────────────
create table if not exists agent_logs (
  id             bigserial primary key,
  case_id        uuid references lead_cases(id) on delete set null,
  task_id        text,
  component      text,
  level          log_level not null default 'INFO',
  event          text not null,
  provider       text,
  model          text,
  prompt_version text,
  tokens_in      int,
  tokens_out     int,
  latency_ms     int,
  attempt        int default 1,
  fallback_of    text,
  error_code     text,
  error_message  text,
  payload        jsonb,
  created_at     timestamptz not null default now()
);

create index if not exists agent_logs_case_idx on agent_logs (case_id, created_at desc);
create index if not exists agent_logs_event_idx on agent_logs (event, created_at desc);
create index if not exists agent_logs_level_idx on agent_logs (level, created_at desc) where level in ('ERROR','FATAL','WARN');

-- ─────────────────────────────────────────────────────────────
-- Table: prompt_templates
-- Versioned prompt storage so traces remain reproducible.
-- ─────────────────────────────────────────────────────────────
create table if not exists prompt_templates (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null,
  version     text not null,
  model       text,
  system      text,
  user_tpl    text not null,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  unique (name, version)
);

-- ─────────────────────────────────────────────────────────────
-- Table: delivery_events
-- Twilio statusCallback landings + any outbound WhatsApp delivery log.
-- ─────────────────────────────────────────────────────────────
create table if not exists delivery_events (
  id            bigserial primary key,
  case_id       uuid references lead_cases(id) on delete set null,
  channel       text not null default 'whatsapp',
  direction     text not null check (direction in ('outbound','inbound')),
  to_addr       text,
  from_addr     text,
  twilio_sid    text,
  status        text,
  error_code    text,
  error_message text,
  payload       jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists delivery_events_case_idx on delivery_events (case_id, created_at desc);
create index if not exists delivery_events_sid_idx on delivery_events (twilio_sid);
create index if not exists delivery_events_status_idx on delivery_events (status, created_at desc);

-- ─────────────────────────────────────────────────────────────
-- updated_at trigger for lead_cases
-- ─────────────────────────────────────────────────────────────
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists lead_cases_set_updated_at on lead_cases;
create trigger lead_cases_set_updated_at
  before update on lead_cases
  for each row execute function set_updated_at();

-- ─────────────────────────────────────────────────────────────
-- Row Level Security
-- service_role bypasses RLS by default in Supabase. We lock anon out.
-- ─────────────────────────────────────────────────────────────
alter table lead_cases        enable row level security;
alter table grounding_chunks  enable row level security;
alter table bda_edits         enable row level security;
alter table agent_logs        enable row level security;
alter table prompt_templates  enable row level security;
alter table delivery_events   enable row level security;

-- No anon policies are created ⇒ anon role sees nothing.
-- service_role bypasses RLS, so server-side writes keep working.
