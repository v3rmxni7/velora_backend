import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

// Lead-search SPEND GUARDRAIL — the safety net for the metered (paid-provider) find-leads path.
// Mirrors the send volume governor (assessSendRate / countSendsToday) but on credit_ledger
// reason='lead_search'. Two independent ceilings contain runaway spend regardless of the provider's
// exact per-call price: a per-org AND a global DAILY SEARCH QUOTA. A separate credit ENFORCE gates on
// balance before the paid call. The seed fixture is never metered, so none of this touches it.
//
// credit_ledger is APPEND-ONLY and SERVICE-ROLE-WRITE-ONLY (RLS: clients can only read their own org's
// rows) — so the count/debit here take the service-role admin client, exactly like executeSend's debit.

export interface LeadSearchCaps {
  perOrg: number;
  global: number;
}

/** Pure: is another metered search over either daily ceiling? (counts = searches already today.) */
export function assessLeadSearchRate(
  orgCount: number,
  globalCount: number,
  caps: LeadSearchCaps,
): boolean {
  return orgCount >= caps.perOrg || globalCount >= caps.global;
}

/** Count today's metered lead searches — org-scoped and/or global. UTC day. Each metered search writes
 *  exactly one 'lead_search' row, so this is the quota counter (mirrors countSendsToday on messages). */
export async function countLeadSearchesToday(
  db: SupabaseClient,
  organizationId?: string,
): Promise<number> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  let q = db
    .from('credit_ledger')
    .select('id', { count: 'exact', head: true })
    .eq('reason', 'lead_search')
    .gte('created_at', since.toISOString());
  if (organizationId) q = q.eq('organization_id', organizationId);
  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
}

/** Sum the org's credit_ledger balance. Local copy of pipeline.creditBalance so the sending module is
 *  left completely untouched by this slice. */
export async function creditBalanceFor(
  db: SupabaseClient,
  organizationId: string,
): Promise<number> {
  const { data, error } = await db
    .from('credit_ledger')
    .select('delta')
    .eq('organization_id', organizationId);
  if (error) throw error;
  return (data ?? []).reduce((sum, r) => sum + Number(r.delta), 0);
}

/** Record ONE metered lead-search debit (service-role only). A fresh idempotency_key per search; the
 *  spend CEILING is the daily quota, not per-row idempotency (each user search is a distinct charge).
 *  Always writes a row (even when LEAD_SEARCH_COST=0 → a 0-delta audit row) so the quota stays
 *  countable in a metering-off configuration. Called only AFTER a successful provider search. */
export async function recordLeadSearchDebit(
  admin: SupabaseClient,
  organizationId: string,
  opts: { entityType: string; cost: number; resultCount: number },
): Promise<void> {
  const { error } = await admin.from('credit_ledger').insert({
    organization_id: organizationId,
    delta: -opts.cost,
    reason: 'lead_search',
    reference: { type: 'lead_search', entityType: opts.entityType, results: opts.resultCount },
    idempotency_key: `lead_search:${organizationId}:${randomUUID()}`,
  });
  if (error) throw error;
}
