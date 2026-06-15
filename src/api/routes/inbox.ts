import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireAuth } from '../middleware/auth.js';

const InboxQuery = z.object({
  status: z.enum(['active', 'needs_action', 'handled', 'auto_handled']).optional(),
});
const IdParam = z.object({ id: z.uuid() });

// Inbox read surface (Phase 2 Slice 2.6). User-scoped — RLS confines every row to the caller's org.
// The frontend Inbox reads these; replies/bounces land here via the Smartlead webhook (2.6).
export const inboxRoute: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticate);

  // Threads, newest activity first. Default view = those that need a human (?status=needs_action).
  app.get('/inbox', async (request) => {
    const { db } = requireAuth(request);
    const { status } = InboxQuery.parse(request.query);
    let q = db.from('threads').select('*');
    if (status) q = q.eq('status', status);
    const { data, error } = await q.order('last_message_at', {
      ascending: false,
      nullsFirst: false,
    });
    if (error) throw error;
    return { data };
  });

  // One thread + its messages (oldest → newest, the conversation order).
  app.get('/threads/:id', async (request, reply) => {
    const { db } = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const thread = await db.from('threads').select('*').eq('id', id).maybeSingle();
    if (thread.error) throw thread.error;
    if (!thread.data) return reply.code(404).send({ error: 'not_found' });
    const messages = await db
      .from('messages')
      .select('*')
      .eq('thread_id', id)
      .order('created_at', { ascending: true });
    if (messages.error) throw messages.error;
    return { data: { ...thread.data, messages: messages.data ?? [] } };
  });
};
