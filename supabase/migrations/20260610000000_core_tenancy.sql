-- Phase 0 foundation — multi-tenant core. RLS enabled on EVERY table.
-- Tenancy: single-org-per-user (users.organization_id NOT NULL). Multi-org would
-- need a memberships join table + reworked RLS (deferred).
--
-- ORDER NOTE: auth_organization_id() is LANGUAGE sql and references public.users,
-- and Postgres validates SQL function bodies at CREATE time (check_function_bodies).
-- So the helper MUST be created AFTER public.users exists, and any policy that calls
-- it comes after the helper. Hence the order below: organizations + users tables
-- first, then the helper, then helper-dependent policies and the remaining tables.

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
create extension if not exists pgcrypto;  -- gen_random_uuid()
create extension if not exists citext;    -- case-insensitive email

-- ---------------------------------------------------------------------------
-- Touch trigger for MUTABLE tables only (never on the append-only credit_ledger).
-- plpgsql bodies are not validated against tables at CREATE time, so this is safe here.
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- organizations  (tenant root) — read policy added after the helper exists
-- ---------------------------------------------------------------------------
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function public.set_updated_at();

alter table public.organizations enable row level security;

-- ---------------------------------------------------------------------------
-- users  (links auth.users → organization, with a role)
-- ---------------------------------------------------------------------------
create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email text not null,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now()
  -- append-light: no updated_at
);

create index users_organization_id_idx on public.users(organization_id);

alter table public.users enable row level security;

-- Direct self-check. Must NOT call auth_organization_id() (it reads users) — prevents recursion.
create policy "users read self"
  on public.users for select
  to authenticated
  using (id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Org-scoping helper — defined AFTER public.users exists.
-- SECURITY DEFINER bypasses users-RLS so it cannot recurse; STABLE for
-- per-statement caching; search_path pinned to '' (so all refs are schema-qualified).
-- ---------------------------------------------------------------------------
create or replace function public.auth_organization_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select organization_id from public.users where id = auth.uid()
$$;

-- organizations read policy (now that the helper exists)
create policy "org members read their organization"
  on public.organizations for select
  to authenticated
  using (id = public.auth_organization_id());

-- ---------------------------------------------------------------------------
-- integrations  (CRM / calendar OAuth + sync state)
-- ---------------------------------------------------------------------------
create table public.integrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  kind text check (kind in ('crm', 'calendar')),
  provider text,
  oauth jsonb,
  sync_state jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index integrations_organization_id_idx on public.integrations(organization_id);

create trigger integrations_set_updated_at
  before update on public.integrations
  for each row execute function public.set_updated_at();

alter table public.integrations enable row level security;

create policy "org members read integrations"
  on public.integrations for select
  to authenticated
  using (organization_id = public.auth_organization_id());

-- ---------------------------------------------------------------------------
-- senders  (hub the sending layer + campaigns depend on)
-- ---------------------------------------------------------------------------
create table public.senders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid references public.users(id) on delete set null,
  display_name text,
  status text not null default 'setup' check (status in ('setup', 'active', 'paused')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
  -- Phase 2 adds: primary/secondary mailbox, linkedin, calendar, dialer FK columns.
);

create index senders_organization_id_idx on public.senders(organization_id);

create trigger senders_set_updated_at
  before update on public.senders
  for each row execute function public.set_updated_at();

alter table public.senders enable row level security;

create policy "org members read senders"
  on public.senders for select
  to authenticated
  using (organization_id = public.auth_organization_id());

-- ---------------------------------------------------------------------------
-- credit_ledger  (metering — APPEND-ONLY; balance = sum(delta) per org)
-- ---------------------------------------------------------------------------
create table public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  delta numeric(20, 6) not null,  -- signed: +grant / -debit, fractional credits
  reason text not null
    check (reason in ('signup_grant', 'enrichment', 'send', 'reply', 'adjustment')),
  reference jsonb,                -- {type, id} of the charged entity
  idempotency_key text not null unique,  -- permanent double-charge guard
  created_at timestamptz not null default now()
  -- APPEND-ONLY: no updated_at, no touch trigger.
);

create index credit_ledger_organization_id_idx on public.credit_ledger(organization_id);

alter table public.credit_ledger enable row level security;

-- Read-only to clients; only service_role (bypasses RLS) writes ledger rows.
create policy "org members read credit ledger"
  on public.credit_ledger for select
  to authenticated
  using (organization_id = public.auth_organization_id());

-- ---------------------------------------------------------------------------
-- suppression_list  (compliance + deliverability — global + per-tenant)
-- ---------------------------------------------------------------------------
create table public.suppression_list (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,  -- NULL = global
  email citext not null,
  reason text not null
    check (reason in ('unsubscribe', 'bounce', 'complaint', 'manual')),
  source text,
  created_at timestamptz not null default now(),
  -- NULLS NOT DISTINCT so global rows (organization_id IS NULL) dedupe by email (PG15+).
  constraint suppression_list_org_email_key unique nulls not distinct (organization_id, email)
);

create index suppression_list_email_idx on public.suppression_list(email);

alter table public.suppression_list enable row level security;

create policy "org members read suppression (own + global)"
  on public.suppression_list for select
  to authenticated
  using (
    organization_id = public.auth_organization_id()
    or organization_id is null
  );
