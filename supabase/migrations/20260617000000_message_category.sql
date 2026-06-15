-- 0011 message_category.sql — Phase 2 Slice 2.6: inbound replies → inbox.
-- The reply classifier (cheap LLM) lands a coarse category on the INBOUND message so the
-- inbox can triage. Nullable: outbound messages have none; a junk/unclassified reply defaults
-- to 'other' at write time. No RLS change — messages already carry the org-scoped quartet (0009).
alter table public.messages add column category text;
