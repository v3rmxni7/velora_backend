import type { SupabaseClient } from '@supabase/supabase-js';
import { createSmartleadClient } from '../../integrations/smartlead/smartlead.js';
import type { SmartleadClient } from '../../integrations/smartlead/types.js';
import { getAutonomyMode, recordAutonomyEvent } from '../../lib/autonomy-mode.js';
import { getSendingMode } from '../../lib/sending-mode.js';
import { isCampaignActive, isSuppressed } from '../sending/pipeline.js';
import { decideReplyAutoSend } from './auto-reply.js';

// Phase 3 Slice 3.4 — the REPLY send chokepoint. Mirrors executeSend's gate discipline for the most
// dangerous action (a real reply into a live conversation): DRY-RUN unless BOTH sending flags flip,
// a last-moment suppression re-check on the frozen recipient, an empty-body guard, and
// claim-before-push idempotency (reply_send:{org}:{task}) so a retry never double-sends. Cold uses
// addLead (a new lead); a reply is an in-thread response via sl.sendReply — hence a separate
// chokepoint. autoSendReplyIfQualified is the gated autonomous trigger (the human path calls
// executeReplySend directly from the approve route).

export type ReplySendOutcome =
  | 'dry_run'
  | 'queued'
  | 'not_approved'
  | 'suppressed'
  | 'campaign_paused'
  | 'invalid'
  | 'duplicate'
  | 'skipped'
  | 'error';

interface ReplyTask {
  organization_id: string;
  type: string;
  status: string;
  subject: string | null;
  body: string | null;
  thread_id: string | null;
  lead_type: string;
  lead_id: string;
  campaign_id: string | null;
}

/**
 * Send the reply on an APPROVED reply_approval task. DRY-RUN by default (writes a dry_run outbound
 * message, never touches Smartlead); LIVE only when sending_enabled && !sending_dry_run.
 */
export async function executeReplySend(
  db: SupabaseClient,
  taskId: string,
  client?: SmartleadClient,
): Promise<{ outcome: ReplySendOutcome; messageId?: string }> {
  const taskRes = await db
    .from('tasks')
    .select(
      'organization_id, type, status, subject, body, thread_id, lead_type, lead_id, campaign_id',
    )
    .eq('id', taskId)
    .maybeSingle();
  if (taskRes.error) throw taskRes.error;
  const task = taskRes.data as ReplyTask | null;
  if (!task) return { outcome: 'skipped' };
  if (task.type !== 'reply_approval') return { outcome: 'skipped' };
  if (task.status !== 'approved') return { outcome: 'not_approved' };
  const org = task.organization_id;
  const threadId = task.thread_id;
  if (!threadId || !task.campaign_id) return { outcome: 'skipped' };

  // Recipient = the enrollment's frozen verified_email (the address that replied).
  const enr = await db
    .from('enrollments')
    .select('id, verified_email')
    .eq('organization_id', org)
    .eq('campaign_id', task.campaign_id)
    .eq('lead_type', task.lead_type)
    .eq('lead_id', task.lead_id)
    .maybeSingle();
  if (enr.error) throw enr.error;
  const recipient = (enr.data?.verified_email as string | null) ?? null;
  if (!recipient) return { outcome: 'skipped' };

  // M3 — last-moment suppression re-check (never reply to a now-suppressed person).
  if (await isSuppressed(db, org, recipient)) return { outcome: 'suppressed' };

  // M7 — never send an empty reply.
  if (!task.body?.trim()) return { outcome: 'invalid' };

  // 4.1a — a paused campaign blocks reply sends too (pause stops all outbound for the campaign).
  if (!(await isCampaignActive(db, task.campaign_id))) return { outcome: 'campaign_paused' };

  const dedupeKey = `reply_send:${org}:${taskId}`;
  const claim = async (status: 'dry_run' | 'queued') => {
    const ins = await db
      .from('messages')
      .upsert(
        {
          organization_id: org,
          thread_id: threadId,
          enrollment_id: (enr.data?.id as string | undefined) ?? null,
          direction: 'outbound',
          channel: 'email',
          subject: task.subject,
          body: task.body,
          status,
          dedupe_key: dedupeKey,
          sent_at: new Date().toISOString(),
        },
        { onConflict: 'organization_id,dedupe_key', ignoreDuplicates: true },
      )
      .select('id');
    if (ins.error) throw ins.error;
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
    return { messageId, created };
  };

  const mode = await getSendingMode(db, org);

  // ===== LIVE — the irreversible path. Only on a deliberate two-flag flip. =====
  if (mode.sendingEnabled && !mode.dryRun) {
    // C1 pre-check — a retry whose reply was already claimed returns 'duplicate' before any push.
    const pre = await db
      .from('messages')
      .select('id')
      .eq('organization_id', org)
      .eq('dedupe_key', dedupeKey)
      .maybeSingle();
    if (pre.error) throw pre.error;
    if (pre.data) return { outcome: 'duplicate', messageId: pre.data.id as string };

    const campaign = await db
      .from('campaigns')
      .select('smartlead_campaign_id')
      .eq('id', task.campaign_id)
      .single();
    if (campaign.error) throw campaign.error;
    // The inbound reply's Smartlead message id (stored on the inbound message) — the thread ref.
    const inbound = await db
      .from('messages')
      .select('smartlead_message_id')
      .eq('organization_id', org)
      .eq('thread_id', threadId)
      .eq('direction', 'inbound')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const inReplyToMessageId = (inbound.data?.smartlead_message_id as string | null) ?? null;

    // C1 — CLAIM BEFORE PUSH: only the creator of the dedupe row may push.
    const { messageId, created } = await claim('queued');
    if (!created) return { outcome: 'duplicate', messageId };

    const sl = client ?? createSmartleadClient();
    try {
      await sl.sendReply(String(campaign.data.smartlead_campaign_id), {
        email: recipient,
        subject: task.subject,
        body: task.body,
        inReplyToMessageId,
      });
    } catch (err) {
      await db
        .from('messages')
        .update({ status: 'failed' })
        .eq('id', messageId ?? '');
      throw err;
    }
    return { outcome: 'queued', messageId };
  }

  // ===== DRY-RUN — never touches a provider. =====
  const { messageId } = await claim('dry_run');
  return { outcome: 'dry_run', messageId };
}

