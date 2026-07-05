-- "Established mailbox" override. An already-warmed, in-use mailbox (real sending history) does not
-- need the new-domain warm-up physics — but our metric gate (≥100 Smartlead warm-up sends) can't see
-- its real-world reputation, so it sits at 'warming'. This flag lets an operator ATTEST a mailbox is
-- established, so classifyWarmth treats it as 'warm' (still subject to the spam-rate ceiling) and it
-- STAYS warm across re-syncs. Off by default — sending from an unproven mailbox must never be silent.
alter table public.mailboxes
  add column if not exists warmup_override boolean not null default false;

comment on column public.mailboxes.warmup_override is
  'Operator attests this is an established, real-use mailbox — warmth gate treats it as warm without waiting for the warm-up send threshold. Deliberate act; off by default.';
