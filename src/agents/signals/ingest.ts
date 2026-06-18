import type { SupabaseClient } from '@supabase/supabase-js';
import { events, inngest } from '../../workers/inngest/client.js';
import { assignVariantIndex } from '../sending/assign-variant.js';
import { isCampaignActive } from '../sending/pipeline.js';

// Phase 4 Slice 4.5 — signal-event ingestion. A pending signal_event becomes a person lead
// (source='signals', honest provenance) enrolled into the subscription's intent_signals campaign,
// DRY-RUN-safe (the enrollment rides the unchanged executor/executeSend chokepoint behind the
// two-flag invariant; the monitor additionally re-checks the 4.1a campaign.status='active' gate).
// Idempotent (status CAS + the enrollment unique key). The service-role monitor bypasses RLS, so it
// asserts the subscription's campaign belongs to the event's org. Real feeds are deferred (🔌); test
// events carry origin='test_inject'.

export interface SignalEventPayload {
  externalId?: string;
  email?: string;
  full_name?: string;
  first_name?: string;
  last_name?: string;
  title?: string;
  company_name?: string;
}
export interface SignalDef {
  key: string;
  category: string;
}

export type ProcessOutcome =
  | 'enrolled'
  | 'no_subscription'
  | 'campaign_paused'
  | 'failed'
  | 'skipped'
  | 'not_found';

/** PURE: an event payload is enrollable only with a stable externalId AND a contact email (so the
 * lead is a reachable PERSON, not a company that dead-ends at no_email). */
export function validateEventPayload(
  p: SignalEventPayload | null | undefined,
): { ok: true } | { ok: false; error: string } {
  if (!p?.externalId?.trim()) return { ok: false, error: 'missing_external_id' };
  if (!p?.email?.trim()) return { ok: false, error: 'missing_email' };
  return { ok: true };
}

/** PURE: map a validated event to the person-lead upsert row (source='signals' provenance). */
export function mapEventToPersonRow(
  organizationId: string,
  def: SignalDef,
  p: SignalEventPayload,
): Record<string, unknown> {
  return {
    organization_id: organizationId,
    provider: `signal:${def.category}`,
    external_id: `${def.key}:${p.externalId}`,
    email: p.email,
    full_name: p.full_name ?? null,
    first_name: p.first_name ?? null,
    last_name: p.last_name ?? null,
    title: p.title ?? null,
    company_name: p.company_name ?? null,
    source: 'signals',
  };
}

async function markFailed(db: SupabaseClient, eventId: string, error: string): Promise<void> {
  await db.from('signal_events').update({ status: 'failed', error }).eq('id', eventId);
}

export interface SweepResult {
  swept: number;
  enrolled: number;
  failed: number;
}

/**
 * Sweep pending signal_events and process each (the monitor cron's core; a plain function tests call
 * directly). A paused campaign's event is left pending and retried on the next sweep — so a pause is
 * never a lost event. Per-event errors are isolated (logged + counted), never aborting the sweep.
 */
