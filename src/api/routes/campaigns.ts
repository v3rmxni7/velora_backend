import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  ALL_CAMPAIGN_TYPES,
  assertSupportedCampaignType,
  launchCampaign,
} from '../../agents/sending/enroll.js';
import { events, inngest } from '../../workers/inngest/client.js';
import { authenticate, requireAuth } from '../middleware/auth.js';

const CreateCampaign = z.object({
  name: z.string().min(1).max(200),
  listId: z.uuid(),
  senderId: z.uuid().optional(),
  campaignType: z.enum(ALL_CAMPAIGN_TYPES).default('cold_outbound'),
});
const IdParam = z.object({ id: z.uuid() });
const StepInput = z.object({
  delayDays: z.coerce.number().int().min(0).max(365),
  bodyMode: z.enum(['ai_grounded', 'template']),
  subjectTemplate: z.string().max(300).nullish(),
});
const PutSteps = z.object({ steps: z.array(StepInput).min(1).max(20) });
const VariantInput = z.object({
  label: z.string().min(1).max(80),
  angle: z.string().min(1).max(300),
});
const PutVariants = z.object({ variants: z.array(VariantInput).min(1).max(4) });
const EnrollmentQuery = z.object({
  status: z
    .enum([
      'pending',
      'queued',
      'awaiting_approval',
      'sent',
      'replied',
      'bounced',
      'unsubscribed',
      'completed',
      'failed',
    ])
    .optional(),
});

