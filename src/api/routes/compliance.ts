import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { verifyAndStoreDomainAuth } from '../../agents/compliance/dns-verify.js';
import { env } from '../../config/env.js';
import { getSupabaseAdmin } from '../../db/client.js';
import { recordAuditSafe } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { authenticate, requireAuth, requireRole } from '../middleware/auth.js';

const IdParam = z.object({ id: z.uuid() });
// The postal address is trimmed; an empty string clears it (→ live sends fail closed again). Capped
// to a sane length for a footer line.
const PostalAddressBody = z.object({ postalAddress: z.string().trim().max(500) });
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
        .select(
          'retention_days_website_visits, retention_days_signal_events, retention_dry_run, postal_address',
        )
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
        // CAN-SPAM physical address injected into every live send; null → live sends fail closed.
        postalAddress: (org.data?.postal_address as string | null) ?? null,
      },
    };
  });

  // Set (or clear) the org's physical postal address. OWNER/ADMIN only, and written via the
  // SERVICE-ROLE client — organizations has NO authenticated UPDATE policy (same posture as the
  // two-flag sending columns), so this route is the ONLY authorized write path. It touches postal_address
  // ALONE (never a sending flag). A blank value clears it → live sends fail closed again. Audited.
  app.patch('/compliance/postal-address', async (request) => {
    const { organizationId, userId } = requireAuth(request);
    requireRole(request, ['owner', 'admin']);
    const { postalAddress } = PostalAddressBody.parse(request.body);
    const value = postalAddress.length > 0 ? postalAddress : null;
    const admin = getSupabaseAdmin();
    if (!admin) {
      throw new AppError('Service-role client unavailable', {
        code: 'admin_unavailable',
        statusCode: 503,
      });
    }
    const { error } = await admin
      .from('organizations')
      .update({ postal_address: value })
      .eq('id', organizationId);
    if (error) throw error;
    await recordAuditSafe(admin, {
      organizationId,
      kind: 'postal_address_updated',
      userId,
      args: { set: value !== null },
      source: 'user',
    });
    return { data: { postalAddress: value } };
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
