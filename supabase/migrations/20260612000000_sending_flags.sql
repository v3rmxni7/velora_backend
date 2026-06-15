-- 0006 sending_flags.sql — Phase 2 Slice 2.0: org-level sending safety flags.
-- SAFE BY DEFAULT: sending OFF + dry-run ON. No org can perform a live send until BOTH
-- are deliberately flipped (the send chokepoint at Slice 2.5 calls assertLiveSendAllowed).
-- Readable by org members via the existing "org members read their organization" select
-- policy; flippable only via the service-role (organizations has no authenticated UPDATE
-- policy) — turning sending on is a privileged, deliberate act, never a normal user route.

alter table public.organizations
  add column sending_enabled boolean not null default false,
  add column sending_dry_run boolean not null default true;
