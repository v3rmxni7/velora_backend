import type { SupabaseClient } from '@supabase/supabase-js';
import { AppError } from '../../lib/errors.js';

// Campaign enrollment core (Phase 2 Slice 2.2). Launch = read a list's members → create
// 'pending' enrollment rows. No drafts, no sends — that's the 2.3 pipeline.

export const ALL_CAMPAIGN_TYPES = [
  'cold_outbound',
  'warm_outbound',
  'cross_sell',
  'website_visitor',
  'intent_signals',
] as const;
export type CampaignType = (typeof ALL_CAMPAIGN_TYPES)[number];

// Only cold outbound ships in Phase 2's pilot; the rest are later phases.
const SUPPORTED: ReadonlySet<string> = new Set(['cold_outbound']);

export function assertSupportedCampaignType(type: string): void {
  if (!SUPPORTED.has(type)) {
    throw new AppError(`Campaign type '${type}' is not supported yet`, {
      code: 'campaign_type_unsupported',
      statusCode: 422,
    });
  }
}

interface ListMember {
  entity_type: string;
  entity_id: string;
}
interface CampaignRef {
  id: string;
  organization_id: string;
  list_id?: string | null;
}
export interface EnrollmentRow {
  organization_id: string;
  campaign_id: string;
  lead_type: string;
  lead_id: string;
  status: 'pending';
  current_step: number;
}

/** Pure: list members → enrollment rows (each lead starts pending at step 1). */
export function mapMembersToEnrollments(
  members: ListMember[],
  campaign: CampaignRef,
): EnrollmentRow[] {
  return members.map((m) => ({
    organization_id: campaign.organization_id,
    campaign_id: campaign.id,
    lead_type: m.entity_type,
    lead_id: m.entity_id,
    status: 'pending',
    current_step: 1,
  }));
}

/**
 * Launch a campaign: enroll its list's members (idempotent upsert), flip status to active.
 * Shared by the route and integration tests. The caller must have already loaded the campaign
 * under RLS (so cross-org launch is blocked before this runs); list_members is RLS-scoped too.
 */
export async function launchCampaign(
  db: SupabaseClient,
  campaign: CampaignRef,
): Promise<{ enrolled: number }> {
  if (!campaign.list_id) return { enrolled: 0 };
  const members = await db
    .from('list_members')
    .select('entity_type, entity_id')
    .eq('list_id', campaign.list_id);
  if (members.error) throw members.error;

  const rows = mapMembersToEnrollments(members.data ?? [], campaign);
  let enrolled = 0;
  if (rows.length > 0) {
    const up = await db
      .from('enrollments')
      .upsert(rows, { onConflict: 'campaign_id,lead_type,lead_id', ignoreDuplicates: true })
      .select('id');
    if (up.error) throw up.error;
    enrolled = (up.data ?? []).length;
  }
  const upd = await db.from('campaigns').update({ status: 'active' }).eq('id', campaign.id);
  if (upd.error) throw upd.error;
  return { enrolled };
}
