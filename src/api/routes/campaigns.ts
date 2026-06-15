import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  ALL_CAMPAIGN_TYPES,
  assertSupportedCampaignType,
  launchCampaign,
} from '../../agents/sending/enroll.js';
import { authenticate, requireAuth } from '../middleware/auth.js';

const CreateCampaign = z.object({
  name: z.string().min(1).max(200),
  listId: z.uuid(),
  senderId: z.uuid().optional(),
  campaignType: z.enum(ALL_CAMPAIGN_TYPES).default('cold_outbound'),
});
const IdParam = z.object({ id: z.uuid() });
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
    const steps = await db
      .from('campaign_steps')
      .select('*')
      .eq('campaign_id', id)
      .order('step_number', { ascending: true });
    if (steps.error) throw steps.error;
    return { data: { ...c.data, steps: steps.data ?? [] } };
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
    if (!c.data.list_id) {
      return reply.code(400).send({ error: 'no_audience', message: 'Campaign has no list' });
    }
    const result = await launchCampaign(db, {
      id: c.data.id as string,
      organization_id: c.data.organization_id as string,
      list_id: c.data.list_id as string,
    });
    return { data: result };
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
