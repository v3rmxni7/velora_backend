-- 0013 suppression_reply_reason.sql — Phase 2 Hardening Slice 2.9 (audit finding H1).
-- A reply now suppresses the PERSON globally (they engaged → the machine stops), like bounce/unsub
-- already do. Add 'reply' as a distinct suppression reason so the "never contact again" guarantee
-- becomes per-person/cross-campaign — and so analytics can tell replied apart from unsubscribed.
alter table public.suppression_list drop constraint suppression_list_reason_check;
alter table public.suppression_list add constraint suppression_list_reason_check
  check (reason in ('unsubscribe', 'bounce', 'complaint', 'manual', 'reply'));
