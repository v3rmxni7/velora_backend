import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireAuth } from '../middleware/auth.js';

const ENTITY = z.enum(['person', 'company', 'local_business']);
const TABLE = {
  person: 'people',
  company: 'companies',
  local_business: 'local_businesses',
} as const;
const NAME_COL = { person: 'full_name', company: 'name', local_business: 'name' } as const;

const ListQuery = z.object({
  entityType: ENTITY,
  search: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const DetailParam = z.object({ entityType: ENTITY, id: z.uuid() });

export const leadsRoute: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticate);

  app.get('/leads', async (request) => {
    const { db } = requireAuth(request);
    const { entityType, search, limit } = ListQuery.parse(request.query);
    let query = db.from(TABLE[entityType]).select('*');
    if (search) query = query.ilike(NAME_COL[entityType], `%${search}%`);
    const { data, error } = await query.order('created_at', { ascending: false }).limit(limit);
    if (error) throw error;
    return { entityType, data };
  });

  app.get('/leads/:entityType/:id', async (request, reply) => {
    const { db } = requireAuth(request);
    const { entityType, id } = DetailParam.parse(request.params);
    const { data, error } = await db.from(TABLE[entityType]).select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) return reply.code(404).send({ error: 'not_found' });
    return { entityType, data };
  });
};
