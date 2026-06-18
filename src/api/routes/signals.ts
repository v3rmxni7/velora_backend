import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireAuth } from '../middleware/auth.js';

// Phase 4 Slice 4.5 — the intent-signal catalog surface. READ the shared SPEC §3.9 catalog merged
// with the org's subscription state, and subscribe/unsubscribe a LIVE signal to an intent_signals
// campaign. Subscribing is gated on the signal being live (the catalog's live/coming-soon split is
// real, not cosmetic) and the campaign being the caller's own intent_signals campaign (RLS already
// blocks cross-org reads). Real feeds that fill signal_events are 🔌 deferred; there is no public
// inject route here.
const IdParam = z.object({ id: z.uuid() });
const Subscribe = z.object({ campaignId: z.uuid() });

export const signalsRoute: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticate);

  // The shared catalog (all 11) + this org's subscription state per signal. signal_definitions is a
  // read-to-authenticated shared table; signal_subscriptions is RLS-scoped to the caller's org.
  app.get('/signals', async (request) => {
    const { db } = requireAuth(request);
    const [defs, subs] = await Promise.all([
      db
        .from('signal_definitions')
        .select('id, key, category, name, description, status')
        .order('category', { ascending: true })
        .order('name', { ascending: true }),
      db.from('signal_subscriptions').select('signal_definition_id, campaign_id, active'),
    ]);
    if (defs.error) throw defs.error;
    if (subs.error) throw subs.error;
    const byDef = new Map((subs.data ?? []).map((s) => [s.signal_definition_id as string, s]));
    const data = (defs.data ?? []).map((d) => {
      const sub = byDef.get(d.id as string);
      const subscribed = !!sub && sub.active === true;
      return {
        ...d,
        subscribed,
        campaignId: subscribed ? (sub?.campaign_id as string) : null,
      };
    });
    return { data };
  });

  // Subscribe a LIVE signal to an intent_signals campaign. Re-subscribing upserts (switches the
  // target campaign / re-activates). 422 if the signal isn't live or the campaign isn't an
  // intent_signals campaign the caller owns. Future signal_events for this signal enroll into it.
  app.post('/signals/:id/subscribe', async (request, reply) => {
    const { db, organizationId } = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const { campaignId } = Subscribe.parse(request.body);

    const def = await db.from('signal_definitions').select('id, status').eq('id', id).maybeSingle();
    if (def.error) throw def.error;
    if (!def.data) return reply.code(404).send({ error: 'not_found' });
    if (def.data.status !== 'live') {
      return reply.code(422).send({
        error: 'signal_not_live',
        message: 'This signal is not available yet.',
      });
    }

    // RLS scopes the read to the caller's org, so a cross-org campaign id returns nothing → 404.
    const camp = await db
      .from('campaigns')
      .select('id, campaign_type')
      .eq('id', campaignId)
      .maybeSingle();
    if (camp.error) throw camp.error;
    if (!camp.data) return reply.code(404).send({ error: 'campaign_not_found' });
    if (camp.data.campaign_type !== 'intent_signals') {
      return reply.code(422).send({
        error: 'not_intent_campaign',
        message: 'Signals can only feed an intent_signals campaign.',
      });
    }

    const up = await db
      .from('signal_subscriptions')
      .upsert(
        {
          organization_id: organizationId,
          signal_definition_id: id,
          campaign_id: campaignId,
          active: true,
        },
        { onConflict: 'organization_id,signal_definition_id' },
      )
      .select('signal_definition_id, campaign_id, active')
      .single();
    if (up.error) throw up.error;
    return { data: { ...up.data, subscribed: true } };
  });

  // Unsubscribe — a SOFT active=false (the row persists so re-subscribing is one click; stopping a
  // live campaign now is a separate campaign pause). Idempotent.
  app.post('/signals/:id/unsubscribe', async (request, reply) => {
    const { db } = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const upd = await db
      .from('signal_subscriptions')
      .update({ active: false })
      .eq('signal_definition_id', id)
      .select('signal_definition_id');
    if (upd.error) throw upd.error;
    if ((upd.data ?? []).length === 0) {
      return reply.code(404).send({ error: 'not_subscribed' });
    }
    return { data: { signal_definition_id: id, subscribed: false } };
  });
};
