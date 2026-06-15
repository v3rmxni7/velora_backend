import type { SupabaseClient } from '@supabase/supabase-js';
import { createMillionVerifier } from '../../integrations/verifier/millionverifier.js';
import type { EmailVerifier } from '../../integrations/verifier/types.js';
import { AppError } from '../../lib/errors.js';
import { getSendingMode } from '../../lib/sending-mode.js';
import type { GenerateDeps, LeadType } from '../draft/generate.js';
import { runDraftGeneration } from '../draft/task.js';

// The gated send pipeline (Phase 2 Slice 2.3), DRY-RUN. Two phases:
//   prepareEnrollment — gates (suppression → credit) → grounded draft → approval task.
//   executeSend       — the chokepoint (triggered by approval): dry-run writes a message,
//                       NEVER pushes to a provider. The live branch is Slice 2.5.
// Works under either client: service-role (campaignExecutor) or user-scoped/RLS (approve route).

export const SEND_COST = 1; // credits per send (placeholder; real pricing tuned later)

const LEAD_TABLE: Record<LeadType, string> = {
  person: 'people',
  company: 'companies',
  local_business: 'local_businesses',
};

export interface CreditAssessment {
  balance: number;
  cost: number;
  sufficient: boolean;
}
/** Pure: does the org have enough credit for one send? (Enforced live in 2.5; recorded in dry-run.) */
export function assessCredits(balance: number, cost: number): CreditAssessment {
  return { balance, cost, sufficient: balance >= cost };
}

export interface EnrollmentRecord {
  id: string;
  organization_id: string;
  campaign_id: string;
  lead_type: LeadType;
  lead_id: string;
  status: string;
  current_step: number;
  task_id?: string | null;
  verification?: string | null;
}

async function leadEmail(
  db: SupabaseClient,
  leadType: LeadType,
  leadId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from(LEAD_TABLE[leadType])
    .select('*')
    .eq('id', leadId)
    .maybeSingle();
  if (error) throw error;
  // Only people carry an email column today; others have none (→ no_email until enrichment).
  return leadType === 'person' ? ((data?.email as string | null) ?? null) : null;
}

async function isSuppressed(
  db: SupabaseClient,
  organizationId: string,
  email: string,
): Promise<boolean> {
  const { data, error } = await db
    .from('suppression_list')
    .select('organization_id')
    .eq('email', email);
  if (error) throw error;
  // org-specific OR global (organization_id IS NULL). (RLS already scopes a user client to
  // own+global; the explicit check also covers the service-role client.)
  return (data ?? []).some(
    (r) => r.organization_id === organizationId || r.organization_id === null,
  );
}

async function creditBalance(db: SupabaseClient, organizationId: string): Promise<number> {
  const { data, error } = await db
    .from('credit_ledger')
    .select('delta')
    .eq('organization_id', organizationId);
  if (error) throw error;
  return (data ?? []).reduce((sum, r) => sum + Number(r.delta), 0);
}

export type PrepareOutcome = 'prepared' | 'suppressed' | 'undeliverable' | 'no_email' | 'skipped';

/** Phase 1: gate a pending enrollment, then generate the grounded draft + approval task. */
export async function prepareEnrollment(
  db: SupabaseClient,
  enrollment: EnrollmentRecord,
  deps: GenerateDeps = {},
  verifier: EmailVerifier | null = createMillionVerifier(),
): Promise<{ outcome: PrepareOutcome; taskId?: string }> {
  if (enrollment.status !== 'pending') return { outcome: 'skipped' };
  const org = enrollment.organization_id;

  const email = await leadEmail(db, enrollment.lead_type, enrollment.lead_id);
  if (!email) {
    await db
      .from('enrollments')
      .update({ status: 'failed', error: 'no_email' })
      .eq('id', enrollment.id);
    return { outcome: 'no_email' };
  }

  // Suppression gate — before any LLM spend.
  if (await isSuppressed(db, org, email)) {
    await db.from('enrollments').update({ status: 'unsubscribed' }).eq('id', enrollment.id);
    return { outcome: 'suppressed' };
  }

  // Verification gate — cheap API call before the expensive LLM draft. Undeliverable
  // (invalid/disposable) never gets a draft or a send; risky/deliverable proceed (verdict kept
  // for the send's audit). Skipped when no verifier is configured (sandbox/dev).
  let verification: 'deliverable' | 'risky' | 'skipped' = 'skipped';
  if (verifier) {
    const v = await verifier.verify(email);
    if (v.verdict === 'undeliverable') {
      await db
        .from('enrollments')
        .update({ status: 'failed', error: `email_${v.result}` })
        .eq('id', enrollment.id);
      return { outcome: 'undeliverable' };
    }
    verification = v.verdict; // 'deliverable' | 'risky'
  }

  // Credit assessment is recorded at send time (executeSend); non-blocking in dry-run.

  const { task } = await runDraftGeneration(
    {
      db,
      organizationId: org,
      leadType: enrollment.lead_type,
      leadId: enrollment.lead_id,
      campaignId: enrollment.campaign_id,
    },
    deps,
  );
  const taskId = task?.id as string | undefined;

  await db
    .from('enrollments')
    .update({
      status: 'awaiting_approval',
      task_id: taskId ?? null,
      verified_email: email,
      verification,
    })
    .eq('id', enrollment.id);
  return { outcome: 'prepared', taskId };
}

