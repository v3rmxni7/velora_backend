import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The org's credit balance, summed IN THE DATABASE via the org_credit_balance() RPC.
 *
 * A client-side `.select('delta')` + JS reduce silently truncates at PostgREST's 1000-row default
 * cap, so any org with >1000 ledger rows gets a WRONG balance — corrupting the send/search/enrich
 * credit gates. The RPC's SQL aggregate returns one row, so the cap never applies. SECURITY INVOKER
 * on the function means RLS still scopes a user client to its own org (0 for any other).
 */
export async function orgCreditBalance(
  db: SupabaseClient,
  organizationId: string,
): Promise<number> {
  const { data, error } = await db.rpc('org_credit_balance', { p_org: organizationId });
  if (error) throw error;
  return Number(data ?? 0);
}
