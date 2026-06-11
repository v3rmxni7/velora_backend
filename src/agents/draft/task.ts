import type { SupabaseClient } from '@supabase/supabase-js';
import { type DraftPayload, type GenerateDeps, generateDraft, type LeadType } from './generate.js';

// Shared draft-generation core: run the (unchanged) anti-hallucination pipeline, then upsert the
// outbound-approval task. Called by BOTH the async Inngest job (service-role db) and the
// synchronous /tasks/generate-sync route (user-scoped db) so the pipeline is single-sourced.
export interface RunDraftInput {
  db: SupabaseClient; // service-role (job) OR user-scoped/RLS (sync route)
  organizationId: string;
  leadType: LeadType;
  leadId: string;
  campaignId?: string | null;
}

export async function runDraftGeneration(
  input: RunDraftInput,
  deps: GenerateDeps = {},
): Promise<{ task: Record<string, unknown> | null; payload: DraftPayload }> {
  const { db, organizationId, leadType, leadId } = input;
  const campaignId = input.campaignId ?? null;

  const payload = await generateDraft({ db, organizationId, leadType, leadId, campaignId }, deps);

  const dedupeKey = `draft:${organizationId}:${leadType}:${leadId}:${campaignId ?? 'none'}`;
  const row = {
    organization_id: organizationId,
    type: 'outbound_approval',
    status: 'pending',
    lead_type: leadType,
    lead_id: leadId,
    campaign_id: campaignId,
    subject: payload.subject,
    body: payload.body,
    draft_mode: payload.draftMode,
    confidence: payload.confidence,
    grounding: payload.grounding,
    reason: payload.reason ?? null,
    dedupe_key: dedupeKey,
  };

  const up = await db
    .from('tasks')
    .upsert(row, { onConflict: 'organization_id,dedupe_key', ignoreDuplicates: true })
    .select('*');
  if (up.error) throw up.error;

  let task = (up.data ?? [])[0] ?? null;
  if (!task) {
    // ignoreDuplicates returns no row when the task already existed — re-select so callers
    // (the sync route) always get the task back.
    const existing = await db
      .from('tasks')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('dedupe_key', dedupeKey)
      .maybeSingle();
    if (existing.error) throw existing.error;
    task = existing.data;
  }

  return { task, payload };
}
