import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env.js';
import { getSupabaseAdmin } from '../../db/client.js';
import {
  eventToUpdate,
  type SmartleadEvent,
  verifySignature,
} from '../../lib/smartlead-webhook.js';

// Smartlead webhook receiver (Phase 2 Slice 2.5). PUBLIC (no JWT) — authenticity is the HMAC
// signature over the RAW body. Encapsulated plugin with a buffer content-type parser so the raw
// bytes are available for verification (and so this parser never affects other routes). Runs
// service-role; scoped to the org resolved from the campaign. Sent/open/click here; 2.6 adds
// reply/bounce/unsubscribe.
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

    const update = eventToUpdate(event.event_type);
    if (!update) return reply.code(200).send({ ok: true, handled: false }); // 2.6 events / unknown

    const db = getSupabaseAdmin();
    if (!db) return reply.code(503).send({ error: 'unavailable' });

    // Resolve our org + campaign from the Smartlead campaign id, then the lead's outbound message.
    const camp = await db
      .from('campaigns')
      .select('id, organization_id')
      .eq('smartlead_campaign_id', String(event.campaign_id))
      .maybeSingle();
    if (camp.error) throw camp.error;
    if (!camp.data) return reply.code(200).send({ ok: true, handled: false });
    const org = camp.data.organization_id as string;
    const recipient = event.to_email ?? event.lead_email;

    const enr = await db
      .from('enrollments')
      .select('id')
      .eq('organization_id', org)
      .eq('campaign_id', camp.data.id)
      .eq('verified_email', recipient ?? '')
      .maybeSingle();
    if (enr.error) throw enr.error;
    if (!enr.data) return reply.code(200).send({ ok: true, handled: false });

    const msgUpdate: Record<string, unknown> = { status: update.status };
    if (event.message_id) msgUpdate.smartlead_message_id = String(event.message_id);
    const m = await db
      .from('messages')
      .update(msgUpdate)
      .eq('organization_id', org)
      .eq('enrollment_id', enr.data.id)
      .eq('direction', 'outbound');
    if (m.error) throw m.error;

    if (update.enrollmentStatus) {
      await db
        .from('enrollments')
        .update({ status: update.enrollmentStatus })
        .eq('id', enr.data.id);
    }
    return reply.code(200).send({ ok: true, handled: true });
  });
};
