import type { SupabaseClient } from '@supabase/supabase-js';
import { eventToUpdate, type SmartleadEvent } from '../../lib/smartlead-webhook.js';
import { classifyReply, type ReplyCategory } from '../reply/classify.js';

// Inbound-event core (Phase 2 Slice 2.6). The webhook route verifies the HMAC signature over the
// raw body and hands the parsed event here; this is where ALL Smartlead events apply their effects,
// service-role and org-scoped (resolved from the Smartlead campaign id, never trusted from the
// payload). Every effect is idempotent so a webhook retry is a no-op:
//   sent/open/click        → outbound message status (via the pure eventToUpdate)
//   EMAIL_REPLY            → inbound message + classify + thread needs_action + enrollment replied (HALT)
//   EMAIL_BOUNCE           → message/enrollment bounced + suppression (bounce)
//   LEAD_UNSUBSCRIBED      → enrollment unsubscribed + suppression (unsubscribe) + thread handled
// "HALT" is just the terminal enrollment status: campaignExecutor only ever processes 'pending',
// so a replied/bounced/unsubscribed lead is never sent to again. (Multi-step next-step cancel: 2.7.)

export interface InboundDeps {
  classify?: (body: string) => Promise<ReplyCategory>;
}

export type ApplyResult = { handled: boolean };

interface ResolvedTarget {
  org: string;
  campaignId: string;
  enrollmentId: string;
  threadId: string | null;
  recipient: string;
}

/** Resolve our org/campaign/enrollment from the event, or null if it isn't ours (→ handled:false). */
async function resolveTarget(
  db: SupabaseClient,
  event: SmartleadEvent,
): Promise<ResolvedTarget | null> {
  const camp = await db
    .from('campaigns')
    .select('id, organization_id')
    .eq('smartlead_campaign_id', String(event.campaign_id))
    .maybeSingle();
  if (camp.error) throw camp.error;
  if (!camp.data) return null;
  const org = camp.data.organization_id as string;

  const recipient = event.to_email ?? event.lead_email;
  if (!recipient) return null;

  const enr = await db
    .from('enrollments')
    .select('id, thread_id')
    .eq('organization_id', org)
    .eq('campaign_id', camp.data.id)
    .eq('verified_email', recipient)
    .maybeSingle();
  if (enr.error) throw enr.error;
  if (!enr.data) return null;

  return {
    org,
    campaignId: camp.data.id as string,
    enrollmentId: enr.data.id as string,
    threadId: (enr.data.thread_id as string | null) ?? null,
    recipient,
  };
}

/** Append an org+email row to the suppression list, idempotently (the unique (org,email) wins). */
async function suppress(
  db: SupabaseClient,
  org: string,
  email: string,
  reason: 'bounce' | 'unsubscribe' | 'reply',
): Promise<void> {
  const { error } = await db
    .from('suppression_list')
    .upsert(
      { organization_id: org, email, reason, source: 'smartlead' },
      { onConflict: 'organization_id,email', ignoreDuplicates: true },
    );
  if (error) throw error;
}

export async function applySmartleadEvent(
  db: SupabaseClient,
  event: SmartleadEvent,
  deps: InboundDeps = {},
): Promise<ApplyResult> {
  const type = event.event_type;

  // ---- simple status events (sent/open/click) — unchanged 2.5 behavior ----
  const update = eventToUpdate(type);
  if (update) {
    const t = await resolveTarget(db, event);
    if (!t) return { handled: false };
    const msgUpdate: Record<string, unknown> = { status: update.status };
    if (event.message_id) msgUpdate.smartlead_message_id = String(event.message_id);
    const m = await db
      .from('messages')
      .update(msgUpdate)
      .eq('organization_id', t.org)
      .eq('enrollment_id', t.enrollmentId)
      .eq('direction', 'outbound');
    if (m.error) throw m.error;
    if (update.enrollmentStatus) {
      const e = await db
        .from('enrollments')
        .update({ status: update.enrollmentStatus })
        .eq('id', t.enrollmentId);
      if (e.error) throw e.error;
    }
    return { handled: true };
  }

  // ---- inbound events (2.6) ----
  if (type === 'EMAIL_REPLY') {
    const t = await resolveTarget(db, event);
    if (!t) return { handled: false };

    // M5 — idempotent on the Smartlead message id. Pre-check the inbound message; if it already
    // exists (a replayed/duplicate webhook), this is a no-op — crucially we do NOT call the LLM
    // classifier again (no cost amplification on replays) and do not re-run the writes.
    const dedupeKey = `reply:${t.org}:${t.enrollmentId}:${event.message_id ?? 'na'}`;
    const existing = await db
      .from('messages')
      .select('id')
      .eq('organization_id', t.org)
      .eq('dedupe_key', dedupeKey)
      .maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data) return { handled: true };

    const classify = deps.classify ?? classifyReply;
    const replyBody = event.reply_body ?? event.reply_message ?? event.body ?? '';
    const category = await classify(replyBody);

    const insMsg = await db.from('messages').upsert(
      {
        organization_id: t.org,
        thread_id: t.threadId,
        enrollment_id: t.enrollmentId,
        direction: 'inbound',
        channel: 'email',
        body: replyBody || null,
        status: 'replied',
        category,
        dedupe_key: dedupeKey,
      },
      { onConflict: 'organization_id,dedupe_key', ignoreDuplicates: true },
    );
    if (insMsg.error) throw insMsg.error;

    if (t.threadId) {
      const thr = await db
        .from('threads')
        .update({ status: 'needs_action', last_message_at: new Date().toISOString() })
        .eq('id', t.threadId);
      if (thr.error) throw thr.error;
    }
    // HALT: terminal status removes the lead from the executor's 'pending' work set.
    const enr = await db.from('enrollments').update({ status: 'replied' }).eq('id', t.enrollmentId);
    if (enr.error) throw enr.error;
    // H1 — a reply suppresses the PERSON globally: they engaged, so the machine stops contacting
    // them across ALL campaigns (the suppression gates block re-enrollment elsewhere). Decision
    // locked; "interested"-reply routing to a human is a later refinement.
    await suppress(db, t.org, t.recipient, 'reply');
    return { handled: true };
  }

  if (type === 'EMAIL_BOUNCE') {
    const t = await resolveTarget(db, event);
    if (!t) return { handled: false };
    const m = await db
      .from('messages')
      .update({ status: 'bounced' })
      .eq('organization_id', t.org)
      .eq('enrollment_id', t.enrollmentId)
      .eq('direction', 'outbound');
    if (m.error) throw m.error;
    const enr = await db.from('enrollments').update({ status: 'bounced' }).eq('id', t.enrollmentId);
    if (enr.error) throw enr.error;
    await suppress(db, t.org, t.recipient, 'bounce');
    return { handled: true };
  }

  if (type === 'LEAD_UNSUBSCRIBED') {
    const t = await resolveTarget(db, event);
    if (!t) return { handled: false };
    const enr = await db
      .from('enrollments')
      .update({ status: 'unsubscribed' })
      .eq('id', t.enrollmentId);
    if (enr.error) throw enr.error;
    await suppress(db, t.org, t.recipient, 'unsubscribe');
    if (t.threadId) {
      const thr = await db.from('threads').update({ status: 'handled' }).eq('id', t.threadId);
      if (thr.error) throw thr.error;
    }
    return { handled: true };
  }

  return { handled: false }; // unknown event type
}
