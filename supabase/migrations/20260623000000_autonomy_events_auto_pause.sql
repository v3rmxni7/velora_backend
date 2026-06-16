-- 0017 autonomy_events_auto_pause.sql — Phase 3 Slice 3.5: the self-protection monitor records an
-- 'auto_pause' audit when it halts an org's autonomy on a deliverability breach. Extends the kind +
-- decision CHECKs (mirrors the 0013/0016 precedent); no new columns (confidence holds the bounce rate).
alter table public.autonomy_events drop constraint autonomy_events_kind_check;
alter table public.autonomy_events add constraint autonomy_events_kind_check
  check (kind in ('cold_send', 'reply', 'auto_pause'));
alter table public.autonomy_events drop constraint autonomy_events_decision_check;
alter table public.autonomy_events add constraint autonomy_events_decision_check
  check (decision in ('auto_send', 'escalate', 'suppress', 'engage', 'snooze', 'auto_pause'));
