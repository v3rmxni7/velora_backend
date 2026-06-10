import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireAuth } from '../middleware/auth.js';

const Category = z.enum(['highlight', 'customer', 'case_study']);
const CreateBody = z.object({
  category: Category,
  title: z.string().min(1),
  body: z.string().optional(),
  url: z.url().optional(),
});
const UpdateBody = z.object({
  category: Category.optional(),
  title: z.string().min(1).optional(),
  body: z.string().nullable().optional(),
  url: z.url().nullable().optional(),
});
const IdParam = z.object({ id: z.uuid() });

export const proofItemsRoute: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticate);

  app.get('/proof-items', async (request) => {
    const { db } = requireAuth(request);
    const category = (request.query as { category?: string }).category;
    let query = db.from('proof_items').select('*');
    if (category) query = query.eq('category', category);
    const { data, error } = await query.order('created_at', { ascending: false });
    if (error) throw error;
    return { data };
  });

  app.post('/proof-items', async (request, reply) => {
    const { db, organizationId } = requireAuth(request);
    const body = CreateBody.parse(request.body);
    const { data, error } = await db
      .from('proof_items')
      .insert({ organization_id: organizationId, ...body })
      .select('*')
      .single();
    if (error) throw error;
    return reply.code(201).send({ data });
  });

  app.patch('/proof-items/:id', async (request, reply) => {
    const { db } = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const body = UpdateBody.parse(request.body);
    const { data, error } = await db
      .from('proof_items')
      .update(body)
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) return reply.code(404).send({ error: 'not_found' });
    return { data };
  });

  app.delete('/proof-items/:id', async (request, reply) => {
    const { db } = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const { error } = await db.from('proof_items').delete().eq('id', id);
    if (error) throw error;
    return reply.code(204).send();
  });
};
