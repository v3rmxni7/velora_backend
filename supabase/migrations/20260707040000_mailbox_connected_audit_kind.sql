-- S3 — the mailbox-connect lane audits a successful connect (WITHOUT any credential — only the
-- non-secret identity + the Smartlead account id). Widen the audit_logs.kind CHECK (established
-- fold-in pattern). Additive; existing kinds unchanged.
alter table public.audit_logs drop constraint if exists audit_logs_kind_check;
alter table public.audit_logs add constraint audit_logs_kind_check check (kind in (
  'team_role_changed', 'team_member_removed', 'sender_status_changed',
  'suppression_added', 'copilot_action_confirmed', 'domain_verified',
  'postal_address_updated', 'sending_go_live', 'sending_paused',
  'mailbox_warmup_override_set', 'mailbox_connected', 'retention_reported', 'retention_purged'
));
