import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  CompanyFiltersSchema,
  LocalFiltersSchema,
  nlToFiltersCompany,
  nlToFiltersLocal,
  nlToFiltersPerson,
  PeopleFiltersSchema,
} from '../../agents/leads/filters.js';
import { icpSuggestions } from '../../agents/leads/icp.js';
import { createLeadProvider } from '../../integrations/leads/index.js';
import { authenticate, requireAuth } from '../middleware/auth.js';

const SearchBody = z.object({
  entityType: z.enum(['person', 'company', 'local_business']),
  query: z.string().min(1).max(500).optional(),
  filters: z.record(z.string(), z.unknown()).optional(),
});

export const findLeadsRoute: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticate);

  // Search the provider (the rented-data universe). Auth required, but no org rows
  // are touched — results are ephemeral until saved to a list.
  app.post('/find-leads/search', async (request, reply) => {
    requireAuth(request);
    const body = SearchBody.parse(request.body);
    if (!body.query && !body.filters) {
      return reply.code(400).send({ error: 'bad_request', message: 'Provide query or filters' });
    }
    const provider = createLeadProvider();

    if (body.entityType === 'person') {
      const filters = body.query
        ? await nlToFiltersPerson(body.query)
        : PeopleFiltersSchema.parse(body.filters);
      return {
        entityType: body.entityType,
        filters,
        results: await provider.searchPeople(filters),
      };
    }
    if (body.entityType === 'company') {
      const filters = body.query
        ? await nlToFiltersCompany(body.query)
        : CompanyFiltersSchema.parse(body.filters);
      return {
        entityType: body.entityType,
        filters,
        results: await provider.searchCompanies(filters),
      };
    }
    const filters = body.query
      ? await nlToFiltersLocal(body.query)
      : LocalFiltersSchema.parse(body.filters);
    return { entityType: body.entityType, filters, results: await provider.searchLocal(filters) };
  });

  // AI ICP suggestions personalized from the org's KB (read via the user-scoped client).
  app.get('/find-leads/icp-suggestions', async (request) => {
    const { db } = requireAuth(request);
    const [cp, pi] = await Promise.all([
      db.from('coaching_points').select('content').limit(50),
      db.from('proof_items').select('title, body').limit(50),
    ]);
    if (cp.error) throw cp.error;
    if (pi.error) throw pi.error;
    const coachingPoints = (cp.data ?? []).map((r) => String(r.content));
    const proofItems = (pi.data ?? []).map((r) => [r.title, r.body].filter(Boolean).join(' — '));
    const suggestions = await icpSuggestions({ coachingPoints, proofItems });
    return { suggestions };
  });
};
