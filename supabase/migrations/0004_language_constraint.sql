-- Migration 0004 — constrain lead_cases.language to the BCP-47 codes the UI exposes.
--
-- The form (app/cases/new/NewCaseForm.tsx) only offers en-IN, en-US, hi.
-- Without this, free-text values (typos, junk) flow into Deepgram/LLM prompts
-- and cause silent quality drops. Drop existing rows with non-conforming values
-- by coercing them to en-IN first (conservative default).

update lead_cases
set language = 'en-IN'
where language is not null
  and language not in ('en-IN', 'en-US', 'hi');

alter table lead_cases
  drop constraint if exists lead_cases_language_check;

alter table lead_cases
  add constraint lead_cases_language_check
  check (language is null or language in ('en-IN', 'en-US', 'hi'));

comment on constraint lead_cases_language_check on lead_cases is
  'Restricts language to the codes the form exposes. Extend this list if the form adds more.';
