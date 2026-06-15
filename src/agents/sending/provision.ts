import type { SupabaseClient } from '@supabase/supabase-js';
import type { SmartleadClient } from '../../integrations/smartlead/types.js';
import { AppError } from '../../lib/errors.js';

// The Smartlead template variables our rendered draft rides in (custom_fields on each lead).
export const SUBJECT_VAR = '{{velora_subject}}';
export const BODY_VAR = '{{velora_body}}';
const DEFAULT_DAILY_CAP = 20;

interface CampaignRef {
  id: string;
  organization_id: string;
  name?: string | null;
  smartlead_campaign_id?: string | null;
}

/**
 * Idempotently provision the Smartlead campaign backing a Velora campaign: create it, set the
 * {{velora_subject}}/{{velora_body}} sequence, assign the org's warm mailboxes, schedule, START.
 * Returns the Smartlead campaign id (cached on campaigns.smartlead_campaign_id). Read+write
 * against Smartlead via the injected client — never sends; sending happens when leads are pushed.
 */
export async function ensureSmartleadCampaign(
  db: SupabaseClient,
  campaign: CampaignRef,
  client: SmartleadClient,
): Promise<string> {
  if (campaign.smartlead_campaign_id) return campaign.smartlead_campaign_id;

  // Only genuinely WARM mailboxes drive the send (rotation handled by Smartlead). 'connected'
  // (just-synced, no warmup) and 'warming' (mid-warmup, not yet proven) are EXCLUDED — sending real
  // cold outreach from a cold/un-proven mailbox burns sender reputation. A mailbox reaches 'warm'
  // only via refreshMailboxWarmup once its reputation clears the warmth thresholds (see mailbox-sync).
  const mb = await db
    .from('mailboxes')
    .select('smartlead_email_account_id')
    .eq('organization_id', campaign.organization_id)
    .eq('status', 'warm')
    .not('smartlead_email_account_id', 'is', null);
  if (mb.error) throw mb.error;
  const accountIds = (mb.data ?? [])
    .map((r) => r.smartlead_email_account_id as string | null)
    .filter((v): v is string => !!v);
  if (accountIds.length === 0) {
    throw new AppError('No warm mailboxes to send from', {
      code: 'no_mailboxes',
      statusCode: 409,
    });
  }

  // H5 — serialize provisioning so concurrent sends create EXACTLY ONE Smartlead campaign. The
  // atomic claim (conditional UPDATE on a NULL id, backed by the unique index on
  // smartlead_campaign_id) elects a single winner; the sentinel marks "provisioning in progress".
  const sentinel = `provisioning:${campaign.id}`;
  const claim = await db
    .from('campaigns')
    .update({ smartlead_campaign_id: sentinel })
    .eq('id', campaign.id)
    .is('smartlead_campaign_id', null)
    .select('id');
  if (claim.error) throw claim.error;
  if ((claim.data ?? []).length === 0) {
    // Lost the race: another worker is provisioning or already did. Re-read and use its id.
    const cur = await db
      .from('campaigns')
      .select('smartlead_campaign_id')
      .eq('id', campaign.id)
      .single();
    if (cur.error) throw cur.error;
    const existing = cur.data.smartlead_campaign_id as string | null;
    if (existing && !existing.startsWith('provisioning:')) return existing;
    // Still the sentinel → the winner is mid-flight. Retryable; never double-creates.
    throw new AppError('Campaign provisioning in progress', {
      code: 'provisioning_in_progress',
      statusCode: 409,
    });
  }

  // We won the claim — create on Smartlead, then write the real id over the sentinel.
  const { id } = await client.createCampaign(campaign.name ?? `velora-${campaign.id}`);
  await client.saveSequence(id, SUBJECT_VAR, BODY_VAR);
  await client.assignEmailAccounts(id, accountIds);
  await client.setSchedule(id, DEFAULT_DAILY_CAP);
  await client.setStatus(id, 'START');

  const upd = await db
    .from('campaigns')
    .update({ smartlead_campaign_id: id })
    .eq('id', campaign.id);
  if (upd.error) throw upd.error;
  return id;
}
