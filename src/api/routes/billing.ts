import type { FastifyPluginAsync } from 'fastify';
import {
  isLowBalance,
  LOW_BALANCE_THRESHOLD,
  PLAN_TIERS,
  type PlanTier,
} from '../../billing/plans.js';
import { orgCreditBalance } from '../../lib/credit-balance.js';
import { authenticate, requireAuth } from '../middleware/auth.js';

// 4.10 — billing surface (SPEC §10/§3.14). HONEST SHELL for payments: the current plan + tiers + the
// real ledger balance are returned, but `topUpConfigured` is false — there is NO payment provider
// wired, so the UI must show an honest "billing not configured" state and NEVER imply a charge or a
// balance increase. Credits only ever post via real grants / quest rewards / a verified provider
// webhook at go-live (reason 'top_up'); this route writes nothing.
export const billingRoute: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticate);

  app.get('/billing', async (request) => {
    const { db, organizationId } = requireAuth(request);

    const org = await db
      .from('organizations')
      .select('plan')
      .eq('id', organizationId)
      .maybeSingle();
    if (org.error) throw org.error;
    const plan = (org.data?.plan as PlanTier | undefined) ?? 'starter';

    // Balance = Σ(delta) summed in the DB (RLS-scoped). A client-side sum truncates at the 1000-row
    // cap and would UNDER-report a long-lived org's balance.
    const balance = await orgCreditBalance(db, organizationId);

    return {
      data: {
        plan,
        tiers: PLAN_TIERS,
        balance: Math.round(balance * 1e6) / 1e6,
        lowBalance: isLowBalance(balance),
        lowBalanceThreshold: LOW_BALANCE_THRESHOLD,
        topUpConfigured: false, // honest: no payment provider connected — purchases are disabled.
      },
    };
  });
};
