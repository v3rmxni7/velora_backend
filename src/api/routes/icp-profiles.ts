import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireAuth } from '../middleware/auth.js';

const CreateBody = z.object({
  name: z.string().min(1),
  definition: z.record(z.string(), z.unknown()).optional(),
  source: z.enum(['manual', 'ai_suggested']).optional(),
});
const UpdateBody = z.object({
  name: z.string().min(1).optional(),
  definition: z.record(z.string(), z.unknown()).optional(),
  source: z.enum(['manual', 'ai_suggested']).optional(),
});
const IdParam = z.object({ id: z.uuid() });

export const icpProfilesRoute: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticate);

  app.get('/icp-profiles', async (request) => {
    const { db } = requireAuth(request);
    const { data, error } = await db
      .from('icp_profiles')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return { data };
  });

  app.post('/icp-profiles', async (request, reply) => {
    const { db, organizationId } = requireAuth(request);
    const body = CreateBody.parse(request.body);
    const { data, error } = await db
      .from('icp_profiles')
      .insert({ organization_id: organizationId, ...body })
      .select('*')
      .single();
    if (error) throw error;
    return reply.code(201).send({ data });
  });

  app.patch('/icp-profiles/:id', async (request, reply) => {
    const { db } = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const body = UpdateBody.parse(request.body);
    const { data, error } = await db
      .from('icp_profiles')
      .update(body)
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) return reply.code(404).send({ error: 'not_found' });
    return { data };
  });

  app.delete('/icp-profiles/:id', async (request, reply) => {
    const { db } = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const { error } = await db.from('icp_profiles').delete().eq('id', id);
    if (error) throw error;
    return reply.code(204).send();
  });
};