export type SendOutcome = 'dry_run' | 'not_approved' | 'suppressed' | 'skipped';

/** Phase 2: the chokepoint. Triggered by task approval. DRY-RUN only writes a message row. */
export async function executeSend(
  db: SupabaseClient,
  enrollment: EnrollmentRecord,
): Promise<{ outcome: SendOutcome; messageId?: string }> {
  if (!enrollment.task_id) return { outcome: 'skipped' };
  const org = enrollment.organization_id;

  const task = await db
    .from('tasks')
    .select('status, subject, body, grounding')
    .eq('id', enrollment.task_id)
    .maybeSingle();
  if (task.error) throw task.error;
  if (task.data?.status !== 'approved') return { outcome: 'not_approved' };

  const email = await leadEmail(db, enrollment.lead_type, enrollment.lead_id);
  // Re-check suppression at the last moment (defense — it may have changed since prepare).
  if (email && (await isSuppressed(db, org, email))) {
    await db.from('enrollments').update({ status: 'unsubscribed' }).eq('id', enrollment.id);
    return { outcome: 'suppressed' };
  }

  const mode = await getSendingMode(db, org);
  if (mode.sendingEnabled && !mode.dryRun) {
    // LIVE push + credit debit lands in Slice 2.5. Unreachable under the safe defaults.
    throw new AppError('Live sending is not implemented yet (Slice 2.5)', {
      code: 'not_implemented',
      statusCode: 501,
    });
  }

  // ---- DRY-RUN: write the message; never touch a provider, never debit credits. ----
  const gates = {
    suppressed: false,
    verification: enrollment.verification ?? 'unknown', // the actual verdict, not a boolean
    credit: assessCredits(await creditBalance(db, org), SEND_COST),
    mode: 'dry_run' as const,
  };

  const thread = await db
    .from('threads')
    .upsert(
      {
        organization_id: org,
        campaign_id: enrollment.campaign_id,
        lead_type: enrollment.lead_type,
        lead_id: enrollment.lead_id,
        subject: task.data.subject,
        status: 'active',
        last_message_at: new Date().toISOString(),
      },
      { onConflict: 'organization_id,campaign_id,lead_type,lead_id' },
    )
    .select('id')
    .single();
  if (thread.error) throw thread.error;
  const threadId = thread.data.id as string;

  const dedupeKey = `send:${org}:${enrollment.id}:${enrollment.current_step}`;
  const ins = await db
    .from('messages')
    .upsert(
      {
        organization_id: org,
        thread_id: threadId,
        enrollment_id: enrollment.id,
        direction: 'outbound',
        channel: 'email',
        subject: task.data.subject,
        body: task.data.body,
        status: 'dry_run',
        grounding: task.data.grounding,
        gates,
        dedupe_key: dedupeKey,
        sent_at: new Date().toISOString(),
      },
      { onConflict: 'organization_id,dedupe_key', ignoreDuplicates: true },
    )
    .select('id');
  if (ins.error) throw ins.error;
  let messageId = (ins.data ?? [])[0]?.id as string | undefined;
  if (!messageId) {
    const ex = await db
      .from('messages')
      .select('id')
      .eq('organization_id', org)
      .eq('dedupe_key', dedupeKey)
      .maybeSingle();
    messageId = ex.data?.id as string | undefined;
  }

  await db
    .from('enrollments')
    .update({ status: 'sent', thread_id: threadId })
    .eq('id', enrollment.id);
  return { outcome: 'dry_run', messageId };
}
