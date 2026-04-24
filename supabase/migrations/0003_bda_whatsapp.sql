-- Migration 0003 — capture the BDA's own WhatsApp number on the case.
--
-- Today `evaluator_phone` holds the LEAD's phone (the PDF recipient). The
-- pre-call nudge goes to the BDA, which needs a second number. We store it
-- on the case row so `/api/cases/:id/nudge/send` can default to it and the
-- evaluator doesn't have to re-type it per-case.
--
-- Also persist the LLM-crafted WhatsApp plaintext for the nudge so the
-- send route can use the original Sonnet output rather than regex-stripping
-- the markdown after the fact.

alter table lead_cases
  add column if not exists bda_whatsapp text,
  add column if not exists bda_name text,
  add column if not exists language text,
  add column if not exists bda_nudge_whatsapp_plaintext text;

comment on column lead_cases.bda_whatsapp is
  'E.164 WhatsApp number of the BDA assigned to this case. Used as the default recipient for the pre-call nudge.';
comment on column lead_cases.bda_name is
  'Display name of the BDA assigned to this case. Optional — for nudge greeting + dashboard.';
comment on column lead_cases.language is
  'BCP-47 language hint for STT + content generation. e.g. "en-IN", "en-US", "hi". Default en-IN.';
comment on column lead_cases.bda_nudge_whatsapp_plaintext is
  'The LLM-crafted short WhatsApp rendering of the BDA nudge, ≤1500 chars. Persisted so /nudge/send can use it verbatim.';
