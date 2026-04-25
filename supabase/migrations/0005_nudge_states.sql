-- Migration 0005 — extend case_state enum with two pre-call states.
--
-- Why: the assignment splits the workflow into TWO stages.
--   Stage A — pre-call (T-1h auto): nudge to BDA built from profile/CRM only,
--             no transcript exists yet.
--   Stage B — post-call (BDA-triggered): transcript/audio → questions → PDF.
--
-- Today the schema only knows the single linear post-call flow ('received' →
-- ... → 'delivered'). We add two new states ahead of 'received' so the
-- two-stage pipeline can persist properly:
--
--   nudge_scheduled  Lead row created with scheduled_call_at, awaiting the
--                    cron tick that fires NUDGE_LEAD_MINUTES before the call.
--   nudge_sent       Cron has generated + sent the BDA nudge over WhatsApp.
--                    Row will sit here until the BDA completes the call and
--                    POSTs the transcript/audio to /api/cases/[id]/post-call,
--                    which transitions to 'received' and the existing pipeline
--                    takes over.
--
-- IMPORTANT: ALTER TYPE … ADD VALUE cannot run in the same transaction as a
-- statement that references the new value (e.g. a partial index predicate).
-- That's why this migration ONLY mutates the enum — the columns + partial
-- index land in 0006_pre_call_columns.sql.

alter type case_state add value if not exists 'nudge_scheduled' before 'received';
alter type case_state add value if not exists 'nudge_sent' before 'received';
