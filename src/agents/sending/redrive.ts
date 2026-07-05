import type { SupabaseClient } from '@supabase/supabase-js';
import { type EnrollmentRecord, executeSend, type SendOutcome } from './pipeline.js';

// Send-redrive sweep (fixes the "stranded approved sends" class). A send can DEFER without failing —
// rate_limited (daily cap), campaign_paused, sender_paused, insufficient_credit — leaving the
// enrollment 'awaiting_approval' with its task still 'approved'. Nothing re-drove those, so they
// stranded forever once the blocking condition cleared (cap reset next day, campaign/sender resumed,
// credits topped up). This periodic sweep re-runs executeSend for each such enrollment.
//
// SAFE BY CONSTRUCTION: executeSend is the single chokepoint and re-checks EVERY gate each attempt
// (campaign active? sender active? suppression? verification? credit? volume cap? two-flag mode?),
// and its dedupe-key claim makes a re-drive at-most-once — so this can never double-send or bypass a
// gate. A still-blocked enrollment simply defers again (no mutation) and is retried next sweep.

export interface RedriveResult {
  considered: number;
  redriven: number;
  outcomes: Record<string, number>;
}

type RedriveEnrollment = EnrollmentRecord & { task_id: string | null };

/**
 * Re-drive deferred-but-approved sends. `db` must be the service-role admin client (executeSend's
 * rate count + credit debit require it). `send` is injectable for tests.
 */
export async function runSendRedrive(
  db: SupabaseClient,
  opts: { limit?: number; send?: typeof executeSend } = {},
): Promise<RedriveResult> {
  const limit = opts.limit ?? 200;
  const send = opts.send ?? executeSend;

  // Deferred enrollments: still awaiting_approval, with a task, oldest first (fairness).
  const enr = await db
    .from('enrollments')
    .select(
      'id, organization_id, campaign_id, lead_type, lead_id, status, current_step, task_id, variant_id, verified_email, verification',
    )
    .eq('status', 'awaiting_approval')
    .not('task_id', 'is', null)
    .order('updated_at', { ascending: true })
    .limit(limit);
  if (enr.error) throw enr.error;
  const candidates = (enr.data ?? []) as RedriveEnrollment[];
  if (candidates.length === 0) return { considered: 0, redriven: 0, outcomes: {} };

  // Keep only those whose task is actually APPROVED (an awaiting_approval enrollment whose task is
  // still 'pending' is waiting on a human, not deferred — leave it alone).
  const taskIds = [...new Set(candidates.map((c) => c.task_id).filter((v): v is string => !!v))];
  const tasks = await db.from('tasks').select('id, status').in('id', taskIds);
  if (tasks.error) throw tasks.error;
  const approved = new Set(
    (tasks.data ?? []).filter((t) => t.status === 'approved').map((t) => t.id as string),
  );
  const toRedrive = candidates.filter((c) => c.task_id && approved.has(c.task_id));

  const outcomes: Record<string, number> = {};
  for (const e of toRedrive) {
    try {
      const res = await send(db, e);
      outcomes[res.outcome] = (outcomes[res.outcome] ?? 0) + 1;
    } catch (err) {
      // Per-enrollment isolation — one failure never aborts the sweep.
      console.error('[send-redrive] executeSend failed', { enrollmentId: e.id, err });
      outcomes.error = (outcomes.error ?? 0) + 1;
    }
  }
  return { considered: candidates.length, redriven: toRedrive.length, outcomes };
}

export type { SendOutcome };
