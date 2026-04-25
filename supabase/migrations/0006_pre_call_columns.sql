-- Migration 0006 — pre-call schedule columns + cron index.
--
-- Splits from 0005 so the partial index predicate `state = 'nudge_scheduled'`
-- references an enum value committed in a previous transaction.
--
-- Adds:
--   scheduled_call_at  When the BDA is set to dial the lead. The pre-call
--                      nudge auto-fires NUDGE_LEAD_MINUTES (default 60)
--                      before this timestamp.
--   nudge_sent_at      When the nudge actually went out on WhatsApp. NULL
--                      until fired. Lets us debug "fired but never delivered".
--   nudge_fired_by     'cron' | 'manual' | 'seed' — provenance of the fire.
--                      'manual' is set by the demo button so the Loom doesn't
--                      have to wait for the cron tick.
--
-- Index: partial on scheduled_call_at WHERE state = 'nudge_scheduled' so the
-- cron's "find due rows" query is a small index scan even at 100k+ rows.

alter table lead_cases
  add column if not exists scheduled_call_at timestamptz,
  add column if not exists nudge_sent_at     timestamptz,
  add column if not exists nudge_fired_by    text;

comment on column lead_cases.scheduled_call_at is
  'When the BDA is scheduled to call the lead. Pre-call nudge auto-fires NUDGE_LEAD_MINUTES (default 60) before this time.';
comment on column lead_cases.nudge_sent_at is
  'When the pre-call nudge was actually sent to the BDA WhatsApp. NULL until fired.';
comment on column lead_cases.nudge_fired_by is
  'How the nudge was fired: cron (auto), manual (demo button), seed (script). NULL until fired.';

create index if not exists lead_cases_nudge_due_idx
  on lead_cases (scheduled_call_at)
  where state = 'nudge_scheduled';

-- Optional sanity constraint: nudge_fired_by must be one of the known values.
do $$ begin
  alter table lead_cases
    add constraint lead_cases_nudge_fired_by_check
    check (nudge_fired_by is null or nudge_fired_by in ('cron', 'manual', 'seed'));
exception when duplicate_object then null; end $$;
