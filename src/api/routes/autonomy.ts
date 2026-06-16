import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { getSupabaseAdmin } from '../../db/client.js';
import { recordAutonomyEvent } from '../../lib/autonomy-mode.js';
import { AppError } from '../../lib/errors.js';
import { authenticate, requireAuth } from '../middleware/auth.js';

// Phase 3 Slice 3.6a — the autonomy API surface the dashboard needs. READ the org's autonomy
// posture + the audit log, and a one-click PAUSE (the always-safe kill-switch direction). Turning
// autonomy ON / auto_reply_mode='send' stays a deliberate service-role/runbook act — there is no
// enable route here (mirrors the go-live sending flags having no UI toggle).
const EventsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const autonomyRoute: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticate);

  // Read the org's autonomy flags + the (env) guardrail thresholds the 3.5 monitor enforces.
  app.get('/autonomy', async (request) => {
    const { db, organizationId } = requireAuth(request);
    const { data, error } = await db
      .from('organizations')
      .select('autonomy_enabled, auto_send_min_confidence, auto_reply_mode')
      .eq('id', organizationId)
      .single();
    if (error) throw error;
    return {
      data: {
        autonomyEnabled: data.autonomy_enabled === true,
        autoSendMinConfidence: Number(data.auto_send_min_confidence),
        autoReplyMode: data.auto_reply_mode as 'off' | 'draft' | 'send',
        guardrails: {
          bounceRate: env.ANOMALY_BOUNCE_RATE,
          minSends: env.ANOMALY_MIN_SENDS,
          maxComplaints: env.ANOMALY_MAX_COMPLAINTS,
          windowHours: env.ANOMALY_WINDOW_HOURS,
        },
      },
    };
  });

  // The audit log — every autonomous decision + auto/manual pause. RLS scopes to the caller's org.
  app.get('/autonomy/events', async (request) => {
    const { db } = requireAuth(request);
    const { limit, offset } = EventsQuery.parse(request.query);
    const { data, error, count } = await db
      .from('autonomy_events')
      .select('id, kind, decision, reason, confidence, enrollment_id, task_id, created_at', {
        count: 'exact',
      })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw error;
    return { data: { events: data ?? [], count: count ?? 0, limit, offset } };
  });

  // The one-click kill switch — the ONLY write, and only the safe direction (true→false). Uses the
  // service-role client (organizations has no authenticated UPDATE policy) scoped to the CALLER'S
  // OWN org (id from the verified JWT, never the body). Idempotent; a flip is audited.
  app.post('/autonomy/pause', async (request) => {
    const { organizationId } = requireAuth(request);
    const admin = getSupabaseAdmin();
    if (!admin)
      throw new AppError('Service-role client unavailable', {
        code: 'admin_unavailable',
        statusCode: 503,
      });
    const cas = await admin
      .from('organizations')
      .update({ autonomy_enabled: false })
      .eq('id', organizationId)
      .eq('autonomy_enabled', true)
      .select('id');
    if (cas.error) throw cas.error;
    const paused = (cas.data ?? []).length > 0;
    if (paused) {
      await recordAutonomyEvent(admin, {
        organizationId,
        kind: 'auto_pause',
        decision: 'auto_pause',
        reason: 'manual_pause',
      });
    }
    return { data: { autonomyEnabled: false, paused } };
  });
};
