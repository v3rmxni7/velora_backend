import type { SupabaseClient } from '@supabase/supabase-js';
import type { SmartleadClient } from '../../integrations/smartlead/types.js';
import { AppError } from '../../lib/errors.js';

// The Smartlead template variables our rendered draft rides in (custom_fields on each lead).
export const SUBJECT_VAR = '{{velora_subject}}';
export const BODY_VAR = '{{velora_body}}';
const DEFAULT_DAILY_CAP = 20;
// A provisioning claim older than this is considered abandoned (a crashed worker) and stealable.
// Provisioning normally completes in well under 30s, so 2 min is a safe floor.
const PROVISION_STALE_MS = 120_000;

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
/** A provisioning sentinel (an in-flight/abandoned claim) is NOT a real Smartlead id. */
const isSentinel = (v?: string | null): boolean => !!v && v.startsWith('provisioning:');

export async function ensureSmartleadCampaign(
  db: SupabaseClient,
  campaign: CampaignRef,
  client: SmartleadClient,
): Promise<string> {
  // Only a REAL id short-circuits. A leftover 'provisioning:' sentinel (from a worker that crashed
  // between claiming and writing the real id) must NOT be returned as a campaign id — that poisoned
  // every future send. Fall through to the claim/re-read path, which recovers it below.
  if (campaign.smartlead_campaign_id && !isSentinel(campaign.smartlead_campaign_id)) {
    return campaign.smartlead_campaign_id;
  }

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
  // The sentinel carries a timestamp so a STALE one (left by a worker that hard-crashed mid-flight)
  // can be safely stolen after PROVISION_STALE_MS, while a FRESH one still blocks concurrent workers.
  const mine = `provisioning:${campaign.id}:${Date.now()}`;
  let won = false;

  const claim = await db
    .from('campaigns')
    .update({ smartlead_campaign_id: mine })
    .eq('id', campaign.id)
    .is('smartlead_campaign_id', null)
    .select('id');
  if (claim.error) throw claim.error;
  won = (claim.data ?? []).length > 0;

  if (!won) {
    // Lost the null-claim: another worker finished (real id → use it), is mid-flight (fresh sentinel
    // → retryable), or crashed (stale sentinel → steal it via a CAS on its exact value).
    const cur = await db
      .from('campaigns')
      .select('smartlead_campaign_id')
      .eq('id', campaign.id)
      .single();
    if (cur.error) throw cur.error;
    const existing = cur.data.smartlead_campaign_id as string | null;
    if (existing && !isSentinel(existing)) return existing;
    const inProgress = new AppError('Campaign provisioning in progress', {
      code: 'provisioning_in_progress',
      statusCode: 409,
    });
    if (!existing) throw inProgress; // raced back to null → retryable
    const ts = Number(existing.split(':')[2] ?? '0');
    if (ts > 0 && Date.now() - ts < PROVISION_STALE_MS) throw inProgress; // fresh → a live worker
    const steal = await db
      .from('campaigns')
      .update({ smartlead_campaign_id: mine })
      .eq('id', campaign.id)
      .eq('smartlead_campaign_id', existing) // CAS on the exact stale value — exactly one stealer wins
      .select('id');
    if (steal.error) throw steal.error;
    if ((steal.data ?? []).length === 0) throw inProgress; // someone else stole/finished → retryable
    won = true;
  }

  // We hold the claim — create on Smartlead, then write the real id over the sentinel. If ANY
  // Smartlead call throws (a transient timeout is the common case), RELEASE the claim back to NULL
  // so a later retry re-provisions instead of the sentinel poisoning the campaign forever.
  try {
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
  } catch (err) {
    // Best-effort release (only if the sentinel is still ours). Swallow release errors so the
    // ORIGINAL provisioning error is what surfaces.
    try {
      await db
        .from('campaigns')
        .update({ smartlead_campaign_id: null })
        .eq('id', campaign.id)
        .eq('smartlead_campaign_id', mine);
    } catch {
      /* ignore — the retry's stale-steal will recover it */
    }
    throw err;
  }
}
