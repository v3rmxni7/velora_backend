import type { SupabaseClient } from '@supabase/supabase-js';
import { events, inngest } from '../../workers/inngest/client.js';
import { assignVariantIndex } from '../sending/assign-variant.js';
import { isCampaignActive } from '../sending/pipeline.js';
import type { ResolvedCompany, ResolvedPerson, VisitorResolver } from './resolver.js';

// Phase 4 Slice 4.6 — website-visit ingestion + de-anon resolution. Two halves:
//  (1) the PUBLIC pixel beacon (pixel.ts) records a raw ANONYMOUS visit (no PII, no IP) — the pure
//      helpers validateBeacon + sanitizeUrl below guard/minimize that write.
//  (2) the resolver core (processVisit / runVisitorSweep, service-role): turns a 'new' visit into an
//      identified person/company lead (source='website_visitors') and — for a PERSON only — enrolls it
//      into the tracked domain's website_visitor campaign, DRY-RUN-safe (rides the unchanged executor →
//      executeSend chokepoint behind the two-flag invariant + the 4.1a isCampaignActive gate). Metered
//      to credit_ledger. The resolver itself is 🔌 NOT connected (getResolver→null), so this whole half
//      is dormant in prod; the integration suite proves it with a TEST-ONLY FakeResolver.

const PROVIDER = 'website_visitor'; // people/companies.provider (the SOURCE channel; vendor lives on the identification)

/** PURE: a beacon is recordable only with a stable visitor id AND a per-beacon event id (the dedup
 * nonce → one visit per (tracked_domain_id, event_id), so retries/replays collapse). */
export function validateBeacon(
  p: { anonVisitorId?: string | null; eventId?: string | null } | null | undefined,
): { ok: true; anonVisitorId: string; eventId: string } | { ok: false; error: string } {
  const anonVisitorId = p?.anonVisitorId?.trim();
  const eventId = p?.eventId?.trim();
  if (!anonVisitorId) return { ok: false, error: 'missing_anon_visitor_id' };
  if (!eventId) return { ok: false, error: 'missing_event_id' };
  return { ok: true, anonVisitorId, eventId };
}

/** PURE: minimize a URL before persisting — drop the query string + fragment (they routinely carry
 * emails/tokens/session ids), keep origin+path, cap length. Returns null for empty/garbage input. */
