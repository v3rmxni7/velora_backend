-- 0008 campaigns.sql — Phase 2 Slice 2.2: campaigns + steps + enrollments.
-- Mirrors prior migrations: org-scoped RLS quartet via public.auth_organization_id(),
-- set_updated_at() triggers. No send path — launch only enrolls a list (status 'pending').
-- Audience comes from lists/list_members (0003). tasks.campaign_id link is wired in 2.3.

-- campaigns — one outbound campaign. campaign_type enum carries all 5 (cold_outbound first;
-- others gated off at the route until later phases). list_id = the audience.
create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  sender_id uuid references public.senders(id) on delete set null,
  name text not null,
  campaign_type text not null default 'cold_outbound'
    check (campaign_type in ('cold_outbound', 'warm_outbound', 'cross_sell', 'website_visitor', 'intent_signals')),
  status text not null default 'draft'
    check (status in ('draft', 'active', 'paused', 'completed', 'archived')),
  list_id uuid references public.lists(id) on delete set null,
  smartlead_campaign_id text,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index campaigns_organization_id_idx on public.campaigns(organization_id);
create index campaigns_org_status_idx on public.campaigns(organization_id, status);
create trigger campaigns_set_updated_at before update on public.campaigns
  for each row execute function public.set_updated_at();
alter table public.campaigns enable row level security;
create policy "cmp read"   on public.campaigns for select to authenticated using (organization_id = public.auth_organization_id());
create policy "cmp insert" on public.campaigns for insert to authenticated with check (organization_id = public.auth_organization_id());
create policy "cmp update" on public.campaigns for update to authenticated using (organization_id = public.auth_organization_id()) with check (organization_id = public.auth_organization_id());
create policy "cmp delete" on public.campaigns for delete to authenticated using (organization_id = public.auth_organization_id());

-- campaign_steps — sequence steps (pilot = a single auto-created step 1). org_id denormalized for RLS.
create table public.campaign_steps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  step_number int not null,
  channel text not null default 'email' check (channel in ('email')),
  delay_days int not null default 0,
  subject_template text,
  body_mode text not null default 'ai_grounded' check (body_mode in ('ai_grounded', 'template')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, step_number)
);
create index campaign_steps_campaign_id_idx on public.campaign_steps(campaign_id);
create trigger campaign_steps_set_updated_at before update on public.campaign_steps
  for each row execute function public.set_updated_at();
alter table public.campaign_steps enable row level security;
create policy "cst read"   on public.campaign_steps for select to authenticated using (organization_id = public.auth_organization_id());
create policy "cst insert" on public.campaign_steps for insert to authenticated with check (organization_id = public.auth_organization_id());
create policy "cst update" on public.campaign_steps for update to authenticated using (organization_id = public.auth_organization_id()) with check (organization_id = public.auth_organization_id());
create policy "cst delete" on public.campaign_steps for delete to authenticated using (organization_id = public.auth_organization_id());

-- enrollments — per-lead state machine within a campaign. unique(campaign,lead) = the lead
-- enrolls once (first layer of the double-send guard). org_id denormalized for RLS.
create table public.enrollments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  lead_type text not null check (lead_type in ('person', 'company', 'local_business')),
  lead_id uuid not null,
  status text not null default 'pending'
    check (status in ('pending', 'queued', 'awaiting_approval', 'sent', 'replied', 'bounced', 'unsubscribed', 'completed', 'failed')),
  current_step int not null default 1,
  verified_email citext,
  scheduled_at timestamptz,
  smartlead_lead_id text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, lead_type, lead_id)
);
create index enrollments_campaign_id_idx on public.enrollments(campaign_id);
create index enrollments_org_status_idx on public.enrollments(organization_id, status);
create index enrollments_lead_idx on public.enrollments(lead_type, lead_id);
create trigger enrollments_set_updated_at before update on public.enrollments
  for each row execute function public.set_updated_at();
alter table public.enrollments enable row level security;
create policy "enr read"   on public.enrollments for select to authenticated using (organization_id = public.auth_organization_id());
create policy "enr insert" on public.enrollments for insert to authenticated with check (organization_id = public.auth_organization_id());
create policy "enr update" on public.enrollments for update to authenticated using (organization_id = public.auth_organization_id()) with check (organization_id = public.auth_organization_id());
create policy "enr delete" on public.enrollments for delete to authenticated using (organization_id = public.auth_organization_id());