export interface ReplyAutoSendResult {
  decision: 'auto_send' | 'escalate';
  reason: string;
  outcome?: ReplySendOutcome;
}

/**
 * The gated autonomous trigger: decide whether a freshly-drafted reply may auto-send. autonomy mode
 * is re-read here (the 3.5 circuit-breaker's pause halts in-flight auto-sends). On auto_send the
 * audit is written BEFORE the send (no autonomous reply without a recorded decision), the task is
 * CAS-approved, and executeReplySend runs (dry-run unless the flags are flipped). Returns null only
 * if the task vanished or is no longer pending.
 */
export async function autoSendReplyIfQualified(
  db: SupabaseClient,
  taskId: string,
  client?: SmartleadClient,
): Promise<ReplyAutoSendResult | null> {
  const taskRes = await db
    .from('tasks')
    .select('organization_id, type, status, draft_mode, confidence, grounding')
    .eq('id', taskId)
    .maybeSingle();
  if (taskRes.error) throw taskRes.error;
  const task = taskRes.data;
  if (!task) return null;
  if (task.type !== 'reply_approval' || task.status !== 'pending') return null;
  const org = task.organization_id as string;

  const mode = await getAutonomyMode(db, org);
  const confidence = Number(task.confidence ?? 0);
  const decision = decideReplyAutoSend(
    {
      draftMode: (task.draft_mode as 'personalized' | 'template') ?? 'template',
      confidence,
      grounding: (task.grounding as { verification: { ok: boolean } }) ?? {
        verification: { ok: false },
      },
    },
    mode,
  );
  if (decision.action !== 'auto_send') {
    return { decision: 'escalate', reason: decision.reason }; // stays a pending draft for a human
  }

  // CAS-approve (autonomous; approved_by stays null).
  const approve = await db
    .from('tasks')
    .update({ status: 'approved', approved_at: new Date().toISOString() })
    .eq('id', taskId)
    .eq('status', 'pending')
    .select('id');
  if (approve.error) throw approve.error;
  if ((approve.data ?? []).length === 0) return { decision: 'auto_send', reason: decision.reason };

  // Audit BEFORE the send — no autonomous reply send without a recorded decision.
  await recordAutonomyEvent(db, {
    organizationId: org,
    kind: 'reply',
    taskId,
    decision: 'auto_send',
    reason: decision.reason,
    confidence,
  });

  try {
    const res = await executeReplySend(db, taskId, client);
    return { decision: 'auto_send', reason: decision.reason, outcome: res.outcome };
  } catch {
    return { decision: 'auto_send', reason: decision.reason, outcome: 'error' };
  }
}
