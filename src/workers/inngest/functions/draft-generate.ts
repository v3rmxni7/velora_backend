import { generateDraft } from '../../../agents/draft/generate.js';
import { getSupabaseAdmin } from '../../../db/client.js';
import { events, inngest } from '../client.js';

// Idempotent draft generation: Researcher → confidence gate → Writer (verified) | template.
// service-role write; org scoped by the event payload. Re-runs are a no-op via dedupe_key.
export const draftGenerate = inngest.createFunction(
  {
    id: 'draft-generate',
    idempotency: 'event.data.dedupeKey',
    triggers: [{ event: events.draftGenerate }],
  },
  async ({ event, step }) =>
    step.run('generate', async () => {
      const db = getSupabaseAdmin();
      if (!db) throw new Error('Supabase admin client not configured');
      const { organizationId, leadType, leadId, campaignId } = event.data;
      const payload = await generateDraft({
        db,
        organizationId,
        leadType,
        leadId,
        campaignId: campaignId ?? null,
      });
      const dedupeKey = `draft:${organizationId}:${leadType}:${leadId}:${campaignId ?? 'none'}`;
      const up = await db
        .from('tasks')
        .upsert(
          {
            organization_id: organizationId,
            type: 'outbound_approval',
            status: 'pending',
            lead_type: leadType,
            lead_id: leadId,
            campaign_id: campaignId ?? null,
            subject: payload.subject,
            body: payload.body,
            draft_mode: payload.draftMode,
            confidence: payload.confidence,
            grounding: payload.grounding,
            reason: payload.reason ?? null,
            dedupe_key: dedupeKey,
          },
          { onConflict: 'organization_id,dedupe_key', ignoreDuplicates: true },
        )
        .select('id');
      if (up.error) throw up.error;
      return { ok: true, draftMode: payload.draftMode };
    }),
);
