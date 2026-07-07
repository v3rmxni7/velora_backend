-- L1 compliance (CAN-SPAM / GDPR): every LIVE commercial send must carry a valid physical postal
-- address of the sender. There was NO address field anywhere in the schema (only the optional,
-- send-orphaned senders.signature), so live cold sends went out without one. This adds an org-level
-- postal address that the compliance footer injects into every live send; a fail-closed guard in the
-- send chokepoints refuses a LIVE send when it is unset (dry-run / demo unaffected).
--
-- Nullable, and DELIBERATELY no authenticated UPDATE policy on organizations (same posture as the
-- two-flag sending columns): it is set via an owner-gated service-role route, never a broad client
-- UPDATE that could also touch sending_enabled / sending_dry_run. Reads ride the existing
-- authenticated SELECT on organizations.
alter table public.organizations
  add column if not exists postal_address text;

comment on column public.organizations.postal_address is
  'Physical postal address (CAN-SPAM / GDPR). Injected into every LIVE send footer; a live send is blocked (fail-closed) when unset. Owner-set via a service-role route — organizations has no authenticated UPDATE policy.';
