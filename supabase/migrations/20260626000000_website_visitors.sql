-- 0019 website_visitors.sql — Phase 4 Slice 4.6: website-visitor de-anonymization (SPEC §3.10).
-- Structural twin of 4.5 signals: a USER-WRITABLE config table (website_tracked_domains, the org's
-- sites + a PUBLIC site_key the pixel embeds) + a SERVICE-ROLE landing zone (website_visits, raw
-- anonymous pixel hits, READ-only to users) + a SERVICE-ROLE resolved layer
-- (website_visitor_identifications, written ONLY by a real de-anon resolver). The resolver (reverse-IP
-- company / identity-graph person) is 🔌 EXTERNAL and NOT connected, so identifications stay empty;
-- the raw anonymous visit COUNT is real once the pixel is installed. NO raw IP is ever persisted.

-- website_tracked_domains — the org's marketing sites. site_key is PUBLIC (ships in page source);
-- it is an org SELECTOR for the unauthenticated pixel beacon, never a secret (see pixel.ts threat
-- model). User-writable → full RLS quartet.
create table public.website_tracked_domains (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  domain text not null,
  site_key text not null unique,
  campaign_id uuid references public.campaigns(id) on delete set null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, domain)
);
create index website_tracked_domains_organization_id_idx on public.website_tracked_domains(organization_id);
create index website_tracked_domains_campaign_id_idx on public.website_tracked_domains(campaign_id);
create trigger website_tracked_domains_set_updated_at before update on public.website_tracked_domains
  for each row execute function public.set_updated_at();
alter table public.website_tracked_domains enable row level security;
create policy "wtd read"   on public.website_tracked_domains for select to authenticated using (organization_id = public.auth_organization_id());
create policy "wtd insert" on public.website_tracked_domains for insert to authenticated with check (organization_id = public.auth_organization_id());
create policy "wtd update" on public.website_tracked_domains for update to authenticated using (organization_id = public.auth_organization_id()) with check (organization_id = public.auth_organization_id());
create policy "wtd delete" on public.website_tracked_domains for delete to authenticated using (organization_id = public.auth_organization_id());

-- website_visits — raw anonymous pixel hits. SERVICE-ROLE WRITE (the public pixel beacon resolves the
-- org from the site_key, never the payload); users READ-only. NO ip column by design (GDPR/CCPA
-- minimization). page_url/referrer are persisted with their query string + fragment STRIPPED (raw
-- query strings carry emails/tokens). event_id is a client-minted per-beacon nonce → (tracked_domain_id,
-- event_id) unique collapses replays/retries. origin marks test-vs-real, like signal_events.origin.
create table public.website_visits (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  tracked_domain_id uuid not null references public.website_tracked_domains(id) on delete cascade,
  anon_visitor_id text not null,
  event_id text not null,
  page_url text,
  referrer text,
  status text not null default 'new' check (status in ('new', 'resolving', 'identified', 'unresolved')),
  origin text not null default 'beacon' check (origin in ('beacon', 'test_inject')),
  resolved_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  unique (tracked_domain_id, event_id)
);
create index website_visits_org_status_idx on public.website_visits(organization_id, status);
create index website_visits_org_created_idx on public.website_visits(organization_id, created_at desc);
create index website_visits_domain_anon_idx on public.website_visits(tracked_domain_id, anon_visitor_id);
alter table public.website_visits enable row level security;
create policy "wv read" on public.website_visits for select to authenticated using (organization_id = public.auth_organization_id());

-- website_visitor_identifications — a resolved visit → person/company. Written ONLY by the 🔌 resolver
-- (service-role); users READ-only. unique(visit_id, kind) keeps it idempotent (≤1 person + ≤1 company
-- per visit). provider records the vendor for traceability (a ledger row is never from a fake).
create table public.website_visitor_identifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  visit_id uuid not null references public.website_visits(id) on delete cascade,
  tracked_domain_id uuid not null references public.website_tracked_domains(id) on delete cascade,
  kind text not null check (kind in ('person', 'company')),
  person_id uuid references public.people(id) on delete set null,
  company_id uuid references public.companies(id) on delete set null,
  provider text not null,
  confidence numeric(4, 3),
  created_at timestamptz not null default now(),
  unique (visit_id, kind)
);
create index website_visitor_identifications_organization_id_idx on public.website_visitor_identifications(organization_id);
create index website_visitor_identifications_visit_id_idx on public.website_visitor_identifications(visit_id);
alter table public.website_visitor_identifications enable row level security;
create policy "wvi read" on public.website_visitor_identifications for select to authenticated using (organization_id = public.auth_organization_id());

-- credit_ledger — meter each de-anon identification. The reason CHECK shipped in 0001; widen it to
-- add 'website_visitor_identification'. This is DORMANT in 4.6 (no resolver connected → no debit ever
-- fires in prod); it is the honest seam the resolver debits against when a vendor is connected.
alter table public.credit_ledger drop constraint credit_ledger_reason_check;
alter table public.credit_ledger add constraint credit_ledger_reason_check
  check (reason in ('signup_grant', 'enrichment', 'send', 'reply', 'adjustment', 'website_visitor_identification'));
