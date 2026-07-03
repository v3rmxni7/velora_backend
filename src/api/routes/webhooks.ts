import type { FastifyPluginAsync } from 'fastify';
import { applySmartleadEvent } from '../../agents/sending/inbound.js';
import { env } from '../../config/env.js';
import { getSupabaseAdmin } from '../../db/client.js';
import {
  type SmartleadEvent,
  verifyPayloadSecret,
  verifySignature,
  verifyUrlToken,
} from '../../lib/smartlead-webhook.js';

// Smartlead webhook receiver (Phase 2 Slices 2.5 + 2.6; verification ground-truthed at go-live).
// PUBLIC (no JWT). Smartlead does not sign deliveries (see lib/smartlead-webhook.ts), so authenticity
// is ANY ONE of, all timing-safe against SMARTLEAD_WEBHOOK_SECRET:
//   1. `?token=` in the registered webhook URL (Smartlead support's recommended mechanism);
//   2. the `secret_key` field Smartlead echoes in the payload body (their documented mechanism);
//   3. a valid HMAC header over the raw body (legacy/bonus, if it ever really ships).
// Fail-closed: no secret configured → 503 and every event is dropped (RUNBOOK §7 hard prerequisite).
// The buffer content-type parser keeps the raw bytes for proof 3 (encapsulated: this plugin only).
// The route stays thin: verify → parse → applySmartleadEvent (service-role, org-scoped). Unknown
// events return 200 {handled:false} — a 4xx would make Smartlead mark the delivery permanently
// failed, and 5xx would trigger retry storms. Defense-in-depth: even a forged event can only touch
// an enrollment whose (smartlead_campaign_id, verified_email) pair it names (resolveTarget).
export const webhooksRoute: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body); // keep the raw Buffer; we parse after verifying authenticity
  });

  app.post('/webhooks/smartlead', async (request, reply) => {
    const secret = env.SMARTLEAD_WEBHOOK_SECRET;
    if (!secret) return reply.code(503).send({ error: 'webhook_unconfigured' });

    const raw = (request.body as Buffer | undefined)?.toString('utf8') ?? '';

    // Parse first (the payload's secret_key is one of the accepted proofs), verify before any use.
    let event: SmartleadEvent;
    try {
      event = JSON.parse(raw) as SmartleadEvent;
    } catch {
      return reply.code(400).send({ error: 'bad_json' });
    }

    const token = (request.query as { token?: string } | undefined)?.token;
    const sig = request.headers['x-smartlead-signature'];
    const authentic =
      verifyUrlToken(token, secret) ||
      verifyPayloadSecret(event.secret_key, secret) ||
      verifySignature(raw, Array.isArray(sig) ? sig[0] : sig, secret);
    if (!authentic) return reply.code(401).send({ error: 'unauthorized' });

    const db = getSupabaseAdmin();
    if (!db) return reply.code(503).send({ error: 'unavailable' });

    const { handled } = await applySmartleadEvent(db, event);
    return reply.code(200).send({ ok: true, handled });
  });
};
