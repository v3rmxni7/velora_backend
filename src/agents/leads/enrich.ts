import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from '../../config/env.js';
import { createLeadProvider } from '../../integrations/leads/index.js';
import type { LeadProvider } from '../../integrations/leads/types.js';
import { bestEffortSendDebit } from '../sending/credit-debit.js';
import { creditBalanceFor } from './search-guard.js';
import { assessEnrichRate, countEnrichmentsToday } from './enrich-guard.js';

// On-enroll person enrichment (Slice E3) — obtains a REAL work email for a saved person lead via
// the provider's match endpoint, under the full spend discipline:
//
//   already has email → short-circuit (free) → recently attempted & still empty → honest no_email
//   → DAILY QUOTA (per-org + global, enrich-guard) → CREDIT ENFORCE (balance >= ENRICH_COST,
//   BEFORE the paid call) → CLAIM (conditional enriched_at stamp — the concurrency/idempotency
//   guard: an Inngest retry or a second campaign enrolling the same person can't double-call the
//   provider) → paid provider match → email write (only-if-still-null; never clobbers) → DEBIT
//   (after success only; idempotency-keyed per person per UTC day — UNIQUE key makes double-charge
//   structurally impossible).
//
// HONESTY: a lead either gains a real provider-returned address or stays email-less with an honest
// outcome. Nothing here fabricates, and a failed/no-match enrichment costs 0 on our meter.
// The seed provider (metered=false) skips quota/credit/debit but keeps every honesty rule.

/** How long a no-email enrichment attempt suppresses re-spend on the same person. */
const REATTEMPT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type EnrichOutcome =
  | 'enriched' // a real email was obtained (and debited, if metered)
  | 'already' // the person already had an email — nothing spent
  | 'no_email_found' // provider could not produce a real address (attempt stamped; zero debit)
  | 'quota' // daily enrichment ceiling reached — defer, don't fail
  | 'insufficient_credit'; // balance below ENRICH_COST — defer, don't fail

export interface EnrichResult {
  outcome: EnrichOutcome;
  email?: string;
}

interface PersonRow {
  id: string;
  organization_id: string;
  email: string | null;
  external_id: string | null;
  full_name: string | null;
  company_name: string | null;
  linkedin_url: string | null;
  enriched_at: string | null;
}

/** Enrich one person lead. `db` must be the service-role admin client (ledger writes + the claim
 *  update go through RLS-exempt paths, exactly like the campaign executor that calls this). */
export async function enrichPersonLead(
  db: SupabaseClient,
  personId: string,
  provider: LeadProvider = createLeadProvider(),
): Promise<EnrichResult> {
  const { data, error } = await db
    .from('people')
    .select('id, organization_id, email, external_id, full_name, company_name, linkedin_url, enriched_at')
    .eq('id', personId)
    .maybeSingle();
  if (error) throw error;
  const person = data as PersonRow | null;
  if (!person) return { outcome: 'no_email_found' };
  if (person.email) return { outcome: 'already', email: person.email };

  // A recent attempt that produced nothing → honest no_email without re-spending. (The window
  // also lets a genuinely re-attempted enrichment after 30 days charge again — a new day-keyed
  // idempotency key, a legitimate new charge.)
  const lastAttempt = person.enriched_at ? new Date(person.enriched_at).getTime() : 0;
  if (lastAttempt && Date.now() - lastAttempt < REATTEMPT_WINDOW_MS) {
    return { outcome: 'no_email_found' };
  }

  const org = person.organization_id;

  if (provider.metered) {
    // Two independent daily ceilings — checked BEFORE any paid call.
    const [orgCount, globalCount] = await Promise.all([
      countEnrichmentsToday(db, org),
      countEnrichmentsToday(db),
    ]);
    const caps = { perOrg: env.ENRICH_DAILY_CAP_PER_ORG, global: env.ENRICH_DAILY_CAP_GLOBAL };
    if (assessEnrichRate(orgCount, globalCount, caps)) return { outcome: 'quota' };

    // Credit ENFORCE before the paid call — insufficient balance means Apollo is never called.
    if ((await creditBalanceFor(db, org)) < env.ENRICH_COST) {
      return { outcome: 'insufficient_credit' };
    }
  }

  // CLAIM: stamp enriched_at only when unclaimed (or stale) AND still email-less. Exactly one
  // concurrent caller wins; the loser re-reads once (the winner may have already written an email).
  const staleIso = new Date(Date.now() - REATTEMPT_WINDOW_MS).toISOString();
  const claim = await db
    .from('people')
    .update({ enriched_at: new Date().toISOString() })
    .eq('id', personId)
    .is('email', null)
    .or(`enriched_at.is.null,enriched_at.lt.${staleIso}`)
    .select('id');
  if (claim.error) throw claim.error;
  if (!claim.data?.length) {
    const re = await db.from('people').select('email').eq('id', personId).maybeSingle();
    if (re.error) throw re.error;
    const email = (re.data?.email as string | null) ?? null;
    return email ? { outcome: 'already', email } : { outcome: 'no_email_found' };
  }

  // The paid call (or free fixture lookup for seed). Provider errors propagate — the enrollment
  // stays pending and the executor's per-enrollment isolation retries on the next run.
  const match = await provider.enrichPerson({
    externalId: person.external_id ?? undefined,
    fullName: person.full_name ?? undefined,
    companyName: person.company_name ?? undefined,
    linkedinUrl: person.linkedin_url ?? undefined,
  });
  if (!match) return { outcome: 'no_email_found' }; // attempt stamped; zero debit

  // Write the email only if still null — never clobber a concurrent/manual write.
  const write = await db
    .from('people')
    .update({ email: match.email })
    .eq('id', personId)
    .is('email', null)
    .select('id');
  if (write.error) throw write.error;

  if (provider.metered) {
    // DEBIT — after success only. Day-keyed idempotency: a retry can never double-charge
    // (credit_ledger.idempotency_key is UNIQUE; 23505 → already charged, silent no-op).
    const utcDay = new Date().toISOString().slice(0, 10);
    await bestEffortSendDebit(db, {
      organizationId: org,
      reason: 'enrichment',
      delta: -env.ENRICH_COST,
      reference: { type: 'enrichment', personId, provider: provider.name },
      idempotencyKey: `enrichment:${personId}:${utcDay}`,
    });
  }

  return { outcome: 'enriched', email: match.email };
}
