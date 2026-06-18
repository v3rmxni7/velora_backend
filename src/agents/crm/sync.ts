import type { SupabaseClient } from '@supabase/supabase-js';
import type { CrmClient, CrmContact } from '../../integrations/crm/client.js';
import { events, inngest } from '../../workers/inngest/client.js';
import { assignVariantIndex } from '../sending/assign-variant.js';

// Phase 4 Slice 4.7 — CRM contact sync. The dormant 🔌 crm-sync-monitor pulls PERSON contacts from a
// connected CRM (HubSpot/Salesforce) into source='crm' leads and enrolls them, DRY-RUN-safe (rides the
// unchanged executor → executeSend chokepoint behind the two-flag invariant + the 4.1a active gate),
// into the connection's linked warm_outbound/cross_sell campaign. getCrmClient is null until a real CRM
// connects, so in prod this is a documented no-op; the integration suite proves it with a TEST-ONLY
// FakeCrmClient. Importing your OWN CRM contacts is NOT third-party enrichment → it does not debit
// credits. Tokens are read service-role from integration_secrets by the caller and never logged here.

/** PURE: map a CRM person contact to the person-lead upsert row. `provider` is the CRM (hubspot/
 * salesforce); the lead provider is namespaced `crm:${provider}` so the same numeric id from two CRMs
 * can't collide under the (org,provider,external_id) key. source='crm' for honest provenance. */
export function mapContactToPersonRow(
  organizationId: string,
  provider: string,
  contact: CrmContact,
): Record<string, unknown> {
  return {
    organization_id: organizationId,
    provider: `crm:${provider}`,
    external_id: contact.externalId,
    email: contact.email ?? null,
    full_name: contact.fullName ?? null,
    first_name: contact.firstName ?? null,
    last_name: contact.lastName ?? null,
    title: contact.title ?? null,
    company_name: contact.companyName ?? null,
    source: 'crm',
  };
}

interface CrmIntegrationRow {
  id: string;
  organization_id: string;
  provider: string;
  campaign_id: string | null;
  sync_cursor: string | null;
}

export interface SyncResult {
  integrations: number;
  synced: number; // person leads upserted
  enrolled: number; // enrollments created
  skipped: number; // contacts with no email (display-only)
  failed: number; // integration-level errors
}

export type ContactOutcome = 'enrolled' | 'synced' | 'skipped_no_email' | 'org_mismatch';

/** A factory the caller supplies — `getCrmClient(env, provider, oauth)` in prod (null → no-op), or a
 * FakeCrmClient in tests. The tokens (oauth) are read service-role by the caller; this fn never logs them. */
export type GetClient = (provider: string, oauth: unknown) => CrmClient | null;

/**
 * Sweep connected CRM integrations and sync each (the monitor cron's core; a plain function tests call
 * directly). An integration whose client is null (the prod default — no real provider/creds/tokens) is a
 * documented NO-OP. Per-integration errors are isolated (recorded as integration status='error', never
 * echoing the token) and never abort the sweep.
 */
export async function runCrmSync(db: SupabaseClient, getClient: GetClient): Promise<SyncResult> {
  const result: SyncResult = { integrations: 0, synced: 0, enrolled: 0, skipped: 0, failed: 0 };
  const integrations = await db
    .from('integrations')
    .select('id, organization_id, provider, campaign_id, sync_cursor')
    .eq('kind', 'crm')
    .eq('status', 'connected')
    .not('campaign_id', 'is', null);
  if (integrations.error) throw integrations.error;

  for (const intg of (integrations.data ?? []) as CrmIntegrationRow[]) {
    result.integrations += 1;
    try {
      const secrets = await db
        .from('integration_secrets')
        .select('oauth')
        .eq('integration_id', intg.id)
        .maybeSingle();
      if (secrets.error) throw secrets.error;
      const client = getClient(intg.provider, secrets.data?.oauth ?? null);
      if (!client) continue; // 🔌 not connected / no real client → no-op (never an error)

      const page = await client.listContacts(intg.sync_cursor ?? undefined);
      for (const contact of page.contacts) {
        const outcome = await processCrmContact(db, intg, contact);
        if (outcome === 'skipped_no_email') result.skipped += 1;
        else result.synced += 1; // enrolled | synced | org_mismatch all upserted a lead
        if (outcome === 'enrolled') result.enrolled += 1;
      }
      await db
        .from('integrations')
        .update({ last_synced_at: new Date().toISOString(), sync_cursor: page.cursor ?? null })
        .eq('id', intg.id);
    } catch (err) {
      result.failed += 1;
      // Record the failure at the integration level — NEVER echo the token (only a message string).
      await db
        .from('integrations')
        .update({ status: 'error', error: err instanceof Error ? err.message : 'crm_sync_error' })
        .eq('id', intg.id);
      console.error('[crm-sync-monitor] integration failed', { integrationId: intg.id });
    }
  }
  return result;
}

/**
 * Sync ONE contact (service-role). PERSON-only: an email-less contact (company/account) is display-only
 * and skipped — never upserted/enrolled (it would dead-end at no_email). Upserts the person lead
 * (source='crm', idempotent on org,provider,external_id), then — into the linked campaign — enrolls it
 * DRY-RUN-safe with a cross-tenant guard (the service-role path bypasses RLS) + the 4.1a active gate.
 */
async function processCrmContact(
  db: SupabaseClient,
  integration: CrmIntegrationRow,
  contact: CrmContact,
): Promise<ContactOutcome> {
  if (!contact.email?.trim()) return 'skipped_no_email';
  const org = integration.organization_id;

  const lead = await db
    .from('people')
    .upsert(mapContactToPersonRow(org, integration.provider, contact), {
      onConflict: 'organization_id,provider,external_id',
    })
    .select('id')
    .single();
  if (lead.error) throw lead.error;
  const leadId = lead.data.id as string;

  const campaignId = integration.campaign_id as string;
  const camp = await db
    .from('campaigns')
    .select('id, organization_id, status')
    .eq('id', campaignId)
    .maybeSingle();
  if (camp.error) throw camp.error;
  // Cross-tenant guard: the linked campaign must belong to the integration's org (service-role bypasses RLS).
  if (!camp.data || camp.data.organization_id !== org) return 'org_mismatch';
  // 4.1a — enroll only into an active campaign; a paused one leaves the lead synced (not enrolled).
  if (camp.data.status !== 'active') return 'synced';

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

  // Best-effort: kick the executor to prepare the new pending enrollment, DRY-RUN behind the two-flag
  // invariant. Idempotent dedupeKey.
  try {
    await inngest.send({
      name: events.campaignExecute.name,
      data: {
        organizationId: org,
        campaignId,
        dedupeKey: `campaign:${campaignId}:crm:${integration.provider}:${contact.externalId}`,
      },
    });
  } catch {
    // non-fatal; the next executor run / sync still prepares the pending enrollment
  }
  return 'enrolled';
}
