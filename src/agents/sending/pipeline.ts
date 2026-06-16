import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from '../../config/env.js';
import { getSupabaseAdmin } from '../../db/client.js';
import { createSmartleadClient } from '../../integrations/smartlead/smartlead.js';
import type { SmartleadClient } from '../../integrations/smartlead/types.js';
import { createMillionVerifier } from '../../integrations/verifier/millionverifier.js';
import type { EmailVerifier } from '../../integrations/verifier/types.js';
import { AppError } from '../../lib/errors.js';
import { assertLiveSendAllowed, getSendingMode } from '../../lib/sending-mode.js';
import type { GenerateDeps, LeadType } from '../draft/generate.js';
import { runDraftGeneration } from '../draft/task.js';
import { ensureSmartleadCampaign } from './provision.js';

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
  verified_email?: string | null;
}

interface ApprovedDraft {
  subject: string | null;
  body: string | null;
  grounding: unknown;
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

export async function isSuppressed(
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

export type SendOutcome =
  | 'dry_run'
  | 'queued'
  | 'not_approved'
  | 'suppressed'
  | 'insufficient_credit'
  | 'verification_required'
  | 'rate_limited'
  | 'halted'
  | 'invalid'
  | 'duplicate'
  | 'skipped';

export interface SendCaps {
  perOrg: number;
  global: number;
}
/** Pure: is a send over either daily ceiling? (Counts are "already sent today".) */
export function assessSendRate(orgCount: number, globalCount: number, caps: SendCaps): boolean {
  return orgCount >= caps.perOrg || globalCount >= caps.global;
}

/** Count today's real (non-dry-run) outbound sends — org-scoped and/or global. UTC day. */
async function countSendsToday(db: SupabaseClient, organizationId?: string): Promise<number> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  let q = db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('direction', 'outbound')
    .neq('status', 'dry_run')
    .gte('created_at', since.toISOString());
  if (organizationId) q = q.eq('organization_id', organizationId);
  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
}

/** Upsert the outbound thread + message and advance the enrollment. Shared by dry-run + live. */
async function recordOutbound(
  db: SupabaseClient,
  enrollment: EnrollmentRecord,
  draft: ApprovedDraft,
  opts: {
    messageStatus: 'dry_run' | 'queued';
    enrollmentStatus: 'sent' | 'queued';
    gates: Record<string, unknown>;
    smartleadMessageId?: string | null;
  },
): Promise<{ messageId?: string; dedupeKey: string; created: boolean }> {
  const org = enrollment.organization_id;
  const thread = await db
    .from('threads')
    .upsert(
      {
        organization_id: org,
        campaign_id: enrollment.campaign_id,
        lead_type: enrollment.lead_type,
        lead_id: enrollment.lead_id,
        subject: draft.subject,
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
        subject: draft.subject,
        body: draft.body,
        status: opts.messageStatus,
        grounding: draft.grounding,
        gates: opts.gates,
        dedupe_key: dedupeKey,
        smartlead_message_id: opts.smartleadMessageId ?? null,
        sent_at: new Date().toISOString(),
      },
      { onConflict: 'organization_id,dedupe_key', ignoreDuplicates: true },
    )
    .select('id');
  if (ins.error) throw ins.error;
  // `created` = the insert actually wrote a row (vs. hit the (org,dedupe_key) conflict). This is
  // the idempotency signal the live send relies on to claim-before-push: only the caller that
  // created the row may perform the irreversible Smartlead push.
  const created = (ins.data ?? []).length > 0;
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
    .update({ status: opts.enrollmentStatus, thread_id: threadId })
    .eq('id', enrollment.id);
  return { messageId, dedupeKey, created };
}

/**
 * Phase 2: the chokepoint. Triggered by task approval. DRY-RUN writes a 'dry_run' message and
 * never touches a provider. LIVE (only when sending_enabled && !dry_run) pushes the approved draft
 * to Smartlead and debits credits — idempotency-keyed so retries never double-send/double-charge.
 */
export async function executeSend(
  db: SupabaseClient,
  enrollment: EnrollmentRecord,
  client?: SmartleadClient,
  caps?: SendCaps,
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
  const draft: ApprovedDraft = {
    subject: task.data.subject as string | null,
    body: task.data.body as string | null,
    grounding: task.data.grounding,
  };

  // The exact address we would deliver to: the frozen verified_email, falling back to the raw
  // lead email only if it was never set. The last-moment suppression re-check runs on THIS address
  // (M3) — not the editable raw lead email, which can diverge from what Smartlead actually sends.
  const recipient =
    enrollment.verified_email ?? (await leadEmail(db, enrollment.lead_type, enrollment.lead_id));
  if (recipient && (await isSuppressed(db, org, recipient))) {
    await db.from('enrollments').update({ status: 'unsubscribed' }).eq('id', enrollment.id);
    return { outcome: 'suppressed' };
  }

  const mode = await getSendingMode(db, org);

  // ===== LIVE branch — the one irreversible path. Only reachable on a deliberate flag flip. =====
  if (mode.sendingEnabled && !mode.dryRun) {
    assertLiveSendAllowed(mode); // defensive; the branch condition already guarantees it

    // M7 — never push an empty draft. The chokepoint does not trust an upstream-stored draft blindly.
    if (!draft.subject?.trim() || !draft.body?.trim()) {
      await db
        .from('enrollments')
        .update({ status: 'failed', error: 'empty_draft' })
        .eq('id', enrollment.id);
      return { outcome: 'invalid' };
    }

    // H3 — fail CLOSED on verification. A live send requires a real verifier verdict; 'skipped'
    // means MillionVerifier was unconfigured at prepare time. Never push an unverified address.
    const verification = enrollment.verification ?? 'unknown';
    if (verification !== 'deliverable' && verification !== 'risky') {
      await db
        .from('enrollments')
        .update({ status: 'failed', error: 'verification_unavailable' })
        .eq('id', enrollment.id);
      return { outcome: 'verification_required' };
    }

    // Credit ENFORCE (unlike dry-run): no balance → no send.
    const credit = assessCredits(await creditBalance(db, org), SEND_COST);
    if (!credit.sufficient) {
      await db
        .from('enrollments')
        .update({ status: 'failed', error: 'insufficient_credit' })
        .eq('id', enrollment.id);
      return { outcome: 'insufficient_credit' };
    }

    if (!recipient) {
      await db
        .from('enrollments')
        .update({ status: 'failed', error: 'no_email' })
        .eq('id', enrollment.id);
      return { outcome: 'skipped' };
    }

    // Service-role client — required for the cross-org rate count and the credit debit.
    const admin = getSupabaseAdmin();
    if (!admin) {
      throw new AppError('Service-role client unavailable', {
        code: 'admin_unavailable',
        statusCode: 503,
      });
    }

    // H4 — Velora-side daily volume governor (per-org AND global), enforced at the single send
    // chokepoint independent of Smartlead's per-campaign cap. Over either ceiling → defer the send
    // (leave the enrollment 'awaiting_approval' so a later run can pick it up; do NOT fail it).
    const limits = caps ?? {
      perOrg: env.DAILY_SEND_CAP_PER_ORG,
      global: env.DAILY_SEND_CAP_GLOBAL,
    };
    const [orgToday, globalToday] = await Promise.all([
      countSendsToday(admin, org),
      countSendsToday(admin),
    ]);
    if (assessSendRate(orgToday, globalToday, limits)) {
      return { outcome: 'rate_limited' };
    }

    const dedupeKey = `send:${org}:${enrollment.id}:${enrollment.current_step}`;
    // C1 pre-check — a retry whose send was already claimed returns 'duplicate' before any push.
    const pre = await db
      .from('messages')
      .select('id')
      .eq('organization_id', org)
      .eq('dedupe_key', dedupeKey)
      .maybeSingle();
    if (pre.error) throw pre.error;
    if (pre.data) return { outcome: 'duplicate', messageId: pre.data.id as string };

    // Provision (H5 — serialized to exactly one Smartlead campaign) BEFORE the CAS, so a transient
    // provisioning failure leaves the enrollment sendable rather than being misread as a halt.
    const sl = client ?? createSmartleadClient();
    const campaign = await db
      .from('campaigns')
      .select('id, organization_id, name, smartlead_campaign_id')
      .eq('id', enrollment.campaign_id)
      .single();
    if (campaign.error) throw campaign.error;
    const smartleadCampaignId = await ensureSmartleadCampaign(
      db,
      {
        id: campaign.data.id as string,
        organization_id: org,
        name: campaign.data.name as string | null,
        smartlead_campaign_id: campaign.data.smartlead_campaign_id as string | null,
      },
      sl,
    );

    // M2 — compare-and-swap: only send if the enrollment is STILL sendable. If a reply/bounce/unsub
    // landed during the window it is no longer 'awaiting_approval' → halt (no push). Atomic.
    const cas = await db
      .from('enrollments')
      .update({ status: 'queued' })
      .eq('id', enrollment.id)
      .eq('status', 'awaiting_approval')
      .select('id');
    if (cas.error) throw cas.error;
    if ((cas.data ?? []).length === 0) return { outcome: 'halted' };

    const gates = {
      suppressed: false,
      verification,
      credit,
      mode: 'live' as const,
    };
    // C1 — CLAIM BEFORE PUSH. Write the dedupe message; only the creator (created === true) may
    // push. Any concurrent/retry caller sees created === false and refuses to re-send (at-most-once:
    // the dedupe key GATES the push rather than following it, so a crash/retry never double-sends).
    const { messageId, created } = await recordOutbound(db, enrollment, draft, {
      messageStatus: 'queued',
      enrollmentStatus: 'queued',
      gates,
    });
    if (!created) return { outcome: 'duplicate', messageId };

    // The irreversible push. If addLead THROWS, delivery is uncertain — we deliberately do NOT
    // auto re-push (the claim row above already blocks re-entry). Record the failure and surface
    // it; a push that truly failed will simply never produce an EMAIL_SENT webhook. We trade a rare
    // "claimed but maybe-not-sent" state for the guarantee of never double-sending a real email.
    try {
      await sl.addLead(smartleadCampaignId, {
        email: recipient,
        custom_fields: { velora_subject: draft.subject ?? '', velora_body: draft.body ?? '' },
      });
    } catch (err) {
      await db
        .from('enrollments')
        .update({ status: 'failed', error: 'send_push_failed' })
        .eq('id', enrollment.id);
      throw err;
    }

    // Debit credits (service-role). idempotency_key blocks a double-charge on retry; 23505 = no-op.
    const debit = await admin.from('credit_ledger').insert({
      organization_id: org,
      delta: -SEND_COST,
      reason: 'send',
      reference: { type: 'message', id: messageId ?? null },
      idempotency_key: dedupeKey,
    });
    if (debit.error && debit.error.code !== '23505') throw debit.error;

    return { outcome: 'queued', messageId };
  }

  // ===== DRY-RUN branch — never touches a provider, never debits credits. =====
  const gates = {
    suppressed: false,
    verification: enrollment.verification ?? 'unknown', // the actual verdict, not a boolean
    credit: assessCredits(await creditBalance(db, org), SEND_COST),
    mode: 'dry_run' as const,
  };
  const { messageId } = await recordOutbound(db, enrollment, draft, {
    messageStatus: 'dry_run',
    enrollmentStatus: 'sent',
    gates,
  });
  return { outcome: 'dry_run', messageId };
}
