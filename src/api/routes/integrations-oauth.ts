import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { env } from '../../config/env.js';
import { getSupabaseAdmin } from '../../db/client.js';
import {
  exchangeOAuthCode,
  getCrmOAuthCreds,
  isCrmProvider,
} from '../../integrations/crm/client.js';
import { verifyState } from '../../lib/oauth-state.js';

// Phase 4 Slice 4.7 — the PUBLIC OAuth callback (no JWT). Its OWN encapsulated plugin, registered
// separately+last (like pixel.ts / webhooks.ts) so it NEVER inherits the authed integrations route's
// `authenticate` preHandler. The org rides a SIGNED state (HMAC), verified + SINGLE-USE-consumed here
// (a replayed/expired/used state is rejected — CSRF/replay-safe); the org is resolved from the state,
// never the query. The code→token exchange is GATED on configured creds (HubSpot is REAL as of T1 —
// a null result → status='error', never a fake 'connected'/token). Absent creds, /connect returns
// 'not_configured' first, so this callback stays dormant (the demo/unconfigured posture).

function frontendOrigin(request: FastifyRequest): string {
  const c = env.CORS_ORIGIN;
  if (c && c !== '*') return c.split(',')[0]?.trim() ?? '';
  // dev fallback (only hit when CORS is wide-open; at go-live CORS_ORIGIN is the Vercel app origin)
  const proto =
    (request.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() ??
    request.protocol ??
    'https';
  return `${proto}://${request.headers.host ?? ''}`;
}

export const integrationsOAuthRoute: FastifyPluginAsync = async (app) => {
  app.get('/integrations/crm/callback', async (request, reply) => {
    const q = request.query as { code?: string; state?: string; error?: string };
    const fe = frontendOrigin(request);
    const back = (status: string) => reply.redirect(`${fe}/connections?status=${status}`);

    if (!q.state || !env.OAUTH_STATE_SECRET) return reply.code(400).send({ error: 'bad_request' });
    const payload = verifyState(q.state, env.OAUTH_STATE_SECRET);
    if (!payload || !isCrmProvider(payload.provider)) {
      return reply.code(401).send({ error: 'bad_state' });
    }
    const { organizationId, provider, nonce } = payload;

    const db = getSupabaseAdmin();
    if (!db) return reply.code(503).send({ error: 'unavailable' });

    // Load the pending integration + its stored single-use nonce (org from the SIGNED state, not the query).
    const intg = await db
      .from('integrations')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('kind', 'crm')
      .eq('provider', provider)
      .maybeSingle();
    if (intg.error) throw intg.error;
    if (!intg.data) return reply.code(401).send({ error: 'bad_state' });

    const sec = await db
      .from('integration_secrets')
      .select('oauth_state')
      .eq('integration_id', intg.data.id)
      .maybeSingle();
    if (sec.error) throw sec.error;
    const stored = (sec.data?.oauth_state ?? null) as { nonce?: string; exp?: number } | null;
    // Single-use: the stored nonce must match + still exist (a consumed/expired/replayed state is rejected).
    if (!stored || stored.nonce !== nonce || (stored.exp ?? 0) < Date.now()) {
      return reply.code(401).send({ error: 'bad_state' });
    }
    // Consume the nonce immediately (single-use).
    await db
      .from('integration_secrets')
      .update({ oauth_state: null })
      .eq('integration_id', intg.data.id);

    // User denied at the provider.
    if (q.error || !q.code) {
      await db.from('integrations').update({ status: 'disconnected' }).eq('id', intg.data.id);
      return back('denied');
    }

    // Exchange code→token (HubSpot real in T1). redirect_uri MUST exactly match the connect + the app.
    const redirectUri =
      env.HUBSPOT_REDIRECT_URI ??
      `${request.protocol}://${request.headers.host ?? ''}/integrations/crm/callback`;
    const creds = getCrmOAuthCreds(env, provider);
    const result = creds ? await exchangeOAuthCode(env, provider, q.code, redirectUri) : null;
    if (!result) {
      await db
        .from('integrations')
        .update({ status: 'error', error: 'token_exchange_unavailable' })
        .eq('id', intg.data.id);
      return back('error');
    }

    // (Go-live) store tokens in the service-role vault, mark connected.
    await db
      .from('integration_secrets')
      .update({ oauth: result.oauth })
      .eq('integration_id', intg.data.id);
    await db
      .from('integrations')
      .update({ status: 'connected', error: null })
      .eq('id', intg.data.id);
    return back('connected');
  });
};
