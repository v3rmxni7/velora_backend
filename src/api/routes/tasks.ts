import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { runDraftGeneration } from '../../agents/draft/task.js';
import { executeReplySend } from '../../agents/reply/send.js';
import { type EnrollmentRecord, executeSend } from '../../agents/sending/pipeline.js';
import { events, inngest } from '../../workers/inngest/client.js';
import { authenticate, requireAuth } from '../middleware/auth.js';

const ListQuery = z.object({
  type: z.enum(['outbound_approval', 'manual', 'platform']).optional(),
  status: z.enum(['pending', 'approved', 'rejected', 'dismissed']).optional(),
  search: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const IdParam = z.object({ id: z.uuid() });
const RejectBody = z.object({ reason: z.string().max(500).optional() });
const ApproveAll = z.object({ ids: z.array(z.uuid()).max(500).optional() });
const GenerateBody = z.object({
  leadType: z.enum(['person', 'company', 'local_business']),
  leadId: z.uuid(),
  campaignId: z.uuid().optional(),
});

type CountKey = 'outbound_approval' | 'manual' | 'platform';

export const tasksRoute: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticate);

  app.get('/tasks', async (request) => {
    const { db } = requireAuth(request);
    const { type, status, search, limit } = ListQuery.parse(request.query);
    let q = db.from('tasks').select('*');
    if (type) q = q.eq('type', type);
    if (status) q = q.eq('status', status);
    if (search) q = q.ilike('subject', `%${search}%`);
    const { data, error } = await q.order('created_at', { ascending: false }).limit(limit);
    if (error) throw error;
    return { data };
  });

  // Pending count per task type (powers the badges). Static route — declared before /:id.
  app.get('/tasks/counts', async (request) => {
    const { db } = requireAuth(request);
    const { data, error } = await db.from('tasks').select('type').eq('status', 'pending');
    if (error) throw error;
    const pending: Record<CountKey, number> = { outbound_approval: 0, manual: 0, platform: 0 };
    for (const r of data ?? []) {
      const t = r.type as CountKey;
      if (t in pending) pending[t] += 1;
    }
    return { pending };
  });

  app.get('/tasks/:id', async (request, reply) => {
    const { db } = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const { data, error } = await db.from('tasks').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) return reply.code(404).send({ error: 'not_found' });
    return { data };
  });

  app.post('/tasks/:id/approve', async (request, reply) => {
    const { db, userId } = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const { data, error } = await db
      .from('tasks')
      .update({ status: 'approved', approved_by: userId, approved_at: new Date().toISOString() })
      .eq('id', id)
      .eq('status', 'pending')
      .select('id, type, campaign_id')
      .maybeSingle();
    if (error) throw error;
    if (!data) return reply.code(404).send({ error: 'not_found_or_not_pending' });

    // Approving a draft is the send gate → run the (dry-run) send through the chokepoint. Best-effort:
    // the approval already succeeded; surface the outcome. Cold drafts → executeSend; reply drafts
    // (3.4) → executeReplySend. Both dry-run unless the two sending flags are flipped.
    let send: string | undefined;
    if (data.type === 'outbound_approval' && data.campaign_id) {
      try {
        const enr = await db.from('enrollments').select('*').eq('task_id', id).maybeSingle();
        if (enr.data) {
          const res = await executeSend(db, enr.data as EnrollmentRecord);
          send = res.outcome;
        }
      } catch (err) {
        request.log.error({ err, taskId: id }, 'executeSend after approval failed');
        send = 'error';
      }
    } else if (data.type === 'reply_approval') {
      try {
        const res = await executeReplySend(db, id);
        send = res.outcome;
      } catch (err) {
        request.log.error({ err, taskId: id }, 'executeReplySend after approval failed');
        send = 'error';
      }
    }
    return { data, send };
  });

  app.post('/tasks/:id/reject', async (request, reply) => {
    const { db } = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const { reason } = RejectBody.parse(request.body ?? {});
    const { data, error } = await db
      .from('tasks')
      .update({ status: 'rejected', reason: reason ?? null })
      .eq('id', id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) return reply.code(404).send({ error: 'not_found_or_not_pending' });
    return { data };
  });

  app.post('/tasks/approve-all', async (request) => {
    const { db, userId } = requireAuth(request);
    const { ids } = ApproveAll.parse(request.body ?? {});
    let q = db
      .from('tasks')
      .update({ status: 'approved', approved_by: userId, approved_at: new Date().toISOString() })
      .eq('status', 'pending')
      .eq('type', 'outbound_approval');
    if (ids && ids.length > 0) q = q.in('id', ids);
    const { data, error } = await q.select('id, campaign_id');
    if (error) throw error;
    const approvedTasks = data ?? [];

    // M1 — bulk approval must flow through the SAME send chokepoint as single approve, so it
    // inherits every gate (suppression / verification / credit / rate governor). Sequential so the
    // per-org volume governor (H4) counts each send before deciding the next.
    const sent: Record<string, number> = {};
    for (const task of approvedTasks) {
      if (!task.campaign_id) continue;
      try {
        const enr = await db.from('enrollments').select('*').eq('task_id', task.id).maybeSingle();
        if (enr.data) {
          const res = await executeSend(db, enr.data as EnrollmentRecord);
          sent[res.outcome] = (sent[res.outcome] ?? 0) + 1;
        }
      } catch (err) {
        request.log.error({ err, taskId: task.id }, 'executeSend after approve-all failed');
        sent.error = (sent.error ?? 0) + 1;
      }
    }
    return { approved: approvedTasks.length, sent };
  });

  // Enqueue a draft for a saved lead (authorize, then dispatch the idempotent job).
  app.post('/tasks/generate', async (request, reply) => {
    const { organizationId } = requireAuth(request);
    const { leadType, leadId, campaignId } = GenerateBody.parse(request.body);
    const dedupeKey = `draft:${organizationId}:${leadType}:${leadId}:${campaignId ?? 'none'}`;
    await inngest.send({
      name: events.draftGenerate.name,
      data: { organizationId, leadType, leadId, ...(campaignId ? { campaignId } : {}), dedupeKey },
    });
    return reply.code(202).send({ status: 'queued', dedupeKey });
  });

  // Synchronous generate: run the identical pipeline inline and return the created task.
  // User-scoped (RLS) + org from the token — a lead in another org resolves to 404. Lets the
  // UI produce a real grounded draft in one click without a running Inngest worker.
  app.post('/tasks/generate-sync', async (request, reply) => {
    const { db, organizationId } = requireAuth(request);
    const { leadType, leadId, campaignId } = GenerateBody.parse(request.body);
    const { task } = await runDraftGeneration({ db, organizationId, leadType, leadId, campaignId });
    return reply.code(201).send({ data: task });
  });
};
