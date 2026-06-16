import type { SupabaseClient } from '@supabase/supabase-js';
import type { SmartleadClient } from '../../integrations/smartlead/types.js';
import {
  type AutoApprovalDraft,
  decideAutoApproval,
  getAutonomyMode,
  recordAutonomyEvent,
} from '../../lib/autonomy-mode.js';
import { type EnrollmentRecord, executeSend, type SendOutcome } from './pipeline.js';

// Phase 3 Slice 3.1 — cold-send auto-approval. Runs right after prepareEnrollment leaves an
// enrollment 'awaiting_approval'. Gated on autonomy_enabled; the actual send rides the EXISTING
// hardened executeSend (no gate bypassed) and auto-DRY-RUNS until the two sending flags are flipped.
// Nothing autonomous is sent without an audit row (recordAutonomyEvent is a precondition of the send).

export interface AutoApprovalResult {
  decision: 'auto_send' | 'escalate';
  reason: string;
  sendOutcome?: SendOutcome | 'error';
}

/**
 * Decide and (if approved) execute the send for a freshly-prepared enrollment.
 * Returns null when there is nothing to do (autonomy off, enrollment/task missing, or the task is
 * no longer pending — idempotent). The enrollment id is re-fetched fresh because the executor's
 * loop variable predates prepareEnrollment (no task_id/verified_email/verification yet).
 */
export async function runAutoApproval(
  db: SupabaseClient,
  enrollmentId: string,
  client?: SmartleadClient,
): Promise<AutoApprovalResult | null> {
  const enrRes = await db.from('enrollments').select('*').eq('id', enrollmentId).maybeSingle();
  if (enrRes.error) throw enrRes.error;
  const enrollment = enrRes.data as EnrollmentRecord | null;
  if (!enrollment) return null;
  const org = enrollment.organization_id;

  // Master gate: autonomy off → pure Phase-2 (task stays in the human queue), no audit, no change.
  const mode = await getAutonomyMode(db, org);
  if (!mode.autonomyEnabled) return null;

  if (!enrollment.task_id) return null;
  const taskRes = await db
    .from('tasks')
    .select('status, draft_mode, confidence, grounding')
    .eq('id', enrollment.task_id)
    .maybeSingle();
  if (taskRes.error) throw taskRes.error;
  const task = taskRes.data;
  if (!task) return null;
  if (task.status !== 'pending') return null; // idempotent: never re-decide a handled task

  const draft: AutoApprovalDraft = {
    draftMode: (task.draft_mode as AutoApprovalDraft['draftMode']) ?? 'template',
    confidence: Number(task.confidence ?? 0),
    // null grounding → ok:false → escalate (fail-safe).
    grounding: (task.grounding as AutoApprovalDraft['grounding']) ?? {
      verification: { ok: false },
    },
  };
  const decision = decideAutoApproval(draft, mode);

  // Audit BEFORE any send — a precondition. If this throws, nothing is sent and the worker retries:
  // there is never an autonomous send without a recorded decision.
  await recordAutonomyEvent(db, {
    organizationId: org,
    kind: 'cold_send',
    enrollmentId: enrollment.id,
    taskId: enrollment.task_id,
    decision: decision.action,
    reason: decision.reason,
    confidence: draft.confidence,
  });

  if (decision.action !== 'auto_send') {
    // escalate → leave the task 'pending' + enrollment 'awaiting_approval' for the human queue.
    return { decision: 'escalate', reason: decision.reason };
  }

  // CAS-approve: only flip a still-pending task (idempotent against a concurrent human approve).
  const approve = await db
    .from('tasks')
    .update({ status: 'approved', approved_at: new Date().toISOString() })
    .eq('id', enrollment.task_id)
    .eq('status', 'pending')
    .select('id');
  if (approve.error) throw approve.error;
  if ((approve.data ?? []).length === 0) {
    return { decision: 'auto_send', reason: decision.reason }; // already handled — do not send
  }

  // The send rides the existing chokepoint. Best-effort (matches the human /approve route): the
  // approval already happened; surface the outcome. executeSend dry-runs unless BOTH sending flags
  // are flipped, so this is zero real email by construction here.
  try {
    const res = await executeSend(db, enrollment, client);
    return { decision: 'auto_send', reason: decision.reason, sendOutcome: res.outcome };
  } catch {
    return { decision: 'auto_send', reason: decision.reason, sendOutcome: 'error' };
  }
}
