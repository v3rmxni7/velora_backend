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
import {
  assessLeadSearchRate,
  countLeadSearchesToday,
  creditBalanceFor,
  recordLeadSearchDebit,
} from '../../agents/leads/search-guard.js';
import { env } from '../../config/env.js';
import { getSupabaseAdmin } from '../../db/client.js';
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
    const { organizationId } = requireAuth(request);
    const body = SearchBody.parse(request.body);
    if (!body.query && !body.filters) {
      return reply.code(400).send({ error: 'bad_request', message: 'Provide query or filters' });
    }
    const provider = createLeadProvider();

    // ── Spend guardrail — METERED (paid-provider) searches only. The seed fixture is free, so it is
    // never quota-limited or debited. credit_ledger is service-role-write-only, so the count/debit use
    // the admin client (mirrors executeSend). Enforce BEFORE the paid call; debit AFTER it succeeds.
    const admin = provider.metered ? getSupabaseAdmin() : null;
    if (provider.metered) {
      if (!admin) {
        return reply
          .code(503)
          .send({ error: 'unavailable', message: 'Lead provider is temporarily unavailable.' });
      }
      const [orgToday, globalToday] = await Promise.all([
        countLeadSearchesToday(admin, organizationId),
        countLeadSearchesToday(admin),
      ]);
      if (
        assessLeadSearchRate(orgToday, globalToday, {
          perOrg: env.LEAD_DAILY_CAP_PER_ORG,
          global: env.LEAD_DAILY_CAP_GLOBAL,
        })
      ) {
        return reply.code(429).send({
          error: 'lead_search_rate_limited',
          message: 'Daily lead-search limit reached for your workspace — resets at 00:00 UTC.',
        });
      }
      if ((await creditBalanceFor(admin, organizationId)) < env.LEAD_SEARCH_COST) {
        return reply.code(402).send({
          error: 'insufficient_credit',
          message: 'Not enough credits for a lead search.',
        });
      }
    }

    // Resolve filters + run the search (per-branch typing; a provider error throws → no debit below).
    const run = async (): Promise<{ filters: unknown; results: unknown[] }> => {
      if (body.entityType === 'person') {
        const filters = body.query
          ? await nlToFiltersPerson(body.query)
          : PeopleFiltersSchema.parse(body.filters);
        return { filters, results: await provider.searchPeople(filters) };
      }
      if (body.entityType === 'company') {
        const filters = body.query
          ? await nlToFiltersCompany(body.query)
          : CompanyFiltersSchema.parse(body.filters);
        return { filters, results: await provider.searchCompanies(filters) };
      }
      const filters = body.query
        ? await nlToFiltersLocal(body.query)
        : LocalFiltersSchema.parse(body.filters);
      return { filters, results: await provider.searchLocal(filters) };
    };
    const { filters, results } = await run();

    // Debit one 'lead_search' credit only after a successful metered search.
    if (provider.metered && admin) {
      await recordLeadSearchDebit(admin, organizationId, {
        entityType: body.entityType,
        cost: env.LEAD_SEARCH_COST,
        resultCount: results.length,
      });
    }

    return { entityType: body.entityType, filters, results };
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
