-- 0016 reply_approval_tasks.sql — Phase 3 Slice 3.3b: an AI-drafted reply awaiting human review.
-- A new 'reply_approval' task type (the cold draft is 'outbound_approval'); approving it is a no-op
-- in 3.3b (the approve route only executeSend()s 'outbound_approval') — auto-SEND of replies is 3.4.
-- thread_id links the draft to its conversation (for the inbox + the future reply send).
alter table public.tasks drop constraint tasks_type_check;
alter table public.tasks add constraint tasks_type_check
  check (type in ('outbound_approval', 'manual', 'platform', 'reply_approval'));
alter table public.tasks add column thread_id uuid references public.threads(id) on delete set null;
create index tasks_thread_id_idx on public.tasks(thread_id);
