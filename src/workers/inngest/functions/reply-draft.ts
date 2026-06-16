import { runReplyDraft } from '../../../agents/reply/draft.js';
import { autoSendReplyIfQualified } from '../../../agents/reply/send.js';
import { getSupabaseAdmin } from '../../../db/client.js';
import { events, inngest } from '../client.js';

// Phase 3 Slice 3.3b — async grounded reply draft for an 'engage' reply. Keeps the inbound webhook
// fast (the mid-tier writer runs here, not in the request) + durable retries. Idempotent on
// dedupeKey; runReplyDraft also upserts the task on a stable key, so a retry never double-files.
// The draft is filed as a reply_approval task for human review — it is NEVER sent (that is 3.4).
export const replyDraft = inngest.createFunction(
  {
    id: 'reply-draft',
    idempotency: 'event.data.dedupeKey',
    triggers: [{ event: events.replyDraft }],
  },
  async ({ event, step }) =>
    step.run('compose', async () => {
      const db = getSupabaseAdmin();
      if (!db) throw new Error('Supabase admin client not configured');
      const { organizationId, enrollmentId, threadId, inboundMessageId, category } = event.data;
      const { task } = await runReplyDraft({
        db,
        organizationId,
        enrollmentId,
        threadId,
        inboundMessageId,
        category,
      });
      // 3.4 — if the org opted into auto_reply_mode='send' AND the draft qualifies (personalized,
      // verified, ≥ confidence), auto-send it through the gated chokepoint (dry-run unless the two
      // sending flags are flipped). Otherwise it stays a pending draft for human approval.
      let autoSend: string | undefined;
      if (task?.id) {
        const r = await autoSendReplyIfQualified(db, task.id as string);
        autoSend = r ? `${r.decision}${r.outcome ? `:${r.outcome}` : ''}` : undefined;
      }
      return { ok: true, filed: !!task, autoSend };
    }),
);
