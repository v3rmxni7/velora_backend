import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { getSupabaseAdmin } from '../../db/client.js';
import {
  buildAuthorizeUrl,
  configurableProviders,
  getCrmOAuthCreds,
  isCrmProvider,
} from '../../integrations/crm/client.js';
import { AppError } from '../../lib/errors.js';
import { signState } from '../../lib/oauth-state.js';
import { authenticate, requireAuth } from '../middleware/auth.js';

// Phase 4 Slice 4.7 — the AUTHED CRM connections surface. Read the org's connection metadata (REDACTED
// — never a token), start an OAuth connect (gated on configured creds → honest 'not_configured'),
// disconnect, and link a connected CRM to a warm_outbound/cross_sell campaign (the enrollment target).
// The PUBLIC OAuth callback lives in integrations-oauth.ts (its own plugin, never auth-gated). Tokens
// live ONLY in the service-role integration_secrets vault — this surface never reads or returns them.
const ProviderParam = z.object({ provider: z.string() });
const LinkBody = z.object({ campaignId: z.uuid() });

function requestOrigin(request: FastifyRequest): string {
  const proto =
    (request.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() ??
    request.protocol ??
    'https';
  const host =
    (request.headers['x-forwarded-host'] as string | undefined) ?? request.headers.host ?? '';
  return `${proto}://${host}`;
}

function admin() {
  const db = getSupabaseAdmin();
  if (!db)
    throw new AppError('Service-role client unavailable', {
      code: 'admin_unavailable',
      statusCode: 503,
    });
  return db;
}

export const integrationsRoute: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticate);

  // Read the org's CRM connections — REDACTED metadata only (no token column exists on integrations).
  // RLS scopes to the caller's org; configurableProviders reflects which CRMs have app creds set.
  app.get('/integrations', async (request) => {
    const { db } = requireAuth(request);
    const { data, error } = await db
      .from('integrations')
      .select('kind, provider, status, last_synced_at, error, campaign_id')
      .eq('kind', 'crm')
      .order('provider', { ascending: true });
    if (error) throw error;
    return {
      data: { integrations: data ?? [], configurableProviders: configurableProviders(env) },
    };
  });

  // Start an OAuth connect. Creds absent → honest 422 not_configured (no row, no fake). Configured →
  // a 'pending' integration + a signed single-use state, return the provider authorize URL.
  app.post('/integrations/crm/:provider/connect', async (request, reply) => {
    const { organizationId } = requireAuth(request);
    const { provider } = ProviderParam.parse(request.params);
    if (!isCrmProvider(provider)) return reply.code(400).send({ error: 'unknown_provider' });
    const creds = getCrmOAuthCreds(env, provider);
    if (!creds || !env.OAUTH_STATE_SECRET) {
      return reply.code(422).send({
        error: 'not_configured',
        message: 'This CRM is not available yet (app credentials not configured).',
      });
    }
    const db = admin();
    const intg = await db
      .from('integrations')
      .upsert(
        { organization_id: organizationId, kind: 'crm', provider, status: 'pending', error: null },
        { onConflict: 'organization_id,kind,provider' },
      )
      .select('id')
      .single();
    if (intg.error) throw intg.error;

    const { state, nonce, exp } = signState(organizationId, provider, env.OAUTH_STATE_SECRET);
    const sec = await db.from('integration_secrets').upsert(
      {
        integration_id: intg.data.id,
        organization_id: organizationId,
        oauth_state: { nonce, exp },
      },
      { onConflict: 'integration_id' },
    );
    if (sec.error) throw sec.error;

    // Must EXACTLY match the redirect_uri used at token exchange + the one registered on the app.
    const redirectUri =
      env.HUBSPOT_REDIRECT_URI ?? `${requestOrigin(request)}/integrations/crm/callback`;
    return { data: { authorizeUrl: buildAuthorizeUrl(provider, creds, redirectUri, state) } };
  });

  // Disconnect — flip to 'disconnected' + destroy the secrets (tokens + state). Idempotent.
  app.post('/integrations/crm/:provider/disconnect', async (request, reply) => {
    const { organizationId } = requireAuth(request);
    const { provider } = ProviderParam.parse(request.params);
    if (!isCrmProvider(provider)) return reply.code(400).send({ error: 'unknown_provider' });
    const db = admin();
    const intg = await db
      .from('integrations')
      .update({ status: 'disconnected', error: null })
      .eq('organization_id', organizationId)
      .eq('kind', 'crm')
      .eq('provider', provider)
      .select('id')
      .maybeSingle();
    if (intg.error) throw intg.error;
    if (intg.data) {
      await db.from('integration_secrets').delete().eq('integration_id', intg.data.id);
    }
    return { data: { provider, status: 'disconnected' } };
  });

  // Link a connected CRM to the warm_outbound/cross_sell campaign its synced contacts enroll into.
  app.post('/integrations/crm/:provider/link', async (request, reply) => {
    const { db, organizationId } = requireAuth(request);
    const { provider } = ProviderParam.parse(request.params);
    if (!isCrmProvider(provider)) return reply.code(400).send({ error: 'unknown_provider' });
    const { campaignId } = LinkBody.parse(request.body);

    // RLS scopes the read to the caller's org → a cross-org campaign id returns nothing → 404.
    const camp = await db
      .from('campaigns')
      .select('id, campaign_type')
      .eq('id', campaignId)
      .maybeSingle();
    if (camp.error) throw camp.error;
    if (!camp.data) return reply.code(404).send({ error: 'campaign_not_found' });
    if (camp.data.campaign_type !== 'warm_outbound' && camp.data.campaign_type !== 'cross_sell') {
      return reply.code(422).send({
        error: 'not_crm_campaign',
        message: 'A CRM can only feed a warm_outbound or cross_sell campaign.',
      });
    }

    const upd = await admin()
      .from('integrations')
      .update({ campaign_id: campaignId })
      .eq('organization_id', organizationId)
      .eq('kind', 'crm')
      .eq('provider', provider)
      .select('id')
      .maybeSingle();
    if (upd.error) throw upd.error;
    if (!upd.data) return reply.code(404).send({ error: 'not_connected' });
    return { data: { provider, campaignId } };
  });
};
