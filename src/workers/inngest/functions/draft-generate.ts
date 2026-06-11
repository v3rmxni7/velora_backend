import { runDraftGeneration } from '../../../agents/draft/task.js';
import { getSupabaseAdmin } from '../../../db/client.js';
import { events, inngest } from '../client.js';

// Idempotent draft generation: Researcher → confidence gate → Writer (verified) | template.
// service-role write; org scoped by the event payload. Re-runs are a no-op via dedupe_key.
// Delegates to the shared runDraftGeneration() so the sync route runs the identical pipeline.
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
      const { payload } = await runDraftGeneration({
        db,
        organizationId,
        leadType,
        leadId,
        campaignId: campaignId ?? null,
      });
      return { ok: true, draftMode: payload.draftMode };
    }),
);
