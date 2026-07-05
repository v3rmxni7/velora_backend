-- Money-correctness: sum the credit ledger IN THE DATABASE.
--
-- A client-side sum over `.select('delta')` silently truncates at PostgREST's 1000-row default cap,
-- so any org with >1000 ledger rows gets a WRONG balance — which corrupts the send/search/enrich
-- credit gates (free live sends, or a false 'insufficient_credit'). A SQL aggregate returns exactly
-- ONE row, so the cap never applies.
--
-- SECURITY INVOKER: respects RLS. A signed-in user sees only their own org's ledger rows (so the sum
-- is correct for their org and 0 for any other org they pass — no cross-tenant leak); the service
-- role bypasses RLS and gets the true full sum for the org it names.
create or replace function public.org_credit_balance(p_org uuid)
returns numeric
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(sum(delta), 0)::numeric
  from public.credit_ledger
  where organization_id = p_org;
$$;

revoke all on function public.org_credit_balance(uuid) from public, anon;
grant execute on function public.org_credit_balance(uuid) to authenticated, service_role;
