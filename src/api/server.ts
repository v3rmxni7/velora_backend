import cors from '@fastify/cors';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { coachingPointsRoute } from './routes/coaching-points.js';
import { healthRoute } from './routes/health.js';
import { icpProfilesRoute } from './routes/icp-profiles.js';
import { kbRoute } from './routes/kb.js';
import { proofItemsRoute } from './routes/proof-items.js';

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
  await app.register(cors, { origin: env.CORS_ORIGIN });
  await app.register(healthRoute);
  await app.register(kbRoute);
  await app.register(coachingPointsRoute);
  await app.register(proofItemsRoute);
  await app.register(icpProfilesRoute);
  await app.listen({ port: env.PORT, host: env.HOST });
}

start().catch((err) => {
  app.log.error(err);
  process.exit(1);
});

export { app };
