-- 0007 mailboxes_domains.sql — Phase 2 Slice 2.1: sender mailboxes + sending domains.
-- Mirrors prior migrations: org-scoped RLS quartet via public.auth_organization_id(),
-- set_updated_at() triggers. Read-only against Smartlead in 2.1 — no send path. Also adds
-- the missing write policies to senders (it shipped with only a select policy in 0001).

-- mailboxes — one sending inbox; linked to Smartlead by smartlead_email_account_id.
-- sender_id nullable (assigned later); sender↔mailbox via sender_id + is_primary (no circular FK).
create table public.mailboxes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  sender_id uuid references public.senders(id) on delete set null,
  smartlead_email_account_id text,
  email citext not null,
  provider text not null default 'unknown' check (provider in ('gmail', 'microsoft', 'smtp', 'unknown')),
  is_primary boolean not null default false,
  status text not null default 'pending'
    check (status in ('pending', 'connected', 'warming', 'warm', 'paused')),
  daily_cap int,
  warmup_state jsonb,
  reputation jsonb,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, email),
  unique (organization_id, smartlead_email_account_id)
);
create index mailboxes_organization_id_idx on public.mailboxes(organization_id);
create index mailboxes_sender_id_idx on public.mailboxes(sender_id);
create trigger mailboxes_set_updated_at before update on public.mailboxes
  for each row execute function public.set_updated_at();
alter table public.mailboxes enable row level security;
create policy "mb read"   on public.mailboxes for select to authenticated using (organization_id = public.auth_organization_id());
create policy "mb insert" on public.mailboxes for insert to authenticated with check (organization_id = public.auth_organization_id());
create policy "mb update" on public.mailboxes for update to authenticated using (organization_id = public.auth_organization_id()) with check (organization_id = public.auth_organization_id());
create policy "mb delete" on public.mailboxes for delete to authenticated using (organization_id = public.auth_organization_id());

-- domains — sending domains + their DNS auth status (populated manually / by a later DNS check).
create table public.domains (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  domain text not null,
  spf_status text not null default 'unknown' check (spf_status in ('unknown', 'pass', 'fail')),
  dkim_status text not null default 'unknown' check (dkim_status in ('unknown', 'pass', 'fail')),
  dmarc_status text not null default 'unknown' check (dmarc_status in ('unknown', 'pass', 'fail')),
  tracking_status text not null default 'unknown' check (tracking_status in ('unknown', 'pass', 'fail')),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, domain)
);
create index domains_organization_id_idx on public.domains(organization_id);
create trigger domains_set_updated_at before update on public.domains
  for each row execute function public.set_updated_at();
alter table public.domains enable row level security;
create policy "dom read"   on public.domains for select to authenticated using (organization_id = public.auth_organization_id());
create policy "dom insert" on public.domains for insert to authenticated with check (organization_id = public.auth_organization_id());
create policy "dom update" on public.domains for update to authenticated using (organization_id = public.auth_organization_id()) with check (organization_id = public.auth_organization_id());
create policy "dom delete" on public.domains for delete to authenticated using (organization_id = public.auth_organization_id());

-- senders shipped with only a select policy (0001). Add the write quartet so senders are manageable.
create policy "sn insert" on public.senders for insert to authenticated with check (organization_id = public.auth_organization_id());
create policy "sn update" on public.senders for update to authenticated using (organization_id = public.auth_organization_id()) with check (organization_id = public.auth_organization_id());
create policy "sn delete" on public.senders for delete to authenticated using (organization_id = public.auth_organization_id());
