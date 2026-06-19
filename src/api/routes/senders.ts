import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { syncMailboxes } from '../../agents/sending/mailbox-sync.js';
import { getSupabaseAdmin } from '../../db/client.js';
import { createSmartleadClient } from '../../integrations/smartlead/smartlead.js';
import { recordAuditSafe } from '../../lib/audit.js';
import { events, inngest } from '../../workers/inngest/client.js';
import { authenticate, requireAuth } from '../middleware/auth.js';

const CreateSender = z.object({ displayName: z.string().min(1).max(200) });
const CreateDomain = z.object({ domain: z.string().min(3).max(253) });
const IdParam = z.object({ id: z.uuid() });
const PatchSender = z.object({
  displayName: z.string().min(1).max(200).optional(),
  status: z.enum(['setup', 'active', 'paused']).optional(),
  userId: z.uuid().nullish(),
  signature: z.string().max(2000).nullish(), // 4.10 — sending identity; powers the email-signature quest.
});
const PrimaryMailbox = z.object({ mailboxId: z.uuid().nullable() });
const PatchMailbox = z.object({ senderId: z.uuid().nullable() });

// Team surface (Phase 2 Slice 2.1): senders, their mailboxes, sending domains. All user-scoped
// (RLS). Read-only against Smartlead — nothing here can send.
export const sendersRoute: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticate);

  app.get('/senders', async (request) => {
    const { db } = requireAuth(request);
    const { data, error } = await db
      .from('senders')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return { data };
  });

  app.post('/senders', async (request, reply) => {
    const { db, organizationId, userId } = requireAuth(request);
    const body = CreateSender.parse(request.body);
    const { data, error } = await db
      .from('senders')
      .insert({ organization_id: organizationId, user_id: userId, display_name: body.displayName })
      .select('*')
      .single();
    if (error) throw error;
    return reply.code(201).send({ data });
  });

  // 4.8 — full sender config (real DB state). All user-scoped (the sn/mb write quartets + RLS scope
  // everything to the caller's org). assign-user / assign-mailbox / set-primary / status.
  app.patch('/senders/:id', async (request, reply) => {
    const { db, organizationId, userId } = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const body = PatchSender.parse(request.body);
    if (body.userId) {
      // The assignee must be a member of the caller's org (RLS scopes the read; null → not in org).
      const u = await db.from('users').select('id').eq('id', body.userId).maybeSingle();
      if (u.error) throw u.error;
      if (!u.data) return reply.code(422).send({ error: 'user_not_in_org' });
    }
    const patch: Record<string, unknown> = {};
    if (body.displayName !== undefined) patch.display_name = body.displayName;
    if (body.status !== undefined) patch.status = body.status;
    if (body.userId !== undefined) patch.user_id = body.userId; // null clears the assignment
    if (body.signature !== undefined) patch.signature = body.signature; // null clears the signature
    const { data, error } = await db
      .from('senders')
      .update(patch)
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) return reply.code(404).send({ error: 'not_found' });
    // 4.12 — audit a real send-gate change (status) for compliance; other field edits aren't gated.
    if (body.status !== undefined) {
      await recordAuditSafe(getSupabaseAdmin(), {
        organizationId,
        kind: 'sender_status_changed',
        userId,
        args: { senderId: id, newStatus: body.status },
        source: 'user',
      });
    }
    return { data };
  });

  // Set (or clear) the sender's PRIMARY mailbox. Clear-then-set; the partial unique index
  // `mailboxes_one_primary_per_sender` is the invariant backstop (a concurrent double-set → 23505 → 409).
  app.patch('/senders/:id/primary-mailbox', async (request, reply) => {
    const { db } = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const { mailboxId } = PrimaryMailbox.parse(request.body);
    if (mailboxId) {
      const mb = await db
        .from('mailboxes')
        .select('id')
        .eq('id', mailboxId)
        .eq('sender_id', id)
        .maybeSingle();
      if (mb.error) throw mb.error;
      if (!mb.data) return reply.code(422).send({ error: 'mailbox_not_on_sender' });
    }
    const clear = await db.from('mailboxes').update({ is_primary: false }).eq('sender_id', id);
    if (clear.error) throw clear.error;
    if (mailboxId) {
      const set = await db.from('mailboxes').update({ is_primary: true }).eq('id', mailboxId);
      if (set.error) {
        if (set.error.code === '23505') return reply.code(409).send({ error: 'primary_conflict' });
        throw set.error;
      }
    }
    const { data, error } = await db
      .from('mailboxes')
      .select('*')
      .eq('sender_id', id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return { data };
  });

  // Assign / unassign a mailbox to a sender. Reassigning clears its primary flag (it can't carry a
  // stale primary into another sender — avoids violating the one-primary-per-sender invariant).
  app.patch('/mailboxes/:id', async (request, reply) => {
    const { db } = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const { senderId } = PatchMailbox.parse(request.body);
    if (senderId) {
      const s = await db.from('senders').select('id').eq('id', senderId).maybeSingle();
      if (s.error) throw s.error;
      if (!s.data) return reply.code(422).send({ error: 'sender_not_in_org' });
    }
    const { data, error } = await db
      .from('mailboxes')
      .update({ sender_id: senderId, is_primary: false })
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) return reply.code(404).send({ error: 'not_found' });
    return { data };
  });

  app.get('/mailboxes', async (request) => {
    const { db } = requireAuth(request);
    const { data, error } = await db
      .from('mailboxes')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return { data };
  });

  // Pull the org's Smartlead email accounts into mailboxes, then best-effort enqueue a per-mailbox
  // warmup refresh (async deep stats). 503 if SMARTLEAD_API_KEY isn't configured yet.
  app.post('/mailboxes/sync', async (request, reply) => {
    const { db, organizationId } = requireAuth(request);
    const result = await syncMailboxes(db, organizationId, createSmartleadClient());
    for (const mailboxId of result.mailboxIds) {
      try {
        await inngest.send({
          name: events.warmupCheck.name,
          data: { organizationId, mailboxId, dedupeKey: `warmup:${organizationId}:${mailboxId}` },
        });
      } catch (err) {
        request.log.warn({ err, mailboxId }, 'warmup-check enqueue failed (non-fatal)');
      }
    }
    return reply.code(200).send({ data: result });
  });

  app.get('/domains', async (request) => {
    const { db } = requireAuth(request);
    const { data, error } = await db
      .from('domains')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return { data };
  });

  app.post('/domains', async (request, reply) => {
    const { db, organizationId } = requireAuth(request);
    const body = CreateDomain.parse(request.body);
    const { data, error } = await db
      .from('domains')
      .insert({ organization_id: organizationId, domain: body.domain })
      .select('*')
      .single();
    if (error) throw error;
    return reply.code(201).send({ data });
  });
};