export async function runSignalSweep(db: SupabaseClient, limit = 100): Promise<SweepResult> {
  const pending = await db
    .from('signal_events')
    .select('id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(limit);
  if (pending.error) throw pending.error;
  let enrolled = 0;
  let failed = 0;
  for (const row of pending.data ?? []) {
    try {
      const res = await processSignalEvent(db, row.id as string);
      if (res.outcome === 'enrolled') enrolled += 1;
    } catch (err) {
      failed += 1;
      console.error('[signal-monitor] event failed', { eventId: row.id, err });
    }
  }
  return { swept: (pending.data ?? []).length, enrolled, failed };
}

/**
 * Process ONE signal_event (service-role). Idempotent + concurrency-safe: the pause check runs
 * before any CAS (a paused campaign LEAVES the event pending for the next sweep), then a
 * pending→processing CAS elects a single winner. Returns the outcome.
 */
export async function processSignalEvent(
  db: SupabaseClient,
  eventId: string,
): Promise<{ outcome: ProcessOutcome }> {
  const ev = await db
    .from('signal_events')
    .select('id, organization_id, signal_definition_id, payload, status')
    .eq('id', eventId)
    .maybeSingle();
  if (ev.error) throw ev.error;
  if (!ev.data) return { outcome: 'not_found' };
  if (ev.data.status !== 'pending') return { outcome: 'skipped' };
  const org = ev.data.organization_id as string;
  const payload = (ev.data.payload ?? {}) as SignalEventPayload;

  const valid = validateEventPayload(payload);
  if (!valid.ok) {
    await markFailed(db, eventId, valid.error);
    return { outcome: 'failed' };
  }

  const def = await db
    .from('signal_definitions')
    .select('key, category')
    .eq('id', ev.data.signal_definition_id)
    .maybeSingle();
  if (def.error) throw def.error;
  if (!def.data) {
    await markFailed(db, eventId, 'unknown_signal');
    return { outcome: 'failed' };
  }

  const sub = await db
    .from('signal_subscriptions')
    .select('campaign_id')
    .eq('organization_id', org)
    .eq('signal_definition_id', ev.data.signal_definition_id)
    .eq('active', true)
    .maybeSingle();
  if (sub.error) throw sub.error;
  if (!sub.data) {
    // Nothing subscribed → there's nothing to enroll. Done (not an error).
    await db
      .from('signal_events')
      .update({ status: 'processed', processed_at: new Date().toISOString() })
      .eq('id', eventId);
    return { outcome: 'no_subscription' };
  }
  const campaignId = sub.data.campaign_id as string;

  // Cross-tenant guard: the service-role path bypasses RLS, so verify the campaign is the event's org.
  const camp = await db
    .from('campaigns')
    .select('id, organization_id, status')
    .eq('id', campaignId)
    .maybeSingle();
  if (camp.error) throw camp.error;
  if (!camp.data || camp.data.organization_id !== org) {
    await markFailed(db, eventId, 'campaign_org_mismatch');
    return { outcome: 'failed' };
  }
  // 4.1a — never enroll into a paused campaign. LEAVE pending (no CAS) so a later sweep retries.
  if (!(await isCampaignActive(db, campaignId))) return { outcome: 'campaign_paused' };

  // CAS pending→processing: a single winner proceeds; a concurrent run gets 0 rows and returns.
  const claim = await db
    .from('signal_events')
    .update({ status: 'processing' })
    .eq('id', eventId)
    .eq('status', 'pending')
    .select('id');
  if (claim.error) throw claim.error;
  if ((claim.data ?? []).length === 0) return { outcome: 'skipped' };

  try {
    const lead = await db
      .from('people')
      .upsert(mapEventToPersonRow(org, def.data as SignalDef, payload), {
        onConflict: 'organization_id,provider,external_id',
      })
      .select('id')
      .single();
    if (lead.error) throw lead.error;
    const leadId = lead.data.id as string;

    // Same cohort logic as launchCampaign (4.4): deterministic variant by the stable key.
    const variants = await db
      .from('campaign_variants')
      .select('id')
      .eq('campaign_id', campaignId)
      .order('label', { ascending: true });
    if (variants.error) throw variants.error;
    const vs = variants.data ?? [];
    const variantId =
      vs.length > 0
        ? vs[assignVariantIndex(`${campaignId}:person:${leadId}`, vs.length)]?.id
        : undefined;

    const enr = await db.from('enrollments').upsert(
      {
        organization_id: org,
        campaign_id: campaignId,
        lead_type: 'person',
        lead_id: leadId,
        status: 'pending',
        current_step: 1,
        ...(variantId ? { variant_id: variantId } : {}),
      },
      { onConflict: 'campaign_id,lead_type,lead_id', ignoreDuplicates: true },
    );
    if (enr.error) throw enr.error;

    await db
      .from('signal_events')
      .update({ status: 'processed', processed_at: new Date().toISOString() })
      .eq('id', eventId);

    // Best-effort: kick the executor to prepare the new pending enrollment (gates → draft → task),
    // DRY-RUN behind the two-flag invariant. Idempotent dedupeKey.
    try {
      await inngest.send({
        name: events.campaignExecute.name,
        data: {
          organizationId: org,
          campaignId,
          dedupeKey: `campaign:${campaignId}:signal:${eventId}`,
        },
      });
    } catch {
      // non-fatal; the next executor run / sweep still prepares the pending enrollment
    }
    return { outcome: 'enrolled' };
  } catch (err) {
    await markFailed(db, eventId, err instanceof Error ? err.message : 'ingest_error');
    throw err;
  }
}
