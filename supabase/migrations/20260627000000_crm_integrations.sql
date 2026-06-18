-- 0021 crm_integrations.sql — Phase 4 Slice 4.7: CRM connect + sync (warm_outbound + cross_sell).
-- Structural twin of 4.5/4.6: a CONNECTION (integrations row, kind='crm') + a dormant 🔌 sync that
-- pulls PERSON contacts into source='crm' leads and enrolls them into the connection's linked campaign,
-- DRY-RUN-safe. The real HubSpot/Salesforce OAuth + sync API are NOT configured, so the connection
-- stays disconnected/pending and the sync is a no-op; proven only by a TEST-ONLY FakeCrmClient.
--
-- TOKEN SECURITY (the crux): OAuth tokens must NEVER reach the browser. The existing integrations
-- SELECT-to-authenticated policy covers ALL columns — so storing tokens in integrations.oauth would
-- leak them via PostgREST. Fix by PHYSICAL SEPARATION: tokens (+ the OAuth CSRF state) move to a new
-- service-role-only integration_secrets vault; the integrations table is stripped of its secret
-- columns and stays client-readable metadata ONLY. This keeps the authenticated SELECT (so
-- resolveAudience + the read route can see status under RLS) while making a token leak impossible —
-- there is no token column on the readable table.

-- integration_secrets — the token vault. SERVICE-ROLE ONLY (RLS enabled, NO policies → deny-all to
-- authenticated; only the service-role reads/writes — the enrichment_cache posture). oauth holds the
-- access/refresh tokens; oauth_state holds the single-use OAuth CSRF nonce+exp during a connect.
create table public.integration_secrets (
  id uuid primary key default gen_random_uuid(),
  integration_id uuid not null unique references public.integrations(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  oauth jsonb,
  oauth_state jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index integration_secrets_organization_id_idx on public.integration_secrets(organization_id);
create trigger integration_secrets_set_updated_at before update on public.integration_secrets
  for each row execute function public.set_updated_at();
alter table public.integration_secrets enable row level security;
-- intentionally NO policies: authenticated is denied; the service-role (bypasses RLS) is the only access.

-- integrations — strip the secret columns; it becomes client-readable connection METADATA only.
-- Tokens + OAuth state moved to integration_secrets; the non-sensitive sync cursor stays here.
alter table public.integrations drop column if exists oauth;
alter table public.integrations drop column if exists sync_state;
alter table public.integrations add column status text not null default 'disconnected'
  check (status in ('disconnected', 'pending', 'connected', 'error'));
alter table public.integrations add column last_synced_at timestamptz;
alter table public.integrations add column error text;
alter table public.integrations add column sync_cursor text;
-- the warm_outbound / cross_sell campaign synced contacts enroll into (the tracked_domains.campaign_id analog)
alter table public.integrations add column campaign_id uuid references public.campaigns(id) on delete set null;
alter table public.integrations add constraint integrations_org_kind_provider_key
  unique (organization_id, kind, provider);
create index integrations_campaign_id_idx on public.integrations(campaign_id);
-- The existing "org members read integrations" SELECT policy is KEPT — it is now safe (no secret
-- column) and is what lets resolveAudience + GET /integrations read status under RLS. Writes stay
-- service-role (no authenticated write policy): connect/disconnect/link write via the admin client
-- scoped to the caller's JWT org.

-- Widen the lead source CHECK to add 'crm' (drop+recreate the named constraints — the 4.6 pattern).
alter table public.people drop constraint people_source_check;
alter table public.people add constraint people_source_check
  check (source in ('manual', 'find_leads', 'signals', 'website_visitors', 'csv_import', 'crm'));
alter table public.companies drop constraint companies_source_check;
alter table public.companies add constraint companies_source_check
  check (source in ('manual', 'find_leads', 'signals', 'website_visitors', 'csv_import', 'crm'));
alter table public.local_businesses drop constraint local_businesses_source_check;
alter table public.local_businesses add constraint local_businesses_source_check
  check (source in ('manual', 'find_leads', 'signals', 'website_visitors', 'csv_import', 'crm'));
