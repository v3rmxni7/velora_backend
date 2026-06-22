import cors from '@fastify/cors';
import Fastify from 'fastify';
import inngestFastify from 'inngest/fastify';
import { ZodError } from 'zod';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { functions, inngest } from '../workers/inngest/index.js';
import { analyticsRoute } from './routes/analytics.js';
import { authRoute } from './routes/auth.js';
import { autonomyRoute } from './routes/autonomy.js';
import { billingRoute } from './routes/billing.js';
import { campaignsRoute } from './routes/campaigns.js';
import { coachingPointsRoute } from './routes/coaching-points.js';
import { complianceRoute } from './routes/compliance.js';
import { copilotRoute } from './routes/copilot.js';
import { creditsRoute } from './routes/credits.js';
import { deliverabilityRoute } from './routes/deliverability.js';
import { dialerRoute } from './routes/dialer.js';
import { findLeadsRoute } from './routes/find-leads.js';
import { healthRoute } from './routes/health.js';
import { icpProfilesRoute } from './routes/icp-profiles.js';
import { inboxRoute } from './routes/inbox.js';
import { integrationsRoute } from './routes/integrations.js';
import { integrationsOAuthRoute } from './routes/integrations-oauth.js';
import { kbRoute } from './routes/kb.js';
import { leadsRoute } from './routes/leads.js';
import { listsRoute } from './routes/lists.js';
import { pixelRoute } from './routes/pixel.js';
import { proofItemsRoute } from './routes/proof-items.js';
import { questsRoute } from './routes/quests.js';
import { sendersRoute } from './routes/senders.js';
import { sendingRoute } from './routes/sending.js';
import { signalsRoute } from './routes/signals.js';
import { tasksRoute } from './routes/tasks.js';
import { teamRoute } from './routes/team.js';
import { webhooksRoute } from './routes/webhooks.js';
import { websiteVisitorsRoute } from './routes/website-visitors.js';

const app = Fastify({ logger: true });

app.setErrorHandler((err, request, reply) => {
  if (err instanceof ZodError) {
    reply.code(400).send({ error: 'bad_request', issues: err.issues });
    return;
  }
  if (err instanceof AppError) {
    reply.code(err.statusCode).send({ error: err.code, message: err.message });
    return;
  }
  // Framework-level errors (e.g. body over the limit → Fastify's 413) carry their own 4xx
  // statusCode. Honor the STATUS so the client sees the correct code (413/415/…) instead of a
  // misleading 500 — but send a SAFE generic code, never err.message, which for some upstream
  // errors could echo internal detail (audit F-RT3).
  const sc = (err as { statusCode?: number }).statusCode;
  if (typeof sc === 'number' && sc >= 400 && sc < 500) {
    reply.code(sc).send({ error: sc === 413 ? 'payload_too_large' : 'request_rejected' });
    return;
  }
  request.log.error(err);
  reply.code(500).send({ error: 'internal_error' });
});

async function start(): Promise<void> {
  // CORS_ORIGIN: '*' (default, local dev) | one origin | comma-separated list
  // (e.g. Vercel prod + previews). Bearer-header auth — no credentials needed.
  const corsOrigin = env.CORS_ORIGIN.includes(',')
    ? env.CORS_ORIGIN.split(',').map((s) => s.trim())
    : env.CORS_ORIGIN;
  await app.register(cors, { origin: corsOrigin });
  await app.register(healthRoute);
  await app.register(kbRoute);
  await app.register(coachingPointsRoute);
  await app.register(proofItemsRoute);
  await app.register(icpProfilesRoute);
  await app.register(findLeadsRoute);
  await app.register(listsRoute);
  await app.register(leadsRoute);
  await app.register(tasksRoute);
  await app.register(copilotRoute);
  await app.register(sendingRoute);
  await app.register(sendersRoute);
  await app.register(campaignsRoute);
  await app.register(signalsRoute);
  await app.register(websiteVisitorsRoute);
  await app.register(integrationsRoute);
  await app.register(teamRoute);
  await app.register(dialerRoute);
  await app.register(inboxRoute);
  await app.register(deliverabilityRoute);
  await app.register(creditsRoute);
  await app.register(questsRoute);
  await app.register(billingRoute);
  await app.register(complianceRoute);
  await app.register(analyticsRoute);
  await app.register(autonomyRoute);
  // Self-serve signup / accept-invite — its own plugin (validates the JWT but tolerates an orgless
  // user; never inherits the org-requiring `authenticate`).
  await app.register(authRoute);
  // Encapsulated so its raw-body parser stays scoped to the webhook route only.
  await app.register(webhooksRoute);
  // PUBLIC pixel (no JWT) — a GET image beacon + the tracker script. Registered separately like the
  // webhook; it resolves the org from the site_key (never the request) and only ever writes an
  // anonymous visit. A GET image beacon sidesteps CORS entirely.
  await app.register(pixelRoute);
  // PUBLIC OAuth callback (no JWT) — its own plugin so it never inherits the authed integrations
  // route's `authenticate` hook. Resolves the org from a signed, single-use state, never the query.
  await app.register(integrationsOAuthRoute);
  // Inngest serve handler at /api/inngest — makes async jobs (draft-generate, and the
  // Phase-2 campaign/warmup/inbox functions) runnable. The async draft path calls the
  // SAME runDraftGeneration as the sync /tasks/generate-sync route; both coexist.
  await app.register(inngestFastify, { client: inngest, functions });
  await app.listen({ port: env.PORT, host: env.HOST });
}

start().catch((err) => {
  app.log.error(err);
  process.exit(1);
});

export { app };