// Campaigns surface (Phase 2 Slice 2.2): create/list/get + launch (enroll the list) + pause.
// No drafts, no sends — launch only produces pending enrollments for the 2.3 pipeline.
export const campaignsRoute: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticate);

  app.post('/campaigns', async (request, reply) => {
    const { db, organizationId } = requireAuth(request);
    const body = CreateCampaign.parse(request.body);
    assertSupportedCampaignType(body.campaignType);

    const list = await db.from('lists').select('id').eq('id', body.listId).maybeSingle();
    if (list.error) throw list.error;
    if (!list.data) return reply.code(404).send({ error: 'list_not_found' });

    const campaign = await db
      .from('campaigns')
      .insert({
        organization_id: organizationId,
        sender_id: body.senderId ?? null,
        name: body.name,
        campaign_type: body.campaignType,
        list_id: body.listId,
        status: 'draft',
      })
      .select('*')
      .single();
    if (campaign.error) throw campaign.error;

    // Pilot: a single auto-created step 1 (multi-step editing is a later slice).
    const step = await db.from('campaign_steps').insert({
      organization_id: organizationId,
      campaign_id: campaign.data.id,
      step_number: 1,
      channel: 'email',
      delay_days: 0,
      body_mode: 'ai_grounded',
    });
    if (step.error) throw step.error;

    return reply.code(201).send({ data: campaign.data });
  });

  app.get('/campaigns', async (request) => {
    const { db } = requireAuth(request);
    const { data, error } = await db
      .from('campaigns')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return { data };
  });

  app.get('/campaigns/:id', async (request, reply) => {
    const { db } = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const c = await db.from('campaigns').select('*').eq('id', id).maybeSingle();
    if (c.error) throw c.error;
    if (!c.data) return reply.code(404).send({ error: 'not_found' });
    const [steps, variants] = await Promise.all([
      db
        .from('campaign_steps')
        .select('*')
        .eq('campaign_id', id)
        .order('step_number', { ascending: true }),
      db
        .from('campaign_variants')
        .select('*')
        .eq('campaign_id', id)
        .order('label', { ascending: true }),
    ]);
    if (steps.error) throw steps.error;
    if (variants.error) throw variants.error;
    return { data: { ...c.data, steps: steps.data ?? [], variants: variants.data ?? [] } };
  });

  app.post('/campaigns/:id/launch', async (request, reply) => {
    const { db } = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const c = await db
      .from('campaigns')
      .select('id, organization_id, list_id, campaign_type')
      .eq('id', id)
      .maybeSingle();
    if (c.error) throw c.error;
    if (!c.data) return reply.code(404).send({ error: 'not_found' });
    assertSupportedCampaignType(c.data.campaign_type as string);
    // Cold needs a list; non-cold types resolve their audience elsewhere (or honestly report
    // source-not-connected via launchCampaign) — so the no-list guard is cold-only.
    if (c.data.campaign_type === 'cold_outbound' && !c.data.list_id) {
      return reply.code(400).send({ error: 'no_audience', message: 'Campaign has no list' });
    }
    const result = await launchCampaign(db, {
      id: c.data.id as string,
      organization_id: c.data.organization_id as string,
      list_id: c.data.list_id as string | null,
      campaign_type: c.data.campaign_type as string,
    });
    // Only kick the executor when an audience was actually enrolled (a non-cold source-not-connected
    // launch enrolled nothing and the campaign stayed draft — there is nothing to prepare).
    if (result.sourceConnected) {
      try {
        await inngest.send({
          name: events.campaignExecute.name,
          data: {
            organizationId: c.data.organization_id as string,
            campaignId: c.data.id as string,
            dedupeKey: `campaign:${c.data.id}:launch`,
          },
        });
      } catch (err) {
        request.log.warn({ err, campaignId: id }, 'campaign/execute enqueue failed (non-fatal)');
      }
    }
    return { data: result };
  });

  // Author the sequence (4.3): REPLACE the whole ordered step list. The follow-up sequencer reads
  // campaign_steps by step_number, which must be contiguous (1..N) — a replace guarantees that and
  // makes reorder/add/delete atomic. Draft-only: editing a launched campaign's sequence is locked
  // (an in-flight enrollment must not have its steps mutated underneath it).
  app.put('/campaigns/:id/steps', async (request, reply) => {
    const { db, organizationId } = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const body = PutSteps.parse(request.body);
    const c = await db.from('campaigns').select('id, status').eq('id', id).maybeSingle();
    if (c.error) throw c.error;
    if (!c.data) return reply.code(404).send({ error: 'not_found' });
    if (c.data.status !== 'draft') {
      return reply.code(422).send({
        error: 'sequence_locked',
        message: 'The sequence can only be edited while the campaign is a draft.',
      });
    }
    const del = await db.from('campaign_steps').delete().eq('campaign_id', id);
    if (del.error) throw del.error;
    const rows = body.steps.map((s, i) => ({
      organization_id: organizationId,
      campaign_id: id,
      step_number: i + 1,
      channel: 'email',
      delay_days: s.delayDays,
      body_mode: s.bodyMode,
      subject_template: s.subjectTemplate ?? null,
    }));
    const ins = await db
      .from('campaign_steps')
      .insert(rows)
      .select('*')
      .order('step_number', { ascending: true });
    if (ins.error) throw ins.error;
    return { data: ins.data };
  });

  // Author the A/Z variants (4.4): REPLACE the whole list, draft-only. Variants steer the angle Ava
  // writes (a coaching line), never fabricated copy. Locked once launched so a live cohort's ordered
  // anchor never shifts (a re-assignment would reshuffle which lead is in which variant).
  app.put('/campaigns/:id/variants', async (request, reply) => {
    const { db, organizationId } = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const body = PutVariants.parse(request.body);
    const c = await db.from('campaigns').select('id, status').eq('id', id).maybeSingle();
    if (c.error) throw c.error;
    if (!c.data) return reply.code(404).send({ error: 'not_found' });
    if (c.data.status !== 'draft') {
      return reply.code(422).send({
        error: 'variants_locked',
        message: 'Variants can only be edited while the campaign is a draft.',
      });
    }
    const del = await db.from('campaign_variants').delete().eq('campaign_id', id);
    if (del.error) throw del.error;
    const rows = body.variants.map((v) => ({
      organization_id: organizationId,
      campaign_id: id,
      label: v.label,
      angle: v.angle,
    }));
    const ins = await db
      .from('campaign_variants')
      .insert(rows)
      .select('*')
      .order('label', { ascending: true });
    if (ins.error) throw ins.error;
    return { data: ins.data };
  });

  app.get('/campaigns/:id/enrollments', async (request) => {
    const { db } = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const { status } = EnrollmentQuery.parse(request.query);
    let q = db.from('enrollments').select('*').eq('campaign_id', id);
    if (status) q = q.eq('status', status);
    const { data, error } = await q.order('created_at', { ascending: false });
    if (error) throw error;
    return { data };
  });

  app.post('/campaigns/:id/pause', async (request, reply) => {
    const { db } = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const { data, error } = await db
      .from('campaigns')
      .update({ status: 'paused' })
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) return reply.code(404).send({ error: 'not_found' });
    return { data };
  });
};
