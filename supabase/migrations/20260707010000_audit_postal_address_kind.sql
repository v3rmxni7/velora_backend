-- L1 part 4 — the owner-gated postal-address setter records an audit_logs row of kind
-- 'postal_address_updated'. Widen the audit_logs.kind CHECK to allow it (drop + recreate the named
-- constraint — the credit_ledger reason-widening pattern). Append-only, additive; existing kinds
-- unchanged. Without this the best-effort audit would silently drop the row (compliance-trail gap).
alter table public.audit_logs drop constraint if exists audit_logs_kind_check;
alter table public.audit_logs add constraint audit_logs_kind_check check (kind in (
  'team_role_changed', 'team_member_removed', 'sender_status_changed',
  'suppression_added', 'copilot_action_confirmed', 'domain_verified',
  'postal_address_updated', 'retention_reported', 'retention_purged'
));