export function sanitizeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`.slice(0, 2048);
  } catch {
    const head = String(raw).split('?')[0]?.split('#')[0]?.trim() ?? '';
    return head ? head.slice(0, 2048) : null;
  }
}

/** PURE: map a resolved person to the person-lead upsert row (source='website_visitors' provenance). */
export function mapIdentificationToPersonRow(
  organizationId: string,
  person: ResolvedPerson,
): Record<string, unknown> {
  return {
    organization_id: organizationId,
    provider: PROVIDER,
    external_id: person.externalId,
    email: person.email,
    full_name: person.fullName ?? null,
    first_name: person.firstName ?? null,
    last_name: person.lastName ?? null,
    title: person.title ?? null,
    company_name: person.companyName ?? null,
    source: 'website_visitors',
  };
}

/** PURE: map a resolved company to the company-lead upsert row. Company leads are display-only —
 * they have no email and dead-end at no_email, so they are NEVER enrolled (see processVisit). */
export function mapIdentificationToCompanyRow(
  organizationId: string,
  company: ResolvedCompany,
): Record<string, unknown> {
  return {
    organization_id: organizationId,
    provider: PROVIDER,
    external_id: company.externalId,
    name: company.name,
    domain: company.domain ?? null,
    industry: company.industry ?? null,
    source: 'website_visitors',
  };
}

async function markFailed(db: SupabaseClient, visitId: string, error: string): Promise<void> {
  await db.from('website_visits').update({ status: 'failed', error }).eq('id', visitId);
}

export interface SweepResult {
  swept: number;
  identified: number;
  enrolled: number;
  unresolved: number;
  failed: number;
}

export type ProcessOutcome = 'identified' | 'unresolved' | 'skipped' | 'not_found' | 'failed';

/**
 * Sweep 'new' visits and resolve each (the monitor cron's core; a plain function tests call directly).
 * A null resolver (the prod default — de-anon not connected) is a documented NO-OP. Per-org fairness:
 * each org gets at most `perOrg` visits per sweep, so one org's flood can't starve the others.
 */
export async function runVisitorSweep(
  db: SupabaseClient,
  resolver: VisitorResolver | null,
  opts: { perOrg?: number; maxOrgs?: number } = {},
): Promise<SweepResult> {
  const empty: SweepResult = { swept: 0, identified: 0, enrolled: 0, unresolved: 0, failed: 0 };
  if (!resolver) return empty; // 🔌 no resolver connected → nothing is ever resolved
  const perOrg = opts.perOrg ?? 25;
  const maxOrgs = opts.maxOrgs ?? 50;

  // Distinct orgs with pending visits (cheap via the (org,status) index), oldest-first, capped.
  const orgRows = await db
    .from('website_visits')
    .select('organization_id')
    .eq('status', 'new')
    .order('created_at', { ascending: true })
    .limit(2000);
  if (orgRows.error) throw orgRows.error;
  const orgIds = [...new Set((orgRows.data ?? []).map((r) => r.organization_id as string))].slice(
    0,
    maxOrgs,
  );

  const ids: string[] = [];
  for (const org of orgIds) {
    const r = await db
      .from('website_visits')
      .select('id')
      .eq('organization_id', org)
      .eq('status', 'new')
      .order('created_at', { ascending: true })
      .limit(perOrg);
    if (r.error) throw r.error;
    ids.push(...(r.data ?? []).map((x) => x.id as string));
  }

  const result: SweepResult = { ...empty, swept: ids.length };
  for (const id of ids) {
    try {
      const res = await processVisit(db, resolver, id);
      if (res.outcome === 'identified') {
        result.identified += 1;
        if (res.enrolled) result.enrolled += 1;
      } else if (res.outcome === 'unresolved') {
        result.unresolved += 1;
      }
    } catch (err) {
      result.failed += 1;
      console.error('[website-visitor-monitor] visit failed', { visitId: id, err });
    }
  }
  return result;
}

/**
 * Resolve ONE visit (service-role). Idempotent + concurrency-safe via a new→resolving CAS (a concurrent
 * runner / a re-run gets 0 rows → 'skipped'). On a hit: upsert the lead, record the identification
 * (idempotent on visit_id,kind), debit credits (idempotent key), and — for a PERSON only — enroll into
 * the tracked domain's website_visitor campaign (DRY-RUN-safe). A company is display-only (no email →
 * never enrolled). Cross-tenant guard: the service-role path bypasses RLS, so enrollment asserts the
 * campaign belongs to the visit's org.
 */
export async function processVisit(
  db: SupabaseClient,
  resolver: VisitorResolver,
  visitId: string,
): Promise<{ outcome: ProcessOutcome; kind?: 'person' | 'company'; enrolled?: boolean }> {
  const visit = await db
    .from('website_visits')
    .select('id, organization_id, tracked_domain_id, anon_visitor_id, page_url, referrer, status')
    .eq('id', visitId)
    .maybeSingle();
  if (visit.error) throw visit.error;
  if (!visit.data) return { outcome: 'not_found' };
  if (visit.data.status !== 'new') return { outcome: 'skipped' };
  const org = visit.data.organization_id as string;

  // CAS new→resolving: a single winner proceeds; a concurrent run gets 0 rows and returns.
  const claim = await db
    .from('website_visits')
    .update({ status: 'resolving' })
    .eq('id', visitId)
    .eq('status', 'new')
    .select('id');
  if (claim.error) throw claim.error;
  if ((claim.data ?? []).length === 0) return { outcome: 'skipped' };

  try {
    const domain = await db
      .from('website_tracked_domains')
      .select('id, organization_id, campaign_id, domain')
      .eq('id', visit.data.tracked_domain_id)
      .maybeSingle();
    if (domain.error) throw domain.error;
    if (!domain.data) {
      await markFailed(db, visitId, 'tracked_domain_missing');
      return { outcome: 'failed' };
    }

    const result = await resolver.resolve({
      organizationId: org,
      trackedDomainId: domain.data.id as string,
      domain: domain.data.domain as string,
      anonVisitorId: visit.data.anon_visitor_id as string,
      pageUrl: (visit.data.page_url as string | null) ?? null,
      referrer: (visit.data.referrer as string | null) ?? null,
    });

    if (result.kind === 'none') {
      await db
        .from('website_visits')
        .update({ status: 'unresolved', resolved_at: new Date().toISOString() })
        .eq('id', visitId);
      return { outcome: 'unresolved' };
    }

    // Upsert the lead (person or company), then record the identification + debit one credit.
    let personId: string | null = null;
    let companyId: string | null = null;
    if (result.kind === 'person') {
      const lead = await db
        .from('people')
        .upsert(mapIdentificationToPersonRow(org, result.person), {
          onConflict: 'organization_id,provider,external_id',
        })
        .select('id')
        .single();
      if (lead.error) throw lead.error;
      personId = lead.data.id as string;
    } else {
      const lead = await db
        .from('companies')
        .upsert(mapIdentificationToCompanyRow(org, result.company), {
          onConflict: 'organization_id,provider,external_id',
        })
        .select('id')
        .single();
      if (lead.error) throw lead.error;
      companyId = lead.data.id as string;
    }

    const ident = await db.from('website_visitor_identifications').upsert(
      {
        organization_id: org,
        visit_id: visitId,
        tracked_domain_id: domain.data.id,
        kind: result.kind,
        person_id: personId,
        company_id: companyId,
        provider: resolver.provider,
        confidence: result.confidence ?? null,
      },
      { onConflict: 'visit_id,kind', ignoreDuplicates: true },
    );
    if (ident.error) throw ident.error;

    // Meter the (paid) identification. idempotency_key blocks a double-charge on retry; 23505 = no-op.
    const debit = await db.from('credit_ledger').insert({
      organization_id: org,
      delta: -1,
      reason: 'website_visitor_identification',
      reference: { type: 'website_visit', id: visitId, provider: resolver.provider },
      idempotency_key: `website_visitor:identify:${visitId}:${result.kind}`,
    });
    if (debit.error && debit.error.code !== '23505') throw debit.error;

    // Enroll only a PERSON (a company dead-ends at no_email). Needs the domain to feed a campaign.
    let enrolled = false;
    const campaignId = domain.data.campaign_id as string | null;
    if (result.kind === 'person' && personId && campaignId) {
      const camp = await db
        .from('campaigns')
        .select('id, organization_id, status')
        .eq('id', campaignId)
        .maybeSingle();
      if (camp.error) throw camp.error;
      // Cross-tenant guard (service-role bypasses RLS): the campaign must be the visit's org.
      if (!camp.data || camp.data.organization_id !== org) {
        await markFailed(db, visitId, 'domain_org_mismatch');
        return { outcome: 'failed', kind: 'person', enrolled: false };
      }
      // 4.1a — enroll only into an active campaign; a paused one leaves the visit identified (the lead
      // + identification stand) but does not enroll. (Re-running won't re-enter — status is 'resolving'
      // → 'identified' below.)
      if (await isCampaignActive(db, campaignId)) {
        const variants = await db
          .from('campaign_variants')
          .select('id')
          .eq('campaign_id', campaignId)
          .order('label', { ascending: true });
        if (variants.error) throw variants.error;
        const vs = variants.data ?? [];
        const variantId =
          vs.length > 0
            ? vs[assignVariantIndex(`${campaignId}:person:${personId}`, vs.length)]?.id
            : undefined;
        const enr = await db.from('enrollments').upsert(
          {
            organization_id: org,
            campaign_id: campaignId,
            lead_type: 'person',
            lead_id: personId,
            status: 'pending',
            current_step: 1,
            ...(variantId ? { variant_id: variantId } : {}),
          },
          { onConflict: 'campaign_id,lead_type,lead_id', ignoreDuplicates: true },
        );
        if (enr.error) throw enr.error;
        enrolled = true;
      }
    }

    await db
      .from('website_visits')
      .update({ status: 'identified', resolved_at: new Date().toISOString() })
      .eq('id', visitId);

    // Best-effort: kick the executor to prepare the new pending enrollment (gates → draft → task),
    // DRY-RUN behind the two-flag invariant. Idempotent dedupeKey.
    if (enrolled && campaignId) {
      try {
        await inngest.send({
          name: events.campaignExecute.name,
          data: {
            organizationId: org,
            campaignId,
            dedupeKey: `campaign:${campaignId}:visit:${visitId}`,
          },
        });
      } catch {
        // non-fatal; the next executor run / sweep still prepares the pending enrollment
      }
    }
    return { outcome: 'identified', kind: result.kind, enrolled };
  } catch (err) {
    await markFailed(db, visitId, err instanceof Error ? err.message : 'resolve_error');
    throw err;
  }
}
