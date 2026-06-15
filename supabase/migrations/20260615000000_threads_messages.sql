-- 0009 threads_messages.sql — Phase 2 Slice 2.3: the dry-run send pipeline's persistence.
-- Mirrors prior migrations: org-scoped RLS quartet via public.auth_organization_id(),
-- set_updated_at() triggers. DRY-RUN only — messages.status 'dry_run' means "would send";
-- nothing is pushed to a provider until Slice 2.5 flips the org sending flags.

-- threads — one conversation per lead per campaign (outbound now; inbound replies in 2.6).
create table public.threads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  sender_id uuid references public.senders(id) on delete set null,
  campaign_id uuid references public.campaigns(id) on delete set null,
  lead_type text not null check (lead_type in ('person', 'company', 'local_business')),
  lead_id uuid not null,
  subject text,
  status text not null default 'active'
    check (status in ('active', 'needs_action', 'handled', 'auto_handled')),
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, campaign_id, lead_type, lead_id)
);
create index threads_organization_id_idx on public.threads(organization_id);
create index threads_campaign_id_idx on public.threads(campaign_id);
create trigger threads_set_updated_at before update on public.threads
  for each row execute function public.set_updated_at();
alter table public.threads enable row level security;
create policy "thr read"   on public.threads for select to authenticated using (organization_id = public.auth_organization_id());
create policy "thr insert" on public.threads for insert to authenticated with check (organization_id = public.auth_organization_id());
create policy "thr update" on public.threads for update to authenticated using (organization_id = public.auth_organization_id()) with check (organization_id = public.auth_organization_id());
create policy "thr delete" on public.threads for delete to authenticated using (organization_id = public.auth_organization_id());

-- messages — sent + (later) received. status 'dry_run' = the gated, reviewed, would-send draft.
-- dedupe_key gives message-level idempotency: a re-run never writes a second outbound message.
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  thread_id uuid not null references public.threads(id) on delete cascade,
  enrollment_id uuid references public.enrollments(id) on delete set null,
  direction text not null check (direction in ('outbound', 'inbound')),
  channel text not null default 'email' check (channel in ('email')),
  smartlead_message_id text,
  subject text,
  body text,
  status text not null default 'dry_run'
    check (status in ('dry_run', 'queued', 'sent', 'delivered', 'opened', 'clicked', 'replied', 'bounced', 'complained', 'failed')),
  grounding jsonb,
  gates jsonb,
  dedupe_key text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, dedupe_key)
);
create index messages_organization_id_idx on public.messages(organization_id);
create index messages_thread_id_idx on public.messages(thread_id);
create index messages_enrollment_id_idx on public.messages(enrollment_id);
create trigger messages_set_updated_at before update on public.messages
  for each row execute function public.set_updated_at();
alter table public.messages enable row level security;
create policy "msg read"   on public.messages for select to authenticated using (organization_id = public.auth_organization_id());
create policy "msg insert" on public.messages for insert to authenticated with check (organization_id = public.auth_organization_id());
create policy "msg update" on public.messages for update to authenticated using (organization_id = public.auth_organization_id()) with check (organization_id = public.auth_organization_id());
create policy "msg delete" on public.messages for delete to authenticated using (organization_id = public.auth_organization_id());

-- enrollment links: the approval task it produced, and the thread its (dry-run) send created.
alter table public.enrollments
  add column task_id uuid references public.tasks(id) on delete set null,
  add column thread_id uuid references public.threads(id) on delete set null;
