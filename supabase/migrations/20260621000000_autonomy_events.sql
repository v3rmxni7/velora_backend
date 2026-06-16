-- 0015 autonomy_events.sql — Phase 3 Slice 3.1: append-only audit of every autonomous decision.
-- An unwatched system must be auditable. Written by service-role (worker/inbound, bypassing RLS);
-- org members may READ their own (frontend audit, 3.6). Immutable: no update/delete policy.
create table public.autonomy_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null check (kind in ('cold_send','reply')),
  enrollment_id uuid references public.enrollments(id) on delete set null,
  task_id uuid references public.tasks(id) on delete set null,
  decision text not null check (decision in ('auto_send','escalate','suppress','engage','snooze')),
  reason text not null,
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  created_at timestamptz not null default now()
);
create index autonomy_events_organization_id_idx on public.autonomy_events(organization_id);
create index autonomy_events_org_created_idx on public.autonomy_events(organization_id, created_at desc);
alter table public.autonomy_events enable row level security;
create policy "ae read"   on public.autonomy_events for select to authenticated using (organization_id = public.auth_organization_id());
create policy "ae insert" on public.autonomy_events for insert to authenticated with check (organization_id = public.auth_organization_id());
