import type { SupabaseClient } from '@supabase/supabase-js';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { WRITE_ACTIONS } from '../../agents/copilot/actions.js';
import { MAX_HISTORY, runCopilotTurn } from '../../agents/copilot/run.js';
import { type AccountCounts, suggestActions } from '../../agents/copilot/tools.js';
import type { LLMMessage } from '../../agents/llm/types.js';
import { getSupabaseAdmin } from '../../db/client.js';
import { recordAuditSafe } from '../../lib/audit.js';
import { authenticate, requireAuth, requireRole } from '../middleware/auth.js';

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

  // The chat turn: load capped history → runCopilotTurn → persist user + assistant rows. A proposed
  // write action is recorded as a copilot_actions row (status='proposed') the user later confirms.
  app.post('/copilot/threads/:id/messages', async (request, reply) => {
    const { db, organizationId, userId, role } = requireAuth(request);
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

    const turn = await runCopilotTurn({
      db,
      organizationId,
      userId,
      role,
      history,
      userMessage: content,
    });

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
    // Persist a proposed action (if any) referencing the assistant message. The LLM proposed it;
    // nothing is executed until the user confirms via the role-gated endpoint below.
    if (turn.proposedAction && assistant) {
      const a = turn.proposedAction;
      const act = await db.from('copilot_actions').insert({
        organization_id: organizationId,
        thread_id: id,
        message_id: assistant.id,
        user_id: userId,
        kind: a.kind,
        action_class: a.actionClass,
        title: a.title,
        args: a.args,
        status: 'proposed',
      });
      if (act.error) throw act.error;
    }
    return reply.code(201).send({ message: assistant, toolCall: turn.toolCall ?? null });
  });

  // The thread's agentic actions (hydrates the in-chat confirm/cancel cards + their live status).
  app.get('/copilot/threads/:id/actions', async (request, reply) => {
    const { db } = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const thread = await db.from('copilot_threads').select('id').eq('id', id).maybeSingle();
    if (thread.error) throw thread.error;
    if (!thread.data) return reply.code(404).send({ error: 'not_found' });
    const { data, error } = await db
      .from('copilot_actions')
      .select('*')
      .eq('thread_id', id)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return { data };
  });

  // Confirm a proposed action — the DETERMINISTIC, role-gated executor (NO LLM). Re-validates against
  // fresh state, runs the real work via the user-scoped db, flips status, and appends a plain
  // confirmation message. RLS scopes the lookup to the caller's org (cross-tenant → 404).
  app.post('/copilot/actions/:id/confirm', async (request, reply) => {
    const { db, organizationId, userId } = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    requireRole(request, ['owner', 'admin']); // §13 scoped permissions

    const act = await db.from('copilot_actions').select('*').eq('id', id).maybeSingle();
    if (act.error) throw act.error;
    if (!act.data) return reply.code(404).send({ error: 'not_found' });
    if (act.data.status !== 'proposed')
      return reply
        .code(409)
        .send({ error: 'not_proposed', message: `Action is ${act.data.status}.` });

    const action = WRITE_ACTIONS[act.data.kind as string];
    if (!action) return reply.code(422).send({ error: 'unknown_action' });

    const ctx = { db, organizationId, userId };
    const parsed = action.argsSchema.safeParse(act.data.args);
    const check = parsed.success
      ? await action.validate(parsed.data, ctx)
      : ({ ok: false, reason: 'The saved action details are no longer valid.' } as const);
    if (!check.ok) {
      const failed = await db
        .from('copilot_actions')
        .update({ status: 'failed', error: check.reason })
        .eq('id', id)
        .select('*')
        .single();
      if (failed.error) throw failed.error;
      return reply
        .code(409)
        .send({ error: 'no_longer_valid', message: check.reason, data: failed.data });
    }

    let status: 'confirmed' | 'failed' = 'confirmed';
    let summary: string;
    let result: unknown = null;
    let errText: string | null = null;
    try {
      const exec = await action.execute(parsed.data, ctx);
      summary = exec.summary;
      result = exec.result;
    } catch (err) {
      status = 'failed';
      errText = err instanceof Error ? err.message : 'execution_failed';
      summary = 'That action could not be completed.';
    }

    const upd = await db
      .from('copilot_actions')
      .update({ status, result: result ?? null, error: errText })
      .eq('id', id)
      .select('*')
      .single();
    if (upd.error) throw upd.error;

    // 4.12 — audit a confirmed agentic action (the security-relevant case; a failed run isn't a change).
    if (status === 'confirmed') {
      await recordAuditSafe(getSupabaseAdmin(), {
        organizationId,
        kind: 'copilot_action_confirmed',
        userId,
        args: { actionKind: act.data.kind, title: act.data.title },
        source: 'user',
      });
    }

    // A deterministic confirmation message (NOT fabricated LLM text) so the transcript stays coherent.
    await db.from('copilot_messages').insert({
      organization_id: organizationId,
      thread_id: act.data.thread_id,
      role: 'assistant',
      content: summary,
      tool_calls: {
        name: act.data.kind,
        args: act.data.args,
        result: {
          confirmed: status === 'confirmed',
          action: { kind: act.data.kind, title: act.data.title },
        },
      },
    });

    return { data: upd.data };
  });

  // Cancel a proposed action — no execution.
  app.post('/copilot/actions/:id/cancel', async (request, reply) => {
    const { db } = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const act = await db.from('copilot_actions').select('status').eq('id', id).maybeSingle();
    if (act.error) throw act.error;
    if (!act.data) return reply.code(404).send({ error: 'not_found' });
    if (act.data.status !== 'proposed')
      return reply
        .code(409)
        .send({ error: 'not_proposed', message: `Action is ${act.data.status}.` });
    const upd = await db
      .from('copilot_actions')
      .update({ status: 'cancelled' })
      .eq('id', id)
      .select('*')
      .single();
    if (upd.error) throw upd.error;
    return { data: upd.data };
  });

  // Deterministic, account-state-driven next-action nudges (no LLM call).
  app.get('/copilot/suggested-actions', async (request) => {
    const { db } = requireAuth(request);
    const counts = await loadCounts(db);
    return { actions: suggestActions(counts) };
  });
};
