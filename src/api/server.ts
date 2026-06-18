import cors from '@fastify/cors';
import Fastify from 'fastify';
import inngestFastify from 'inngest/fastify';
import { ZodError } from 'zod';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { functions, inngest } from '../workers/inngest/index.js';
import { analyticsRoute } from './routes/analytics.js';
import { autonomyRoute } from './routes/autonomy.js';
import { campaignsRoute } from './routes/campaigns.js';
import { coachingPointsRoute } from './routes/coaching-points.js';
import { copilotRoute } from './routes/copilot.js';
import { creditsRoute } from './routes/credits.js';
import { deliverabilityRoute } from './routes/deliverability.js';
import { findLeadsRoute } from './routes/find-leads.js';
import { healthRoute } from './routes/health.js';
import { icpProfilesRoute } from './routes/icp-profiles.js';
import { inboxRoute } from './routes/inbox.js';
import { kbRoute } from './routes/kb.js';
import { leadsRoute } from './routes/leads.js';
import { listsRoute } from './routes/lists.js';
import { proofItemsRoute } from './routes/proof-items.js';
import { sendersRoute } from './routes/senders.js';
import { sendingRoute } from './routes/sending.js';
import { signalsRoute } from './routes/signals.js';
import { tasksRoute } from './routes/tasks.js';
import { webhooksRoute } from './routes/webhooks.js';

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
  await app.register(inboxRoute);
  await app.register(deliverabilityRoute);
  await app.register(creditsRoute);
  await app.register(analyticsRoute);
  await app.register(autonomyRoute);
  // Encapsulated so its raw-body parser stays scoped to the webhook route only.
  await app.register(webhooksRoute);
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
