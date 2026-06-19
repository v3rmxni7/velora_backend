import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { verifyAndStoreDomainAuth } from '../../agents/compliance/dns-verify.js';
import { env } from '../../config/env.js';
import { getSupabaseAdmin } from '../../db/client.js';
import { recordAuditSafe } from '../../lib/audit.js';
import { authenticate, requireAuth } from '../middleware/auth.js';

const IdParam = z.object({ id: z.uuid() });
const AuditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// 4.12 — the compliance surface. All user-scoped (RLS); the audit log is read-only to clients (only
// the service-role appends). DNS verification is REAL (dns.resolveTxt) and on-demand.
export const complianceRoute: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticate);

  // Summary: domain auth status + the org's retention policy + suppression counts (a real compliance
  // signal). Domains carry the real spf/dkim/dmarc statuses; retention.dryRun drives the honest
  // "report-only until go-live" UI.
  app.get('/compliance', async (request) => {
    const { db, organizationId } = requireAuth(request);
    const [domains, org, suppression] = await Promise.all([
      db.from('domains').select('*').order('created_at', { ascending: true }),
      db
        .from('organizations')
        .select('retention_days_website_visits, retention_days_signal_events, retention_dry_run')
        .eq('id', organizationId)
        .maybeSingle(),
      db.from('suppression_list').select('reason').eq('organization_id', organizationId),
    ]);
    if (domains.error) throw domains.error;
    if (org.error) throw org.error;
    if (suppression.error) throw suppression.error;

    const byReason: Record<string, number> = {};
    for (const row of suppression.data ?? []) {
      const reason = row.reason as string;
      byReason[reason] = (byReason[reason] ?? 0) + 1;
    }

    return {
      data: {
        domains: domains.data ?? [],
        retention: {
          websiteVisitsDays: org.data?.retention_days_website_visits ?? 90,
          signalEventsDays: org.data?.retention_days_signal_events ?? 90,
          dryRun: org.data?.retention_dry_run !== false,
        },
        suppression: { total: suppression.data?.length ?? 0, byReason },
      },
    };
  });

  // The immutable audit timeline (RLS-scoped, newest-first).
  app.get('/compliance/audit', async (request) => {
    const { db } = requireAuth(request);
    const { limit, offset } = AuditQuery.parse(request.query);
    const { data, error } = await db
      .from('audit_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw error;
    return { data: { events: data ?? [], limit, offset } };
  });

  // Verify a domain's SPF/DKIM/DMARC via a REAL DNS TXT lookup, then persist. RLS scopes the load to
  // the caller's org → a cross-org domain id resolves to nothing → 404 (never another tenant's domain).
  app.post('/domains/:id/verify', async (request, reply) => {
    const { db, organizationId, userId } = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const row = await verifyAndStoreDomainAuth(db, id, { dkimSelector: env.DKIM_SELECTOR });
    if (!row) return reply.code(404).send({ error: 'not_found' });
    await recordAuditSafe(getSupabaseAdmin(), {
      organizationId,
      kind: 'domain_verified',
      userId,
      args: {
        domain: row.domain,
        spf: row.spf_status,
        dkim: row.dkim_status,
        dmarc: row.dmarc_status,
      },
      source: 'user',
    });
    return { data: row };
  });
};
