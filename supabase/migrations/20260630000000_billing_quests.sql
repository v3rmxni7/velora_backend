-- 0021 billing_quests.sql — Slice 4.10: credit reason widen (quest_reward + top_up), org plan tier,
-- sender signature. NO quest table: quest completion is DERIVED from real state on read, and the
-- AWARD itself IS the idempotent ledger row (reason='quest_reward', idempotency_key='quest:{org}:{key}',
-- reference={questKey}). The append-only ledger + the unique idempotency_key are the double-pay guards.

-- Widen the credit_ledger reason CHECK (same named-constraint drop+recreate as 20260626000000).
--  quest_reward — onboarding quests credit the ledger (activation system, SPEC §3.1/§3.14).
--  top_up       — reserved for a verified payment-provider top-up at go-live (honest-shell now; the
--                 seam only ever credits via a verified webhook — never a fabricated balance).
alter table public.credit_ledger drop constraint credit_ledger_reason_check;
alter table public.credit_ledger add constraint credit_ledger_reason_check
  check (reason in (
    'signup_grant', 'enrichment', 'send', 'reply', 'adjustment',
    'website_visitor_identification', 'quest_reward', 'top_up'
  ));

-- Plan tier — REAL stored data shown in /billing (SPEC §10). Org members already SELECT their
-- organization, so the UI reads `plan` under RLS. organizations has NO authenticated UPDATE policy,
-- so the tier is set only via the service-role / seed / admin — never by a user route and never by a
-- live charge (this slice ships no charging). Default 'starter' (the wedge tier).
alter table public.organizations
  add column plan text not null default 'starter' check (plan in ('starter', 'growth', 'scale'));

-- Sending identity: a real email signature. The SPEC names "set up email signature" as an onboarding
-- quest, so it needs a real field to complete against (nullable; configured via PATCH /senders/:id).
alter table public.senders add column signature text;
