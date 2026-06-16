import { nextFollowupDue, runFollowupStep } from '../../../agents/sending/followup.js';
import { getSupabaseAdmin } from '../../../db/client.js';
import { events, inngest } from '../client.js';

// Phase 3 Slice 3.2 — the durable follow-up timer. Its ONLY job is the delay (step.sleepUntil);
// all logic (kill switch → suppression re-check → halt-on-reply CAS → draft → auto-approval) lives
// in runFollowupStep, which tests call directly with no real sleep. Idempotent on dedupeKey so a
// duplicate schedule can't double-fire (the advance CAS + send dedupe key are the real guards).
export const campaignFollowup = inngest.createFunction(
  {
    id: 'campaign-followup',
    idempotency: 'event.data.dedupeKey',
    triggers: [{ event: events.campaignFollowup }],
  },
  async ({ event, step }) => {
    // Durable wait until the step is due (survives restarts).
    await step.sleepUntil('await-delay', new Date(event.data.dueTs));

    const result = await step.run('followup-step', async () => {
      const db = getSupabaseAdmin();
      if (!db) throw new Error('Supabase admin client not configured');
      return runFollowupStep(db, event.data.enrollmentId);
    });

    // Chain the NEXT follow-up only if this step actually advanced (sent).
    if (result?.status === 'advanced') {
      const next = await step.run('compute-next', async () => {
        const db = getSupabaseAdmin();
        if (!db) throw new Error('Supabase admin client not configured');
        const d = await nextFollowupDue(db, event.data.enrollmentId);
        if (d) {
          await db
            .from('enrollments')
            .update({ scheduled_at: new Date(d.dueTs).toISOString() })
            .eq('id', event.data.enrollmentId);
        }
        return d;
      });
      if (next) {
        await step.sendEvent('schedule-next', {
          name: events.campaignFollowup.name,
          data: { ...next, dedupeKey: `followup:${next.enrollmentId}:${next.nextStep}` },
        });
      }
    }
    return result ?? { status: 'halted' };
  },
);
