-- S1 — productized go-live. The two-flag flip stays a SERVICE-ROLE act (no authenticated UPDATE
-- policy on organizations — same posture as the sending flags); this only adds a staff-review gate
-- + the audit kinds the go-live/pause routes write.
--
-- go_live_reviewed = the anti-abuse "first go-live per org is lightly staff-reviewed" gate. Staff set
-- it true (service-role) after reviewing an org; the go-live readiness check requires it. Default
-- false so a brand-new self-serve org cannot flip itself live until reviewed. NO authenticated UPDATE
-- policy is added (organizations keeps SELECT-only RLS) — it is set exactly like the sending flags.
alter table public.organizations
  add column if not exists go_live_reviewed boolean not null default false;

comment on column public.organizations.go_live_reviewed is
  'Anti-abuse gate: staff (service-role) set this true after reviewing an org before its FIRST productized go-live. Readiness requires it. No authenticated UPDATE policy — service-role only.';

-- Grandfather orgs that are ALREADY live (sending_enabled=true) — they went live via the prior
-- runbook flip, which was already an owner/staff-reviewed act, so they must not be locked out of the
-- productized go-live / re-go-live path. Brand-new orgs (enabled=false) stay unreviewed.
update public.organizations set go_live_reviewed = true where sending_enabled = true;

-- Audit kinds the go-live + pause-live routes append (folded-in from the collapsed L2). Drop+recreate
-- the named CHECK (the established widening pattern). Additive; existing kinds unchanged.
alter table public.audit_logs drop constraint if exists audit_logs_kind_check;
alter table public.audit_logs add constraint audit_logs_kind_check check (kind in (
  'team_role_changed', 'team_member_removed', 'sender_status_changed',
  'suppression_added', 'copilot_action_confirmed', 'domain_verified',
  'postal_address_updated', 'sending_go_live', 'sending_paused',
  'retention_reported', 'retention_purged'
));
