import type { LeadType } from '../../../agents/draft/generate.js';
import { runAutoApproval } from '../../../agents/sending/auto-approve.js';
import { nextFollowupDue } from '../../../agents/sending/followup.js';
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
  async ({ event, step }) => {
    const prep = await step.run('prepare-enrollments', async () => {
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
      const autoSentIds: string[] = [];
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
          if (auto?.decision === 'auto_send') autoSentIds.push(enrollment.id as string);
        } catch (err) {
          console.error('[campaign-executor] enrollment failed', {
            enrollmentId: enrollment.id,
            err,
          });
        }
      }
      return {
        organizationId,
        campaignId,
        prepared,
        autoSentIds,
        total: (data ?? []).length,
      };
    });

    // Schedule the FIRST follow-up for each enrollment that auto-sent step 1 and has a next step.
    // Durable: the consumer (campaign-followup) sleeps until dueTs, then re-checks + sends.
    const due = await step.run('compute-followups', async () => {
      const db = getSupabaseAdmin();
      if (!db) throw new Error('Supabase admin client not configured');
      const out: {
        organizationId: string;
        enrollmentId: string;
        nextStep: number;
        dueTs: number;
      }[] = [];
      for (const id of prep.autoSentIds) {
        const d = await nextFollowupDue(db, id);
        if (!d) continue;
        out.push(d);
        await db
          .from('enrollments')
          .update({ scheduled_at: new Date(d.dueTs).toISOString() })
          .eq('id', id);
      }
      return out;
    });
    if (due.length > 0) {
      await step.sendEvent(
        'schedule-followups',
        due.map((d) => ({
          name: events.campaignFollowup.name,
          data: { ...d, dedupeKey: `followup:${d.enrollmentId}:${d.nextStep}` },
        })),
      );
    }

    return {
      ok: true,
      organizationId: prep.organizationId,
      campaignId: prep.campaignId,
      prepared: prep.prepared,
      autoSent: prep.autoSentIds.length,
      total: prep.total,
    };
  },
);
