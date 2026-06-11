import type { SupabaseClient } from '@supabase/supabase-js';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { MAX_HISTORY, runCopilotTurn } from '../../agents/copilot/run.js';
import { type AccountCounts, suggestActions } from '../../agents/copilot/tools.js';
import type { LLMMessage } from '../../agents/llm/types.js';
import { authenticate, requireAuth } from '../middleware/auth.js';

const CreateThread = z.object({ title: z.string().min(1).max(200).optional() });
const IdParam = z.object({ id: z.uuid() });
const PostMessage = z.object({ content: z.string().min(1).max(4000) });

/** Exact head-count of a table under the user-scoped client (RLS-scoped to the org). */
async function countRows(db: SupabaseClient, table: string): Promise<number> {
  const { count, error } = await db.from(table).select('*', { count: 'exact', head: true });
  if (error) throw error;
  return count ?? 0;
}

async function loadCounts(db: SupabaseClient): Promise<AccountCounts> {
  const [kbDocuments, coachingPoints, proofItems, people, companies, local, lists, tasks] =
    await Promise.all([
      countRows(db, 'kb_documents'),
      countRows(db, 'coaching_points'),
      countRows(db, 'proof_items'),
      countRows(db, 'people'),
      countRows(db, 'companies'),
      countRows(db, 'local_businesses'),
      countRows(db, 'lists'),
      countRows(db, 'tasks'),
    ]);
  return {
    kbDocuments,
    coachingPoints,
    proofItems,
    leads: people + companies + local,
    lists,
    tasks,
  };
}

export const copilotRoute: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticate);

  app.post('/copilot/threads', async (request, reply) => {
    const { db, organizationId, userId } = requireAuth(request);
    const body = CreateThread.parse(request.body);
    const { data, error } = await db
      .from('copilot_threads')
      .insert({ organization_id: organizationId, user_id: userId, title: body.title })
      .select('*')
      .single();
    if (error) throw error;
    return reply.code(201).send({ data });
  });

  // Caller's own threads only (per-user; RLS already isolates by org).
  app.get('/copilot/threads', async (request) => {
    const { db, userId } = requireAuth(request);
    const { data, error } = await db
      .from('copilot_threads')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return { data };
  });

  app.get('/copilot/threads/:id/messages', async (request, reply) => {
    const { db } = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const thread = await db.from('copilot_threads').select('id').eq('id', id).maybeSingle();
    if (thread.error) throw thread.error;
    if (!thread.data) return reply.code(404).send({ error: 'not_found' });
    const { data, error } = await db
      .from('copilot_messages')
      .select('*')
      .eq('thread_id', id)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return { data };
  });

  // The chat turn: load capped history → runCopilotTurn → persist user + assistant rows.
  app.post('/copilot/threads/:id/messages', async (request, reply) => {
    const { db, organizationId } = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const { content } = PostMessage.parse(request.body);

    const thread = await db.from('copilot_threads').select('id').eq('id', id).maybeSingle();
    if (thread.error) throw thread.error;
    if (!thread.data) return reply.code(404).send({ error: 'not_found' });

    const hist = await db
      .from('copilot_messages')
      .select('role, content')
      .eq('thread_id', id)
      .order('created_at', { ascending: false })
      .limit(MAX_HISTORY);
    if (hist.error) throw hist.error;
    const history: LLMMessage[] = (hist.data ?? [])
      .reverse()
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: String(m.content) }));

    const turn = await runCopilotTurn({ db, organizationId, history, userMessage: content });

    const ins = await db
      .from('copilot_messages')
      .insert([
        { organization_id: organizationId, thread_id: id, role: 'user', content },
        {
          organization_id: organizationId,
          thread_id: id,
          role: 'assistant',
          content: turn.replyText,
          tool_calls: turn.toolCall ?? null,
        },
      ])
      .select('*');
    if (ins.error) throw ins.error;

    const assistant = (ins.data ?? []).find((r) => r.role === 'assistant');
    return reply.code(201).send({ message: assistant, toolCall: turn.toolCall ?? null });
  });

  // Deterministic, account-state-driven next-action nudges (no LLM call).
  app.get('/copilot/suggested-actions', async (request) => {
    const { db } = requireAuth(request);
    const counts = await loadCounts(db);
    return { actions: suggestActions(counts) };
  });
};
