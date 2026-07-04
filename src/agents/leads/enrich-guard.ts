import type { SupabaseClient } from '@supabase/supabase-js';

// Lead-ENRICHMENT spend guardrail — the safety net for the metered email-reveal path (Apollo
// people/match charges a provider export credit per revealed email). Mirrors search-guard.ts
// one-for-one, but on credit_ledger reason='enrichment':
//   • two independent DAILY ceilings (per-org AND global) make runaway spend structurally
//     impossible regardless of the provider's per-call price;
//   • the credit ENFORCE (balance >= ENRICH_COST) happens BEFORE the paid call, in enrich.ts;
//   • the debit is written only AFTER a usable email is obtained (a failed enrichment costs 0),
//     idempotency-keyed `enrichment:<personId>:<utc-date>` so an Inngest retry can never
//     double-charge (credit_ledger.idempotency_key is UNIQUE).
// The seed provider is unmetered and never touches any of this.

export interface EnrichCaps {
  perOrg: number;
  global: number;
}

/** Pure: is another metered enrichment over either daily ceiling? (counts = enrichments already
 *  debited today). */
export function assessEnrichRate(
  orgCount: number,
  globalCount: number,
  caps: EnrichCaps,
): boolean {
  return orgCount >= caps.perOrg || globalCount >= caps.global;
}

/** Count today's metered enrichments — org-scoped and/or global. UTC day. Each successful metered
 *  enrichment writes exactly one 'enrichment' row, so this is the quota counter (mirrors
 *  countLeadSearchesToday). */
export async function countEnrichmentsToday(
  db: SupabaseClient,
  organizationId?: string,
): Promise<number> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  let q = db
    .from('credit_ledger')
    .select('id', { count: 'exact', head: true })
    .eq('reason', 'enrichment')
    .gte('created_at', since.toISOString());
  if (organizationId) q = q.eq('organization_id', organizationId);
  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
}
