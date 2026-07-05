import type { SupabaseClient } from '@supabase/supabase-js';
import type { SmartleadClient } from '../../integrations/smartlead/types.js';
import type { GenerateDeps } from '../draft/generate.js';
import { runDraftGeneration } from '../draft/task.js';
import { runAutoApproval } from './auto-approve.js';
import {
  type EnrollmentRecord,
  isCampaignActive,
  isSuppressed,
  type SendOutcome,
} from './pipeline.js';

// Phase 3 Slice 3.2 — the durable multi-step follow-up sequencer's testable core. The Inngest
// wrapper (campaign-followup.ts) only provides the durable delay (step.sleepUntil) around these
// plain functions, so the logic is exercised directly in tests with no real sleep. Every send
// still rides 3.1's runAutoApproval → executeSend (dry-run behind the two-flag invariant).

const DAY_MS = 24 * 60 * 60 * 1000;

export interface FollowupSchedule {
  organizationId: string;
  enrollmentId: string;
  nextStep: number;
  dueTs: number;
}

/**
 * Is a follow-up step due for this enrollment? Pure read — returns the next step + when it's due
 * (now + that step's delay_days), or null if there is no further step. Scheduled OPTIMISTICALLY
 * (no status gate here): the "still sendable" decision is re-made at fire time by runFollowupStep's
 * advance CAS, so a step that never delivered (live 'queued' that never became 'sent') simply halts.
 */
export async function nextFollowupDue(
  db: SupabaseClient,
  enrollmentId: string,
): Promise<FollowupSchedule | null> {
  const enr = await db
    .from('enrollments')
    .select('organization_id, campaign_id, current_step')
    .eq('id', enrollmentId)
    .maybeSingle();
  if (enr.error) throw enr.error;
  if (!enr.data) return null;
  const nextStep = (enr.data.current_step as number) + 1;
  const step = await db
    .from('campaign_steps')
    .select('delay_days')
    .eq('campaign_id', enr.data.campaign_id)
    .eq('step_number', nextStep)
    .maybeSingle();
  if (step.error) throw step.error;
  if (!step.data) return null;
  return {
    organizationId: enr.data.organization_id as string,
    enrollmentId,
    nextStep,
    dueTs: Date.now() + Number(step.data.delay_days ?? 0) * DAY_MS,
  };
}

export interface FollowupResult {
  // 'deferred' = the prior step hasn't been DELIVERED yet (live enrollment still 'queued' awaiting
  // the EMAIL_SENT webhook) — reschedule with backoff rather than halting the whole chain.
  status: 'advanced' | 'halted' | 'completed' | 'escalated' | 'deferred';
  step?: number;
  reason?: string;
  sendOutcome?: SendOutcome | 'error';
}

/**
 * Run one follow-up step. Campaign-pause gate → suppression re-check → ADVANCE CAS (the airtight
 * halt-on-reply: only a still-'sent' enrollment at the prior step advances) → generate the step's
 * grounded draft → runAutoApproval (auto-sends when autonomy is ON, else ESCALATES the draft to the
 * human Tasks queue — sequences work in human-approval mode too). Returns null only if the
 * enrollment vanished.
 *
 * `targetStep` (from the scheduling event) is authoritative when provided — it makes the step
 * RESUMABLE: a retry after a crash between the advance CAS and the draft write is detected (already
 * at targetStep, awaiting_approval, no task) and resumes drafting instead of failing the CAS.
 */
