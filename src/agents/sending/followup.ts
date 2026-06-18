import type { SupabaseClient } from '@supabase/supabase-js';
import type { SmartleadClient } from '../../integrations/smartlead/types.js';
import { getAutonomyMode } from '../../lib/autonomy-mode.js';
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
  status: 'advanced' | 'halted' | 'completed' | 'escalated';
  step?: number;
  reason?: string;
  sendOutcome?: SendOutcome | 'error';
}

/**
 * Run one follow-up step. Gate (kill switch) → suppression re-check → ADVANCE CAS (the airtight
 * halt-on-reply: only a still-'sent' enrollment at the expected step advances) → generate the
 * step's grounded draft → runAutoApproval (audited; dry-run unless both sending flags are flipped).
 * Returns null only if the enrollment vanished.
 */
export async function runFollowupStep(
  db: SupabaseClient,
  enrollmentId: string,
  client?: SmartleadClient,
  deps: GenerateDeps = {},
): Promise<FollowupResult | null> {
  const enrRes = await db.from('enrollments').select('*').eq('id', enrollmentId).maybeSingle();
  if (enrRes.error) throw enrRes.error;
  const enrollment = enrRes.data as EnrollmentRecord | null;
  if (!enrollment) return null;
  const org = enrollment.organization_id;
  const currentStep = enrollment.current_step;

  // 1. Kill switch — turning autonomy off halts in-flight sequences (no advance, no send).
  const mode = await getAutonomyMode(db, org);
  if (!mode.autonomyEnabled) return { status: 'halted', reason: 'autonomy_disabled' };

  // 1b. Campaign pause (4.1a) — a paused campaign halts in-flight follow-ups before any draft/send.
  if (!(await isCampaignActive(db, enrollment.campaign_id))) {
    return { status: 'halted', reason: 'campaign_paused' };
  }

  // 2. Suppression re-check on the frozen verified address (saves LLM spend; executeSend re-checks too).
  if (enrollment.verified_email && (await isSuppressed(db, org, enrollment.verified_email))) {
    await db.from('enrollments').update({ status: 'unsubscribed' }).eq('id', enrollment.id);
    return { status: 'halted', reason: 'suppressed' };
  }

  // 3. Is there a next step?
  const nextStep = currentStep + 1;
  const step = await db
    .from('campaign_steps')
    .select('step_number')
    .eq('campaign_id', enrollment.campaign_id)
    .eq('step_number', nextStep)
    .maybeSingle();
  if (step.error) throw step.error;
  if (!step.data) {
    // End of sequence — mark completed (only if still sendable; else leave the terminal status).
    await db
      .from('enrollments')
      .update({ status: 'completed' })
      .eq('id', enrollment.id)
      .eq('status', 'sent')
      .eq('current_step', currentStep);
    return { status: 'completed' };
  }

  // 4. ADVANCE CAS — THE halt guard. Only a still-'sent' enrollment at step N advances to N+1.
  // A reply/bounce/unsub set a non-'sent' terminal status → 0 rows → halt before any draft/send.
  const cas = await db
    .from('enrollments')
    .update({ current_step: nextStep, status: 'awaiting_approval', task_id: null })
    .eq('id', enrollment.id)
    .eq('status', 'sent')
    .eq('current_step', currentStep)
    .select('id');
  if (cas.error) throw cas.error;
  if ((cas.data ?? []).length === 0) return { status: 'halted', reason: 'not_sendable' };

  // 5. Generate the step's grounded draft (same pipeline; reuses the step-1 verified_email/verification
  // — same address). stepNumber namespaces the draft so it's a distinct, follow-up-coached task.
  const { task } = await runDraftGeneration(
    {
      db,
      organizationId: org,
      leadType: enrollment.lead_type,
      leadId: enrollment.lead_id,
      campaignId: enrollment.campaign_id,
      stepNumber: nextStep,
      variantId: enrollment.variant_id ?? null, // same cohort as step 1
    },
    deps,
  );
  const taskId = task?.id as string | undefined;
  await db
    .from('enrollments')
    .update({ task_id: taskId ?? null })
    .eq('id', enrollment.id);

  // 6. Decide + send via 3.1's audited chokepoint path (dry-run unless both flags flipped).
  const auto = await runAutoApproval(db, enrollment.id, client);
  if (auto?.decision === 'auto_send') {
    return { status: 'advanced', step: nextStep, sendOutcome: auto.sendOutcome };
  }
  return { status: 'escalated', step: nextStep, reason: auto?.reason };
}
