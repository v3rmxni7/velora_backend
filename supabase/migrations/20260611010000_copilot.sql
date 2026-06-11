-- 0005 copilot.sql — Slice 4: basic chat copilot (threads + messages).
-- Mirrors prior migrations: org-scoped RLS quartet via public.auth_organization_id(),
-- set_updated_at() on mutable tables. Threads are per-user (user_id); messages append-only.
-- All copilot routes + tools run under the user-scoped (JWT) client — RLS scopes every read.

-- copilot_threads — one chat thread, owned by a user within an org.
create table public.copilot_threads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index copilot_threads_organization_id_idx on public.copilot_threads(organization_id);
create index copilot_threads_user_id_idx on public.copilot_threads(user_id);
create trigger copilot_threads_set_updated_at before update on public.copilot_threads
  for each row execute function public.set_updated_at();
alter table public.copilot_threads enable row level security;
create policy "ct read"   on public.copilot_threads for select to authenticated using (organization_id = public.auth_organization_id());
create policy "ct insert" on public.copilot_threads for insert to authenticated with check (organization_id = public.auth_organization_id());
create policy "ct update" on public.copilot_threads for update to authenticated using (organization_id = public.auth_organization_id()) with check (organization_id = public.auth_organization_id());
create policy "ct delete" on public.copilot_threads for delete to authenticated using (organization_id = public.auth_organization_id());

-- copilot_messages — append-only turns. organization_id denormalized for RLS.
-- tool_calls: { name, args, result } for tool-using assistant turns; null otherwise.
create table public.copilot_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  thread_id uuid not null references public.copilot_threads(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  tool_calls jsonb,
  created_at timestamptz not null default now()
);
create index copilot_messages_organization_id_idx on public.copilot_messages(organization_id);
create index copilot_messages_thread_id_idx on public.copilot_messages(thread_id);
alter table public.copilot_messages enable row level security;
-- messages are immutable (no update policy by design); read/insert/delete only.
create policy "cm read"   on public.copilot_messages for select to authenticated using (organization_id = public.auth_organization_id());
create policy "cm insert" on public.copilot_messages for insert to authenticated with check (organization_id = public.auth_organization_id());
create policy "cm delete" on public.copilot_messages for delete to authenticated using (organization_id = public.auth_organization_id());
