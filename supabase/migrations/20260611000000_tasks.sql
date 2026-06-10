-- 0004 tasks.sql — Slice 3: outbound-approval drafts + Tasks queue.
-- Mirrors prior migrations: org-scoped RLS quartet, set_updated_at trigger.
-- Drafts are created by the draft-generate job (service-role); humans approve/reject.

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  type text not null default 'outbound_approval'
    check (type in ('outbound_approval', 'manual', 'platform')),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'dismissed')),
  lead_type text check (lead_type in ('person', 'company', 'local_business')),
  lead_id uuid,                       -- polymorphic (app-enforced); null for manual/platform
  campaign_id uuid,                   -- null in Phase 1 (no campaigns yet)
  subject text,
  body text,
  draft_mode text check (draft_mode in ('personalized', 'template')),
  confidence numeric(4, 3),           -- 0..1 overall (task-level) confidence
  grounding jsonb,                    -- { mode, overallConfidence, facts[], usedFactIds, verification }
  reason text,                        -- rejection/dismiss reason, or template reason
  dedupe_key text,                    -- set for outbound drafts; null otherwise
  approved_by uuid references public.users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- NULLs distinct (default): manual/platform (null key) unconstrained; drafts deduped.
  unique (organization_id, dedupe_key)
);
create index tasks_organization_id_idx on public.tasks(organization_id);
create index tasks_org_status_type_idx on public.tasks(organization_id, status, type);
create trigger tasks_set_updated_at before update on public.tasks
  for each row execute function public.set_updated_at();
alter table public.tasks enable row level security;
create policy "tk read"   on public.tasks for select to authenticated using (organization_id = public.auth_organization_id());
create policy "tk insert" on public.tasks for insert to authenticated with check (organization_id = public.auth_organization_id());
create policy "tk update" on public.tasks for update to authenticated using (organization_id = public.auth_organization_id()) with check (organization_id = public.auth_organization_id());
create policy "tk delete" on public.tasks for delete to authenticated using (organization_id = public.auth_organization_id());
