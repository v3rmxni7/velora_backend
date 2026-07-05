import { nextFollowupDue, runFollowupStep } from '../../../agents/sending/followup.js';
import { getSupabaseAdmin } from '../../../db/client.js';
import { events, inngest } from '../client.js';

// A follow-up step whose prior step hasn't delivered yet reschedules with this backoff, up to this
// many times (~2h × 12 ≈ a day) before giving up — a cheap re-check while delivery is pending.
const FOLLOWUP_RETRY_BACKOFF_MS = 2 * 60 * 60 * 1000;
const FOLLOWUP_MAX_RETRIES = 12;

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
      // targetStep = the event's nextStep — authoritative + resumable across retries.
      return runFollowupStep(db, event.data.enrollmentId, undefined, {}, event.data.nextStep);
    });

    // DEFERRED — the prior step hasn't been delivered yet (live enrollment still 'queued'). Reschedule
    // the SAME step with a backoff (distinct dedupeKey so idempotency doesn't swallow the re-fire),
    // bounded by FOLLOWUP_MAX_RETRIES so a step that never delivers eventually stops instead of looping.
    if (result?.status === 'deferred') {
      const retry = (event.data.retry ?? 0) + 1;
      if (retry <= FOLLOWUP_MAX_RETRIES) {
        await step.sendEvent('reschedule-deferred', {
          name: events.campaignFollowup.name,
          data: {
            organizationId: event.data.organizationId,
            enrollmentId: event.data.enrollmentId,
            nextStep: event.data.nextStep,
            dueTs: event.data.dueTs + FOLLOWUP_RETRY_BACKOFF_MS,
            retry,
            dedupeKey: `followup:${event.data.enrollmentId}:${event.data.nextStep}:r${retry}`,
          },
        });
      }
      return result;
    }

    // Chain the NEXT follow-up only if this step actually advanced (auto-sent). The human-approval
    // path schedules the next step from the /tasks approve route instead.
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
