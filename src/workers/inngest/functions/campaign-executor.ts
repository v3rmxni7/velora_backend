import type { LeadType } from '../../../agents/draft/generate.js';
import { runAutoApproval } from '../../../agents/sending/auto-approve.js';
import { type EnrollmentRecord, prepareEnrollment } from '../../../agents/sending/pipeline.js';
import { getSupabaseAdmin } from '../../../db/client.js';
import { events, inngest } from '../client.js';

// Prepare a campaign's pending enrollments: gates → grounded draft → approval task. Idempotent
// (only 'pending' enrollments are prepared; the draft upsert dedupes). Then, per enrollment, an
// autonomous approval step (Slice 3.1): gated on autonomy_enabled, it auto-approves a qualifying
// draft and drives the EXISTING executeSend chokepoint — which dry-runs unless the sending flags
// are flipped (zero real email by default). Autonomy off → no-op (human approval, as before).
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
      let autoSent = 0;
      for (const enrollment of data ?? []) {
        // Per-enrollment isolation: a single failure escalates that enrollment (it stays
        // awaiting_approval → human queue) without aborting the rest of the batch.
        try {
          const res = await prepareEnrollment(
            db,
            enrollment as EnrollmentRecord & { lead_type: LeadType },
          );
          if (res.outcome !== 'prepared') continue;
          prepared += 1;
          const auto = await runAutoApproval(db, enrollment.id);
          if (auto?.decision === 'auto_send') autoSent += 1;
        } catch (err) {
          console.error('[campaign-executor] enrollment failed', {
            enrollmentId: enrollment.id,
            err,
          });
        }
      }
      return {
        ok: true,
        organizationId,
        campaignId,
        prepared,
        autoSent,
        total: (data ?? []).length,
      };
    }),
);
