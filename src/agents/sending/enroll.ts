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

// All 5 types are valid product types (4.3); the AUDIENCE RESOLUTION is the real gate — only
// cold_outbound has a connected source today, the rest honestly report "source not connected".
const SUPPORTED: ReadonlySet<string> = new Set(ALL_CAMPAIGN_TYPES);

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
  campaign_type?: string | null;
}
export interface EnrollmentRow {
  organization_id: string;
  campaign_id: string;
  lead_type: string;
  lead_id: string;
  status: 'pending';
  current_step: number;
}

/** Where a campaign type sources its audience. Only 'list' (cold) is connected today. */
export type AudienceSource = 'list' | 'crm' | 'website_visitors' | 'signals';
export interface AudienceResult {
  connected: boolean;
  source: AudienceSource;
  members: ListMember[];
}
const NON_COLD_SOURCE: Record<string, AudienceSource> = {
  warm_outbound: 'crm',
  cross_sell: 'crm',
  website_visitor: 'website_visitors',
  intent_signals: 'signals',
};

/**
 * Resolve a campaign's audience by type. cold_outbound reads its list (real, today). Every other
 * type's source (CRM / website-visitor feed / intent signal) is not connected yet (4.5–4.7), so it
 * returns connected:false with NO members — launch then enrolls nothing and stays draft. NEVER
 * fabricates an audience.
 */
export async function resolveAudience(
  db: SupabaseClient,
  campaign: CampaignRef,
): Promise<AudienceResult> {
  if ((campaign.campaign_type ?? 'cold_outbound') === 'cold_outbound') {
    if (!campaign.list_id) return { connected: true, source: 'list', members: [] };
    const members = await db
      .from('list_members')
      .select('entity_type, entity_id')
      .eq('list_id', campaign.list_id);
    if (members.error) throw members.error;
    return { connected: true, source: 'list', members: (members.data ?? []) as ListMember[] };
  }
  return {
    connected: false,
    source: NON_COLD_SOURCE[campaign.campaign_type ?? ''] ?? 'crm',
    members: [],
  };
}

export interface LaunchResult {
  enrolled: number;
  sourceConnected: boolean;
  source: AudienceSource;
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
 * Launch a campaign: resolve its audience by type, enroll the members (idempotent upsert), flip
 * status to active. Shared by the route and integration tests. The caller must have already loaded
 * the campaign under RLS (so cross-org launch is blocked before this runs).
 * A non-cold type whose source isn't connected enrolls NOTHING and stays draft (sourceConnected
 * false) — never a fabricated audience.
 */
export async function launchCampaign(
  db: SupabaseClient,
  campaign: CampaignRef,
): Promise<LaunchResult> {
  const audience = await resolveAudience(db, campaign);
  if (!audience.connected) {
    return { enrolled: 0, sourceConnected: false, source: audience.source };
  }
  const rows = mapMembersToEnrollments(audience.members, campaign);
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
  return { enrolled, sourceConnected: true, source: audience.source };
}
