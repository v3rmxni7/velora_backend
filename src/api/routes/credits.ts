import type { FastifyPluginAsync } from 'fastify';
import { authenticate, requireAuth } from '../middleware/auth.js';

// Credits balance (Phase 4 / Part B — backend support for the persistent footer indicator).
// User-scoped: RLS confines credit_ledger to the caller's org (its only policy is an authenticated
// org-scoped select), so a tenant can never see another org's balance. Append-only ledger →
// balance = Σ(delta); granted = Σ(positive), used = Σ|negative| give the footer a real usage bar.
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export const creditsRoute: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticate);

  app.get('/credits', async (request) => {
    const { db } = requireAuth(request);
    const { data, error } = await db.from('credit_ledger').select('delta');
    if (error) throw error;

    let granted = 0;
    let used = 0;
    for (const row of data ?? []) {
      const delta = Number(row.delta);
      if (delta >= 0) granted += delta;
      else used += -delta;
    }
    return {
      data: { balance: round6(granted - used), granted: round6(granted), used: round6(used) },
    };
  });
};
