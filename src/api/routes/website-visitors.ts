import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getResolver } from '../../agents/website-visitors/resolver.js';
import { env } from '../../config/env.js';
import { authenticate, requireAuth } from '../middleware/auth.js';

// Phase 4 Slice 4.6 — the AUTHED website-visitor surface: manage tracking domains (each with a public
// site_key the pixel embeds), link a domain to a website_visitor campaign, and read the honest summary
// (real anonymous-visit counts + identified counts + whether a de-anon resolver is connected). The
// PUBLIC pixel beacon lives in pixel.ts. Identified People/Companies rows are read directly from the
// org-scoped tables under RLS by the frontend; this surface provides the windowed counts.
const AddDomain = z.object({ domain: z.string().min(1).max(255) });
const IdParam = z.object({ id: z.uuid() });
const LinkBody = z.object({ campaignId: z.uuid() });

/** Normalize to a registrable host: lowercase, drop scheme + path + leading www. Best-effort. */
function normalizeDomain(raw: string): string {
  let d = raw.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  d = d.replace(/^www\./, '');
  return d;
}

/** A public, opaque site key. CSPRNG — `wv_` + 24 url-safe chars. */
function mintSiteKey(): string {
  return `wv_${randomBytes(18).toString('base64url')}`;
}

export const websiteVisitorsRoute: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticate);

  // List the org's tracking domains (RLS-scoped).
  app.get('/website-visitors/domains', async (request) => {
    const { db } = requireAuth(request);
    const { data, error } = await db
      .from('website_tracked_domains')
      .select('id, domain, site_key, campaign_id, verified_at, created_at')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return { data };
  });

  // Add a tracking domain + mint its public site_key.
  app.post('/website-visitors/domains', async (request, reply) => {
    const { db, organizationId } = requireAuth(request);
    const { domain } = AddDomain.parse(request.body);
    const normalized = normalizeDomain(domain);
    if (!normalized) return reply.code(400).send({ error: 'invalid_domain' });

    const ins = await db
      .from('website_tracked_domains')
      .insert({ organization_id: organizationId, domain: normalized, site_key: mintSiteKey() })
      .select('id, domain, site_key, campaign_id, verified_at, created_at')
      .single();
    if (ins.error) {
      if (ins.error.code === '23505') {
        return reply
          .code(409)
          .send({ error: 'domain_exists', message: 'That domain is already tracked.' });
      }
      throw ins.error;
    }
    return reply.code(201).send({ data: ins.data });
  });

  // Link a tracking domain to a website_visitor campaign (the identified-person enrollment target).
  app.post('/website-visitors/domains/:id/link', async (request, reply) => {
    const { db } = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const { campaignId } = LinkBody.parse(request.body);

    // RLS scopes the read to the caller's org → a cross-org campaign id returns nothing → 404.
    const camp = await db
      .from('campaigns')
      .select('id, campaign_type')
      .eq('id', campaignId)
      .maybeSingle();
    if (camp.error) throw camp.error;
    if (!camp.data) return reply.code(404).send({ error: 'campaign_not_found' });
    if (camp.data.campaign_type !== 'website_visitor') {
      return reply.code(422).send({
        error: 'not_visitor_campaign',
        message: 'A tracking domain can only feed a website_visitor campaign.',
      });
    }

    const upd = await db
      .from('website_tracked_domains')
      .update({ campaign_id: campaignId })
      .eq('id', id)
      .select('id, domain, site_key, campaign_id, verified_at, created_at')
      .maybeSingle();
    if (upd.error) throw upd.error;
    if (!upd.data) return reply.code(404).send({ error: 'not_found' });
    return { data: upd.data };
  });

  // Honest summary: REAL anonymous-visit counts (today/7d/30d) + identified counts + whether a de-anon
  // resolver is connected (false in this slice → the FE renders the "Identified" cards as honest-empty).
  app.get('/website-visitors/summary', async (request) => {
    const { db } = requireAuth(request);
    const now = Date.now();
    const startTodayMs = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00.000Z`);
    const ms7 = now - 7 * 86_400_000;
    const ms30 = now - 30 * 86_400_000;
    const since30 = new Date(ms30).toISOString();

    const [domains, visits, idents] = await Promise.all([
      db
        .from('website_tracked_domains')
        .select('id, domain, site_key, campaign_id, verified_at, created_at')
        .order('created_at', { ascending: false }),
      db.from('website_visits').select('created_at').gte('created_at', since30),
      db
        .from('website_visitor_identifications')
        .select('created_at, kind')
        .gte('created_at', since30),
    ]);
    if (domains.error) throw domains.error;
    if (visits.error) throw visits.error;
    if (idents.error) throw idents.error;

    const windowed = (rows: { created_at: string }[]) => {
      let today = 0;
      let d7 = 0;
      let d30 = 0;
      for (const r of rows) {
        const t = Date.parse(r.created_at);
        d30 += 1;
        if (t >= ms7) d7 += 1;
        if (t >= startTodayMs) today += 1;
      }
      return { today, d7, d30 };
    };

    return {
      data: {
        domains: domains.data ?? [],
        visitCounts: windowed((visits.data ?? []) as { created_at: string }[]),
        identifiedCounts: windowed((idents.data ?? []) as { created_at: string }[]),
        // getResolver is null until a de-anon vendor is connected (🔌) → false in this slice.
        resolverConnected: getResolver(env) !== null,
      },
    };
  });
};