export async function runFollowupStep(
  db: SupabaseClient,
  enrollmentId: string,
  client?: SmartleadClient,
  deps: GenerateDeps = {},
  targetStep?: number,
): Promise<FollowupResult | null> {
  const enrRes = await db.from('enrollments').select('*').eq('id', enrollmentId).maybeSingle();
  if (enrRes.error) throw enrRes.error;
  const enrollment = enrRes.data as EnrollmentRecord | null;
  if (!enrollment) return null;
  const org = enrollment.organization_id;
  const currentStep = enrollment.current_step;
  // The step we're trying to send. Event-authoritative (resumable); falls back to current+1 for
  // direct callers/tests. prevStep is the step that must already be 'sent' to advance.
  const target = targetStep ?? currentStep + 1;
  const prevStep = target - 1;

  // NOTE: autonomy is NO LONGER a halt here. Autonomy off is the human-approval posture, in which a
  // follow-up must still be drafted and ESCALATED to the Tasks queue (runAutoApproval returns null →
  // 'escalated' below). The true stop is a paused campaign (anomaly auto-pause pauses the campaign).

  // 1. Campaign pause (4.1a) — a paused campaign halts in-flight follow-ups before any draft/send.
  if (!(await isCampaignActive(db, enrollment.campaign_id))) {
    return { status: 'halted', reason: 'campaign_paused' };
  }

  // 2. Suppression re-check on the frozen verified address (saves LLM spend; executeSend re-checks too).
  if (enrollment.verified_email && (await isSuppressed(db, org, enrollment.verified_email))) {
    await db.from('enrollments').update({ status: 'unsubscribed' }).eq('id', enrollment.id);
    return { status: 'halted', reason: 'suppressed' };
  }

  // 3. Is there a step to send?
  const step = await db
    .from('campaign_steps')
    .select('step_number')
    .eq('campaign_id', enrollment.campaign_id)
    .eq('step_number', target)
    .maybeSingle();
  if (step.error) throw step.error;
  if (!step.data) {
    // End of sequence — mark completed (only if still sendable at the prior step).
    await db
      .from('enrollments')
      .update({ status: 'completed' })
      .eq('id', enrollment.id)
      .eq('status', 'sent')
      .eq('current_step', prevStep);
    return { status: 'completed' };
  }

  // RESUME: a prior attempt already advanced to `target` but crashed before writing the task
  // (status awaiting_approval, current_step === target, task_id null). Skip the CAS and re-draft.
  const isResume =
    enrollment.current_step === target &&
    enrollment.status === 'awaiting_approval' &&
    !enrollment.task_id;

  if (!isResume) {
    // 4. ADVANCE CAS — THE halt guard. Only a still-'sent' enrollment at prevStep advances to target.
    const cas = await db
      .from('enrollments')
      .update({ current_step: target, status: 'awaiting_approval', task_id: null })
      .eq('id', enrollment.id)
      .eq('status', 'sent')
      .eq('current_step', prevStep)
      .select('id');
    if (cas.error) throw cas.error;
    if ((cas.data ?? []).length === 0) {
      // The CAS missed. WHY? A reply/bounce/unsub set a TERMINAL status → halt (correct). But a live
      // enrollment still 'queued' means the prior step hasn't been DELIVERED yet (EMAIL_SENT webhook
      // not in) — the timer just fired early. DEFER (reschedule) rather than kill the chain.
      const fresh = await db
        .from('enrollments')
        .select('status, current_step')
        .eq('id', enrollment.id)
        .maybeSingle();
      if (fresh.error) throw fresh.error;
      if (fresh.data?.status === 'queued' && (fresh.data?.current_step as number) === prevStep) {
        return { status: 'deferred', step: target, reason: 'awaiting_delivery' };
      }
      return { status: 'halted', reason: 'not_sendable' };
    }
  }

  // 5. Generate the step's grounded draft (same pipeline; reuses the step-1 verified_email/verification
  // — same address). stepNumber namespaces the draft so it's a distinct, follow-up-coached task.
  const { task } = await runDraftGeneration(
    {
      db,
      organizationId: org,
      leadType: enrollment.lead_type,
      leadId: enrollment.lead_id,
      campaignId: enrollment.campaign_id,
      stepNumber: target,
      variantId: enrollment.variant_id ?? null, // same cohort as step 1
    },
    deps,
  );
  const taskId = task?.id as string | undefined;
  await db
    .from('enrollments')
    .update({ task_id: taskId ?? null })
    .eq('id', enrollment.id);

  // 6. Decide + send via 3.1's audited chokepoint path (dry-run unless both flags flipped). Autonomy
  // on → auto_send; autonomy off → runAutoApproval returns null → the draft stays a pending human
  // task ('escalated'), and the NEXT follow-up is scheduled when the human approves it.
  const auto = await runAutoApproval(db, enrollment.id, client);
  if (auto?.decision === 'auto_send') {
    return { status: 'advanced', step: target, sendOutcome: auto.sendOutcome };
  }
  return { status: 'escalated', step: target, reason: auto?.reason };
}
