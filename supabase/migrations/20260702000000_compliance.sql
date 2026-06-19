-- 0023 compliance.sql — Slice 4.12: an immutable audit log + org-level data-retention settings.
-- (Real DNS SPF/DKIM/DMARC verification needs no schema — it updates the existing domains.*_status
-- columns from 20260613000000.)

-- ---------------------------------------------------------------------------
-- audit_logs — append-only, immutable security/compliance trail. Service-role WRITE only, org-scoped
-- READ to members (the signal_events / credit_ledger posture: no insert/update/delete policy → a
-- client can never write or alter a row, only the backend service-role appends). No updated_at.
-- ---------------------------------------------------------------------------
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null check (kind in (
    'team_role_changed', 'team_member_removed', 'sender_status_changed',
    'suppression_added', 'copilot_action_confirmed', 'domain_verified',
    'retention_reported', 'retention_purged'
  )),
  user_id uuid references public.users(id) on delete set null,
  args jsonb not null default '{}'::jsonb,
  reason text,
  source text check (source in ('user', 'system', 'webhook', 'cron')),
  created_at timestamptz not null default now()
  -- APPEND-ONLY: no updated_at, no touch trigger.
);

create index audit_logs_organization_id_idx on public.audit_logs(organization_id);
create index audit_logs_org_created_idx on public.audit_logs(organization_id, created_at desc);

alter table public.audit_logs enable row level security;

-- Read-only to clients (org-scoped); only the service-role (bypasses RLS) appends rows.
create policy "al read" on public.audit_logs for select to authenticated
  using (organization_id = public.auth_organization_id());

-- ---------------------------------------------------------------------------
-- Data-retention settings (org-level). Service-role / seed-set, like the sending + autonomy flags —
-- organizations has NO authenticated UPDATE policy, so flipping retention_dry_run off (enabling real
-- deletion) is a deliberate privileged act, never a normal user route. SAFE BY DEFAULT: dry-run ON →
-- the purge cron reports + audits would-purge counts but deletes nothing until the flip.
-- ---------------------------------------------------------------------------
alter table public.organizations
  add column retention_days_website_visits int not null default 90,
  add column retention_days_signal_events int not null default 90,
  add column retention_dry_run boolean not null default true;
