-- 0018 signals.sql — Phase 4 Slice 4.5: the intent-signal catalog + subscriptions + events.
-- signal_definitions is a SHARED read-only catalog (every org sees the same SPEC §3.9 rows; only
-- service-role/migration writes — same posture as credit_ledger). signal_subscriptions + signal_events
-- are org-scoped. A subscription links a LIVE signal to an intent_signals campaign; events (real feed
-- 🔌 or a clearly-labeled test inject) drive enrollment via the signal-monitor cron — DRY-RUN-safe.
-- Create signal_definitions (+ seed) FIRST (the others FK to it).

create table public.signal_definitions (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  category text not null check (category in ('funding', 'hiring', 'other')),
  name text not null,
  description text,
  status text not null default 'coming_soon' check (status in ('live', 'coming_soon')),
  created_at timestamptz not null default now()
);
alter table public.signal_definitions enable row level security;
-- Shared catalog: every authenticated user reads the same rows; no insert/update/delete policy →
-- authenticated cannot write (only the migration / service-role seeds it).
create policy "sd read" on public.signal_definitions for select to authenticated using (true);

-- The SPEC §3.9 catalog: 12 rows = 4 LIVE (1 funding + 3 hiring) + 8 coming-soon. Idempotent on key.
insert into public.signal_definitions (key, category, name, description, status) values
  ('funding_announcement', 'funding', 'Funding announcement', 'A company announces a new funding round.', 'live'),
  ('named_investor_backing', 'funding', 'Named investor backing', 'A company is backed by an investor you track.', 'coming_soon'),
  ('top_customers_investors', 'funding', 'Top customer''s investors', 'Companies backed by the same investors as your best customers.', 'coming_soon'),
  ('new_leadership_hire', 'hiring', 'New leadership hire', 'A company hires a new C-level, VP, or director.', 'live'),
  ('first_hire_in_department', 'hiring', 'First hire in department', 'A company makes its first hire in a department.', 'live'),
  ('first_hire_in_role', 'hiring', 'First hire in role', 'A company creates a new specialized position.', 'live'),
  ('hiring_for_role', 'hiring', 'Hiring for role', 'A company is actively hiring for specific roles.', 'coming_soon'),
  ('first_hire_in_country', 'hiring', 'First hire in country', 'A company makes its first hire in a new geography.', 'coming_soon'),
  ('multiple_open_jobs', 'hiring', 'Multiple open jobs', 'High hiring volume in a single department.', 'coming_soon'),
  ('tech_stack_in_jds', 'other', 'Tech stack in job descriptions', 'A company''s job posts name a tech stack you target.', 'coming_soon'),
  ('topic_intent', 'other', 'Topic intent', 'A company shows research intent on a topic.', 'coming_soon'),
  ('webhook', 'other', 'Webhook', 'Trigger outreach from any external system.', 'coming_soon')
on conflict (key) do nothing;

-- signal_subscriptions — org-scoped; links a live signal to the org's intent_signals campaign.
create table public.signal_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  signal_definition_id uuid not null references public.signal_definitions(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, signal_definition_id)
);
create index signal_subscriptions_organization_id_idx on public.signal_subscriptions(organization_id);
create index signal_subscriptions_campaign_id_idx on public.signal_subscriptions(campaign_id);
create trigger signal_subscriptions_set_updated_at before update on public.signal_subscriptions
  for each row execute function public.set_updated_at();
alter table public.signal_subscriptions enable row level security;
create policy "ss read"   on public.signal_subscriptions for select to authenticated using (organization_id = public.auth_organization_id());
create policy "ss insert" on public.signal_subscriptions for insert to authenticated with check (organization_id = public.auth_organization_id());
create policy "ss update" on public.signal_subscriptions for update to authenticated using (organization_id = public.auth_organization_id()) with check (organization_id = public.auth_organization_id());
create policy "ss delete" on public.signal_subscriptions for delete to authenticated using (organization_id = public.auth_organization_id());

-- signal_events — org-scoped landing zone, READ-ONLY to users (writes are service-role: the monitor
-- / the future real-feed webhook / the test inject). `origin` persists test-vs-real so a reviewer can
-- prove no real intent data was fabricated. Immutable to users (no insert/update/delete policy).
create table public.signal_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  signal_definition_id uuid not null references public.signal_definitions(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'processing', 'processed', 'failed')),
  origin text not null default 'feed' check (origin in ('feed', 'test_inject')),
  error text,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);
create index signal_events_org_status_idx on public.signal_events(organization_id, status);
create index signal_events_org_created_idx on public.signal_events(organization_id, created_at desc);
alter table public.signal_events enable row level security;
create policy "se read" on public.signal_events for select to authenticated using (organization_id = public.auth_organization_id());
