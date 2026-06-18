-- 0023 calls.sql — Phase 4 Slice 4.9: the dialer queue + manual call log.
-- The agent does NOT call (SPEC §3.7). A row is a queued lead-to-dial (status queued/scheduled), a
-- skip, or a manually-logged HUMAN call (status='logged' + outcome). No softphone, no Twilio, no
-- auto-dial — "Call" is a tel: link to the rep's own phone. Org-scoped RLS QUARTET, all authenticated:
-- a rep owns their queue/log (the lists/list_members user-writable posture, NOT the service-role
-- signal_events posture). The agent generates briefs ON READ from real data; nothing here sends email.

create table public.calls (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_type text not null check (lead_type in ('person', 'company', 'local_business')),
  lead_id uuid not null,
  thread_id uuid references public.threads(id) on delete set null,   -- optional past-interactions anchor
  campaign_id uuid references public.campaigns(id) on delete set null, -- optional provenance
  phone text,                                                          -- snapshot of the dialed number; may be null
  status text not null default 'queued' check (status in ('queued', 'scheduled', 'skipped', 'logged')),
  outcome text check (outcome is null or outcome in
    ('connected', 'voicemail', 'no_answer', 'meeting_booked', 'bad_number', 'other')),
  notes text,
  scheduled_at timestamptz,                                            -- future → 'Upcoming'; null/past → 'Ready'
  logged_by uuid references public.users(id) on delete set null,
  called_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index calls_organization_id_idx on public.calls(organization_id);
create index calls_lead_idx on public.calls(lead_type, lead_id);
create index calls_status_idx on public.calls(status);
-- Idempotent add-to-queue: at most ONE open (queued/scheduled) call per lead per org. A logged/skipped
-- row never blocks a re-queue; a duplicate add returns the existing open row (route-level).
create unique index calls_open_lead_idx on public.calls(organization_id, lead_type, lead_id)
  where status in ('queued', 'scheduled');
create trigger calls_set_updated_at before update on public.calls
  for each row execute function public.set_updated_at();
alter table public.calls enable row level security;
create policy "calls read"   on public.calls for select to authenticated using (organization_id = public.auth_organization_id());
create policy "calls insert" on public.calls for insert to authenticated with check (organization_id = public.auth_organization_id());
create policy "calls update" on public.calls for update to authenticated using (organization_id = public.auth_organization_id()) with check (organization_id = public.auth_organization_id());
create policy "calls delete" on public.calls for delete to authenticated using (organization_id = public.auth_organization_id());

-- A person lead can carry a phone (mirrors email/title). Nullable; the brief is honest "No phone on
-- file" when absent, and the rep can type a number when adding to the dialer queue (write-back).
alter table public.people add column phone text;
