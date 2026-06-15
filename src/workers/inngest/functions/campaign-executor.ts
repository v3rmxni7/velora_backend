import type { LeadType } from '../../../agents/draft/generate.js';
import { type EnrollmentRecord, prepareEnrollment } from '../../../agents/sending/pipeline.js';
import { getSupabaseAdmin } from '../../../db/client.js';
import { events, inngest } from '../client.js';

// Prepare a campaign's pending enrollments: gates → grounded draft → approval task.
// Idempotent (only 'pending' enrollments are prepared; the draft upsert dedupes). No sends —
// the dry-run send happens on human approval (executeSend, via the tasks route).
export const campaignExecutor = inngest.createFunction(
  {
    id: 'campaign-executor',
    idempotency: 'event.data.dedupeKey',
    triggers: [{ event: events.campaignExecute }],
  },
  async ({ event, step }) =>
    step.run('prepare-enrollments', async () => {
      const db = getSupabaseAdmin();
      if (!db) throw new Error('Supabase admin client not configured');
      const { organizationId, campaignId } = event.data;
      const { data, error } = await db
        .from('enrollments')
        .select(
          'id, organization_id, campaign_id, lead_type, lead_id, status, current_step, task_id',
        )
        .eq('campaign_id', campaignId)
        .eq('status', 'pending');
      if (error) throw error;
      let prepared = 0;
      for (const enrollment of data ?? []) {
        const res = await prepareEnrollment(
          db,
          enrollment as EnrollmentRecord & { lead_type: LeadType },
        );
        if (res.outcome === 'prepared') prepared += 1;
      }
      return { ok: true, organizationId, campaignId, prepared, total: (data ?? []).length };
    }),
);
