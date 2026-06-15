import type { FastifyPluginAsync } from 'fastify';
import { applySmartleadEvent } from '../../agents/sending/inbound.js';
import { env } from '../../config/env.js';
import { getSupabaseAdmin } from '../../db/client.js';
import { type SmartleadEvent, verifySignature } from '../../lib/smartlead-webhook.js';

// Smartlead webhook receiver (Phase 2 Slices 2.5 + 2.6). PUBLIC (no JWT) — authenticity is the
// HMAC signature over the RAW body. Encapsulated plugin with a buffer content-type parser so the
// raw bytes are available for verification (and so this parser never affects other routes). The
// route stays thin: verify → parse → applySmartleadEvent (service-role, org-scoped). All event
// effects (sent/open/click + reply/bounce/unsubscribe) live in the inbound-event core.
export const webhooksRoute: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body); // keep the raw Buffer; we parse after verifying the signature
  });

  app.post('/webhooks/smartlead', async (request, reply) => {
    const secret = env.SMARTLEAD_WEBHOOK_SECRET;
    if (!secret) return reply.code(503).send({ error: 'webhook_unconfigured' });

    const raw = (request.body as Buffer | undefined)?.toString('utf8') ?? '';
    const sig = request.headers['x-smartlead-signature'];
    if (!verifySignature(raw, Array.isArray(sig) ? sig[0] : sig, secret)) {
      return reply.code(401).send({ error: 'bad_signature' });
    }

    let event: SmartleadEvent;
    try {
      event = JSON.parse(raw) as SmartleadEvent;
    } catch {
      return reply.code(400).send({ error: 'bad_json' });
    }

    const db = getSupabaseAdmin();
    if (!db) return reply.code(503).send({ error: 'unavailable' });

    const { handled } = await applySmartleadEvent(db, event);
    return reply.code(200).send({ ok: true, handled });
  });
};
