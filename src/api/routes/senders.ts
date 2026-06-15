import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { syncMailboxes } from '../../agents/sending/mailbox-sync.js';
import { createSmartleadClient } from '../../integrations/smartlead/smartlead.js';
import { events, inngest } from '../../workers/inngest/client.js';
import { authenticate, requireAuth } from '../middleware/auth.js';

const CreateSender = z.object({ displayName: z.string().min(1).max(200) });
const CreateDomain = z.object({ domain: z.string().min(3).max(253) });

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
