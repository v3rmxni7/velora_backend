import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  buildCredits,
  buildMessaging,
  buildOverview,
  type LedgerRow,
  type MsgRow,
  resolveRange,
} from '../../lib/analytics.js';
import { authenticate, requireAuth } from '../middleware/auth.js';

// Analytics aggregation (Phase 4 Slice 4.2a). USER-SCOPED: every query runs under the caller's RLS
// client, so RLS IS the tenant isolation (a tenant can never see another org's data) — same posture
// as deliverability.ts / credits.ts. Read-only; no migration. The pure builders (src/lib/analytics)
// return only genuinely-computable COUNTS + a `realSends` switch; the UI derives rates only when
// realSends > 0 and renders honest-empty otherwise. Deliverability stays GET /deliverability.
const RangeQuery = z.object({ from: z.string().optional(), to: z.string().optional() });

export const analyticsRoute: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticate);

  app.get('/analytics/overview', async (request) => {
    const { db } = requireAuth(request);
    const { from, to } = RangeQuery.parse(request.query);
    const range = resolveRange(from, to, Date.now());
    const [enr, msg] = await Promise.all([
      db
        .from('enrollments')
        .select('created_at')
        .gte('created_at', range.fromIso)
        .lte('created_at', range.toIso),
      db
        .from('messages')
        .select('created_at, direction, status, category')
        .gte('created_at', range.fromIso)
        .lte('created_at', range.toIso),
    ]);
    if (enr.error) throw enr.error;
    if (msg.error) throw msg.error;
    return { data: buildOverview(range, enr.data ?? [], (msg.data ?? []) as MsgRow[]) };
  });

  app.get('/analytics/messaging', async (request) => {
    const { db } = requireAuth(request);
    const { from, to } = RangeQuery.parse(request.query);
    const range = resolveRange(from, to, Date.now());
    const msg = await db
      .from('messages')
      .select('created_at, direction, status, category, enrollment_id')
      .gte('created_at', range.fromIso)
      .lte('created_at', range.toIso);
    if (msg.error) throw msg.error;
    const messages = (msg.data ?? []) as MsgRow[];

    // Resolve enrollment → campaign + campaign names (RLS-scoped). Two small lookups, no join.
    const enrIds = [...new Set(messages.map((m) => m.enrollment_id).filter(Boolean))] as string[];
    const enrToCampaign = new Map<string, string>();
    const campaignName = new Map<string, string>();
    if (enrIds.length > 0) {
      const enr = await db.from('enrollments').select('id, campaign_id').in('id', enrIds);
      if (enr.error) throw enr.error;
      for (const r of enr.data ?? []) {
        if (r.campaign_id) enrToCampaign.set(r.id as string, r.campaign_id as string);
      }
      const campIds = [...new Set(enrToCampaign.values())];
      if (campIds.length > 0) {
        const camps = await db.from('campaigns').select('id, name').in('id', campIds);
        if (camps.error) throw camps.error;
        for (const c of camps.data ?? []) {
          campaignName.set(c.id as string, (c.name as string) ?? 'Untitled');
        }
      }
    }
    return { data: buildMessaging(range, messages, enrToCampaign, campaignName) };
  });

  app.get('/analytics/credits', async (request) => {
    const { db } = requireAuth(request);
    const { from, to } = RangeQuery.parse(request.query);
    const range = resolveRange(from, to, Date.now());
    // All-time ledger (balance is a running total); the builder windows byReason + series in range.
    const led = await db.from('credit_ledger').select('created_at, delta, reason');
    if (led.error) throw led.error;
    const ledger: LedgerRow[] = (led.data ?? []).map((r) => ({
      created_at: r.created_at as string,
      delta: Number(r.delta),
      reason: r.reason as string,
    }));
    return { data: buildCredits(range, ledger) };
  });
};
