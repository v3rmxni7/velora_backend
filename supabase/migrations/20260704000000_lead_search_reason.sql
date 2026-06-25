-- 0029 lead_search_reason.sql — Lead-sourcing slice.
--
-- Widen the credit_ledger reason CHECK to meter REAL (paid-provider) lead searches. A metered
-- find-leads/search (Apollo/PDL, only when a provider key is set) debits LEAD_SEARCH_COST credits as
-- a 'lead_search' ledger row; the default seed provider (no key) never debits and is never metered.
--
-- No new table by design: the per-org + global daily search QUOTA counts today's 'lead_search' rows
-- (mirrors the send volume governor counting outbound messages — `countSendsToday`). This keeps lead
-- spend on the same credit meter as everything else and reuses the existing ledger RLS.
--
-- Same named-constraint drop+recreate pattern as 20260626000000 (website_visitor_identification) and
-- 20260630000000 (quest_reward/top_up). Additive + forward-only; widens, never narrows.

alter table public.credit_ledger drop constraint credit_ledger_reason_check;
alter table public.credit_ledger add constraint credit_ledger_reason_check
  check (reason in (
    'signup_grant', 'enrichment', 'send', 'reply', 'adjustment',
    'website_visitor_identification', 'quest_reward', 'top_up', 'lead_search'
  ));
