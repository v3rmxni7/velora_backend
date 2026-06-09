import type { FastifyPluginAsync } from 'fastify';

const VERSION = '0.1.0';

export const healthRoute: FastifyPluginAsync = async (app) => {
  app.get('/health', async () => ({
    status: 'ok',
    uptime: process.uptime(),
    version: VERSION,
  }));
};
