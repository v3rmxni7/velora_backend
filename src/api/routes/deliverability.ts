import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env.js';
import { authenticate, requireAuth } from '../middleware/auth.js';

// Deliverability metrics (Phase 2 — backend support for the frontend's Deliverability screen).
// User-scoped: RLS confines every figure to the caller's org. The GLOBAL daily send cap is a
// platform-level safeguard and is DELIBERATELY NOT exposed here — a tenant must never see
// cross-tenant aggregate volume. Only this org's own numbers are returned.
//
// Rich open/reply time-series are not included: they only become meaningful after real sends
// (Smartlead webhook history) and the frontend shows an honest empty state until then.
export const deliverabilityRoute: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticate);

  app.get('/deliverability', async (request) => {
    const { db, organizationId } = requireAuth(request);

    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    const sinceIso = since.toISOString();

    const [sendsToday, bounces, suppression, ledger, mailboxes] = await Promise.all([
      // Real sends today = the governor's own definition (outbound, non-dry-run, since UTC midnight).
      db
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('direction', 'outbound')
        .neq('status', 'dry_run')
        .gte('created_at', sinceIso),
      db
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('direction', 'outbound')
        .eq('status', 'bounced'),
      // org-only (exclude global NULL-org suppression rows — those aren't this tenant's list).
      db.from('suppression_list').select('reason').eq('organization_id', organizationId),
      db.from('credit_ledger').select('delta'),
      db.from('mailboxes').select('status'),
    ]);
    for (const r of [sendsToday, bounces, suppression, ledger, mailboxes]) {
      if (r.error) throw r.error;
    }

    const suppressionByReason: Record<string, number> = {};
    for (const row of suppression.data ?? []) {
      const reason = row.reason as string;
      suppressionByReason[reason] = (suppressionByReason[reason] ?? 0) + 1;
    }
    const creditBalance = (ledger.data ?? []).reduce((sum, r) => sum + Number(r.delta), 0);
    const mailboxesByStatus: Record<string, number> = {};
    for (const row of mailboxes.data ?? []) {
      const status = row.status as string;
      mailboxesByStatus[status] = (mailboxesByStatus[status] ?? 0) + 1;
    }

    const today = sendsToday.count ?? 0;
    const dailyCap = env.DAILY_SEND_CAP_PER_ORG;

    return {
      data: {
        sends: { today, dailyCap, remaining: Math.max(0, dailyCap - today) },
        bounces: { total: bounces.count ?? 0 },
        suppression: { total: suppression.data?.length ?? 0, byReason: suppressionByReason },
        credits: { balance: creditBalance },
        mailboxes: { total: mailboxes.data?.length ?? 0, byStatus: mailboxesByStatus },
      },
    };
  });
};
