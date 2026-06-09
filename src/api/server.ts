import cors from '@fastify/cors';
import Fastify from 'fastify';
import { env } from '../config/env.js';
import { healthRoute } from './routes/health.js';

const app = Fastify({ logger: true });

async function start(): Promise<void> {
  await app.register(cors, { origin: env.CORS_ORIGIN });
  await app.register(healthRoute);
  await app.listen({ port: env.PORT, host: env.HOST });
}

start().catch((err) => {
  app.log.error(err);
  process.exit(1);
});

export { app };
