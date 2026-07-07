import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { syncMailboxes } from '../../agents/sending/mailbox-sync.js';
import { getSupabaseAdmin } from '../../db/client.js';
import { createSmartleadClient } from '../../integrations/smartlead/smartlead.js';
import type { SmartleadProvisioningClient } from '../../integrations/smartlead/types.js';
import { recordAuditSafe } from '../../lib/audit.js';
import { events, inngest } from '../../workers/inngest/client.js';
import { authenticate, requireAuth, requireRole } from '../middleware/auth.js';

// `makeSmartleadClient` is injectable ONLY so tests exercise the connect lane with a fake provisioning
// client (no real Smartlead call); in production it is undefined and the real factory is used.
interface SendersRouteOptions {
  makeSmartleadClient?: () => SmartleadProvisioningClient;
}

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
const WarmupOverride = z.object({ override: z.boolean() });
// Mailbox connect (S3). SMTP + IMAP. `password` is validated only for shape (never logged/echoed —
// Zod issues carry no field values) and passed through to Smartlead, never persisted.
const ConnectMailbox = z.object({
  fromName: z.string().min(1).max(200),
  fromEmail: z.email(),
  userName: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
  smtpHost: z.string().min(1).max(255),
  smtpPort: z.coerce.number().int().min(1).max(65535),
  imapHost: z.string().min(1).max(255),
  imapPort: z.coerce.number().int().min(1).max(65535),
});

// Team surface (Phase 2 Slice 2.1): senders, their mailboxes, sending domains. All user-scoped
// (RLS). Read-only against Smartlead — nothing here can send.
export const sendersRoute: FastifyPluginAsync<SendersRouteOptions> = async (app, opts) => {
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

  // Established-mailbox attestation (4.x — the warm-up fast lane). An OWNER marks a real, in-use
  // mailbox as ready-to-send without waiting for the warm-up SEND threshold. Deliberate send-safety
  // act: setting it true forces 'warm' immediately (still spam-ceiling-checked on future refreshes,
  // via classifyWarmth's override branch); clearing it drops back to 'warming' to re-prove.
  // OWNER-only (S2): the route requireRole gives a clean 403, and the mailboxes_owner_send_eligibility
  // DB trigger is the real boundary (mailboxes has an authenticated UPDATE RLS policy, so a member
  // could otherwise flip it directly via PostgREST). Audited as mailbox_warmup_override_set.
  app.patch('/mailboxes/:id/warmup-override', async (request, reply) => {
    const { db, organizationId, userId } = requireAuth(request);
    requireRole(request, ['owner']);
    const { id } = IdParam.parse(request.params);
    const { override } = WarmupOverride.parse(request.body);
    const { data, error } = await db
      .from('mailboxes')
      .update({ warmup_override: override, status: override ? 'warm' : 'warming' })
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) return reply.code(404).send({ error: 'not_found' });
    await recordAuditSafe(getSupabaseAdmin(), {
      organizationId,
      kind: 'mailbox_warmup_override_set',
      userId,
      args: { mailboxId: id, override },
      source: 'user',
    });
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

  // Connect a mailbox via SMTP/IMAP (S3). OWNER/ADMIN. The credentials are a PASS-THROUGH to Smartlead
  // — Velora NEVER persists, logs, or echoes the password (it lives only in transit through this
  // handler → the adapter → Smartlead). Creates the account in Smartlead (503 in the no-key sandbox),
  // enables warmup, then syncs it into mailboxes as 'warming' — which grants NO send capability: the
  // warm-up physics + the S2 override owner-gate + the two-flag invariant + the L1 compliance guard all
  // still stand between a connected mailbox and a live send. Bad creds can return 200 with
  // is_smtp_success/is_imap_success false → surfaced as 422 (never a silent fake success).
  app.post('/mailboxes/connect', async (request, reply) => {
    const { db, organizationId, userId } = requireAuth(request);
    requireRole(request, ['owner', 'admin']);
    const input = ConnectMailbox.parse(request.body);

    const sl = (opts.makeSmartleadClient ?? createSmartleadClient)();
    const created = await sl.createEmailAccount(input);
    if (!created.smtpOk || !created.imapOk) {
      return reply.code(422).send({
        error: 'mailbox_connect_failed',
        detail: { smtp: created.smtpOk, imap: created.imapOk },
      });
    }
    await sl.enableWarmup(created.id);
    // Idempotent upsert of the new account into mailboxes (+ enqueues the warmup refresh). It lands
    // 'warming'/'connected', never 'warm'.
    await syncMailboxes(db, organizationId, sl);

    // Audit the connect WITHOUT any credential — only the non-secret identity + the Smartlead id.
    await recordAuditSafe(getSupabaseAdmin(), {
      organizationId,
      kind: 'mailbox_connected',
      userId,
      args: { fromEmail: input.fromEmail, smartleadEmailAccountId: created.id },
      source: 'user',
    });

    const mb = await db
      .from('mailboxes')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('email', input.fromEmail)
      .maybeSingle();
    if (mb.error) throw mb.error;
    return { data: mb.data };
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
