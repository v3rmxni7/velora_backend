import type { FastifyPluginAsync } from 'fastify';
import { reconcileQuests } from '../../billing/quests.js';
import { getSupabaseAdmin } from '../../db/client.js';
import { authenticate, requireAuth } from '../middleware/auth.js';

// 4.10 — onboarding quests (SPEC §3.1). GET reconciles: it derives completion from REAL org state and
// awards credits for any newly-complete quest exactly once (idempotent — see billing/quests.ts), then
// returns the catalog with per-quest done/awarded + the X/14 count + total credits earned. Awarding on
// read is safe because it's idempotent; the ledger is the auditable record of every reward.
export const questsRoute: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticate);

  app.get('/quests', async (request) => {
    const { db, organizationId } = requireAuth(request);
    const progress = await reconcileQuests(db, getSupabaseAdmin(), organizationId);
    return { data: progress };
  });
};
