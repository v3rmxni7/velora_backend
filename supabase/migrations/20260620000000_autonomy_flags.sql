-- 0014 autonomy_flags.sql — Phase 3 Slice 3.0: org-level autonomy switches.
-- SAFE BY DEFAULT: autonomy OFF, auto-reply OFF, conservative confidence floor. Nothing acts
-- until deliberately flipped (3.1+ wires the decision cores in). Readable by org members via the
-- existing org select policy; flippable only via service-role (organizations has no authenticated
-- UPDATE policy) — turning autonomy on is a privileged, deliberate act, mirroring the sending flags.
alter table public.organizations
  add column autonomy_enabled boolean not null default false,
  add column auto_send_min_confidence numeric not null default 0.80
    check (auto_send_min_confidence >= 0 and auto_send_min_confidence <= 1),
  add column auto_reply_mode text not null default 'off'
    check (auto_reply_mode in ('off','draft','send'));
