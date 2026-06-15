import type { FastifyPluginAsync } from 'fastify';
import { getSendingMode } from '../../lib/sending-mode.js';
import { authenticate, requireAuth } from '../middleware/auth.js';

// Read-only observability of the org's sending master switches. No write route — flipping
// the flags on is privileged (service-role / a deliberate admin surface in a later slice).
export const sendingRoute: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticate);

  app.get('/sending/mode', async (request) => {
    const { db, organizationId } = requireAuth(request);
    const mode = await getSendingMode(db, organizationId);
    return { data: mode };
  });
};
