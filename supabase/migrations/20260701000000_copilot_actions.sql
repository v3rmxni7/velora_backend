-- 0022 copilot_actions.sql — Slice 4.11: the propose→confirm ledger for the agentic copilot.
-- The LLM only ever PROPOSES a write action (inserts status='proposed'); a deterministic, role-gated
-- confirm route EXECUTES the real work and flips the status. The ONLY mutation path is the
-- confirm/cancel routes (there is no generic PATCH), so a client can never forge status='confirmed'
-- without the server actually performing the action. This table doubles as the agentic-action audit log.

create table public.copilot_actions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  thread_id uuid not null references public.copilot_threads(id) on delete cascade,
  message_id uuid references public.copilot_messages(id) on delete set null,
  user_id uuid references public.users(id) on delete set null,
  kind text not null
    check (kind in ('launch_campaign', 'pause_campaign', 'pause_autonomy', 'subscribe_signal', 'create_list')),
  action_class text not null check (action_class in ('safe', 'spending', 'destructive')),
  title text not null,
  args jsonb not null default '{}'::jsonb,
  status text not null default 'proposed' check (status in ('proposed', 'confirmed', 'cancelled', 'failed')),
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index copilot_actions_organization_id_idx on public.copilot_actions(organization_id);
create index copilot_actions_thread_id_idx on public.copilot_actions(thread_id);

create trigger copilot_actions_set_updated_at
  before update on public.copilot_actions
  for each row execute function public.set_updated_at();

alter table public.copilot_actions enable row level security;

-- RLS quartet, org-scoped, all-authenticated (the user owns their copilot actions; the confirm/cancel
-- routes are the only writers of a status transition).
create policy "ca select" on public.copilot_actions for select to authenticated
  using (organization_id = public.auth_organization_id());
create policy "ca insert" on public.copilot_actions for insert to authenticated
  with check (organization_id = public.auth_organization_id());
create policy "ca update" on public.copilot_actions for update to authenticated
  using (organization_id = public.auth_organization_id())
  with check (organization_id = public.auth_organization_id());
create policy "ca delete" on public.copilot_actions for delete to authenticated
  using (organization_id = public.auth_organization_id());
