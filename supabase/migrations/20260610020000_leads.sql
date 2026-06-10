-- 0003 leads.sql — Slice 2: leads data model + lists.
-- Mirrors 0001/0002: org-scoped RLS via public.auth_organization_id(), set_updated_at()
-- triggers, full-CRUD policy quartet for user-editable tables. citext (0001) reused for email.
-- Order: companies before people (people.company_id -> companies).

-- companies — saved company records (org-scoped).
create table public.companies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null default 'seed',
  external_id text,
  name text not null,
  domain text,
  industry text,
  size_band text check (size_band in ('1-10','11-50','51-200','201-500','501-1000','1001-5000','5000+')),
  employee_count int,
  location text,
  country text,
  linkedin_url text,
  source text not null default 'find_leads'
    check (source in ('manual','find_leads','signals','website_visitors','csv_import')),
  enriched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider, external_id)
);
create index companies_organization_id_idx on public.companies(organization_id);
create trigger companies_set_updated_at before update on public.companies
  for each row execute function public.set_updated_at();
alter table public.companies enable row level security;
create policy "co read"   on public.companies for select to authenticated using (organization_id = public.auth_organization_id());
create policy "co insert" on public.companies for insert to authenticated with check (organization_id = public.auth_organization_id());
create policy "co update" on public.companies for update to authenticated using (organization_id = public.auth_organization_id()) with check (organization_id = public.auth_organization_id());
create policy "co delete" on public.companies for delete to authenticated using (organization_id = public.auth_organization_id());

-- people — saved person records (org-scoped).
create table public.people (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null default 'seed',
  external_id text,
  first_name text,
  last_name text,
  full_name text,
  email citext,
  title text,
  seniority text check (seniority in ('c_level','vp','director','manager','senior','mid','entry','unknown')),
  department text check (department in ('engineering','sales','marketing','product','finance','operations','hr','legal','support','other')),
  company_id uuid references public.companies(id) on delete set null,
  company_name text,
  location text,
  country text,
  linkedin_url text,
  source text not null default 'find_leads'
    check (source in ('manual','find_leads','signals','website_visitors','csv_import')),
  enriched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider, external_id)
);
create index people_organization_id_idx on public.people(organization_id);
create index people_company_id_idx on public.people(company_id);
create trigger people_set_updated_at before update on public.people
  for each row execute function public.set_updated_at();
alter table public.people enable row level security;
create policy "pp read"   on public.people for select to authenticated using (organization_id = public.auth_organization_id());
create policy "pp insert" on public.people for insert to authenticated with check (organization_id = public.auth_organization_id());
create policy "pp update" on public.people for update to authenticated using (organization_id = public.auth_organization_id()) with check (organization_id = public.auth_organization_id());
create policy "pp delete" on public.people for delete to authenticated using (organization_id = public.auth_organization_id());

-- local_businesses — saved local-business records (org-scoped).
create table public.local_businesses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null default 'seed',
  external_id text,
  name text not null,
  category text,
  phone text,
  address text,
  city text,
  country text,
  website text,
  google_maps_url text,
  rating numeric(2,1),
  source text not null default 'find_leads'
    check (source in ('manual','find_leads','signals','website_visitors','csv_import')),
  enriched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider, external_id)
);
create index local_businesses_organization_id_idx on public.local_businesses(organization_id);
create trigger local_businesses_set_updated_at before update on public.local_businesses
  for each row execute function public.set_updated_at();
alter table public.local_businesses enable row level security;
create policy "lb read"   on public.local_businesses for select to authenticated using (organization_id = public.auth_organization_id());
create policy "lb insert" on public.local_businesses for insert to authenticated with check (organization_id = public.auth_organization_id());
create policy "lb update" on public.local_businesses for update to authenticated using (organization_id = public.auth_organization_id()) with check (organization_id = public.auth_organization_id());
create policy "lb delete" on public.local_businesses for delete to authenticated using (organization_id = public.auth_organization_id());

-- lists — saved/segmented lead lists (org-scoped).
create table public.lists (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  entity_type text not null check (entity_type in ('person','company','local_business')),
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index lists_organization_id_idx on public.lists(organization_id);
create trigger lists_set_updated_at before update on public.lists
  for each row execute function public.set_updated_at();
alter table public.lists enable row level security;
create policy "ls read"   on public.lists for select to authenticated using (organization_id = public.auth_organization_id());
create policy "ls insert" on public.lists for insert to authenticated with check (organization_id = public.auth_organization_id());
create policy "ls update" on public.lists for update to authenticated using (organization_id = public.auth_organization_id()) with check (organization_id = public.auth_organization_id());
create policy "ls delete" on public.lists for delete to authenticated using (organization_id = public.auth_organization_id());

-- list_members — polymorphic membership (entity_type tells which table; app-enforced).
-- organization_id denormalized for RLS + filtering.
create table public.list_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  list_id uuid not null references public.lists(id) on delete cascade,
  entity_type text not null check (entity_type in ('person','company','local_business')),
  entity_id uuid not null,
  added_at timestamptz not null default now(),
  unique (list_id, entity_type, entity_id)
);
create index list_members_organization_id_idx on public.list_members(organization_id);
create index list_members_list_id_idx on public.list_members(list_id);
alter table public.list_members enable row level security;
create policy "lm read"   on public.list_members for select to authenticated using (organization_id = public.auth_organization_id());
create policy "lm insert" on public.list_members for insert to authenticated with check (organization_id = public.auth_organization_id());
create policy "lm update" on public.list_members for update to authenticated using (organization_id = public.auth_organization_id()) with check (organization_id = public.auth_organization_id());
create policy "lm delete" on public.list_members for delete to authenticated using (organization_id = public.auth_organization_id());

-- enrichment_cache — INTERNAL provider cache (provider + key + TTL). Global (not org-scoped)
-- to avoid re-paying across orgs. RLS ENABLED with NO policies => authenticated denied;
-- only the service-role (deferred enrichment job) reads/writes. Unused until Apollo is wired.
create table public.enrichment_cache (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  cache_key text not null,
  payload jsonb not null,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz,
  unique (provider, cache_key)
);
create index enrichment_cache_expires_at_idx on public.enrichment_cache(expires_at);
alter table public.enrichment_cache enable row level security;
-- intentionally no policies (deny-all to authenticated; service-role bypasses RLS).
