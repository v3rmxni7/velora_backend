import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getSupabaseAdmin } from '../../db/client.js';
import { recordAuditSafe } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { type EnvReadinessFacts, gatherReadiness } from '../../lib/go-live-readiness.js';
import { getSendingMode } from '../../lib/sending-mode.js';
import { authenticate, requireAuth, requireRole } from '../middleware/auth.js';

// Sending master switches + the PRODUCTIZED go-live (S1). The two-flag flip stays a service-role act:
// these routes gate (owner-only + typed org-name confirm + server-side readiness re-check) and then
// write via the SERVICE-ROLE client — organizations has NO authenticated UPDATE policy, exactly like
// /autonomy/pause. Nothing here auto-fires; only a deliberate owner POST flips the flags.
const GoLiveBody = z.object({ confirm: z.string() });

// `readinessEnv` is injectable ONLY so integration tests can drive readiness deterministically without
// mutating the frozen env; in production it is undefined and gatherReadiness reads the real env.
interface SendingRouteOptions {
  readinessEnv?: EnvReadinessFacts;
}

export const sendingRoute: FastifyPluginAsync<SendingRouteOptions> = async (app, opts) => {
  app.addHook('preHandler', authenticate);

  // Read-only: the org's sending master switches.
  app.get('/sending/mode', async (request) => {
    const { db, organizationId } = requireAuth(request);
    const mode = await getSendingMode(db, organizationId);
    return { data: mode };
  });

  // Read-only: the go-live readiness checklist + the required confirm phrase (the org name) + the
  // current mode. Same gatherReadiness the go-live POST re-runs server-side.
  app.get('/sending/readiness', async (request) => {
    const { db, organizationId } = requireAuth(request);
    const [readiness, mode, org] = await Promise.all([
      gatherReadiness(db, organizationId, opts.readinessEnv),
      getSendingMode(db, organizationId),
      db.from('organizations').select('name').eq('id', organizationId).maybeSingle(),
    ]);
    if (org.error) throw org.error;
    return {
      data: { ...readiness, confirmPhrase: (org.data?.name as string | null) ?? '', mode },
    };
  });

  // ★ PRODUCTIZED GO-LIVE. OWNER only. Deliberate, human-triggered, never auto-fired. Fences, in order:
  //  1. requireRole owner  2. org from the JWT (never the body)  3. typed confirm === the org NAME
  //  (matched SERVER-side)  4. full readiness RE-CHECK server-side (409 if any prereq red)  5. a
  //  service-role compare-and-swap that only flips from a NOT-live state (dry_run=true) → idempotent
  //  "already live" no-op otherwise  6. audited sending_go_live.
  //  The readiness re-check sits IMMEDIATELY before the CAS (minimal window); anything that changes
  //  AFTER the flip is caught by the per-send fail-closed guards at runtime — notably the L1
  //  compliance guard, which independently blocks a live send if the postal address is later cleared.
  app.post('/sending/go-live', async (request, reply) => {
    const { db, organizationId, userId } = requireAuth(request);
    requireRole(request, ['owner']);
    const { confirm } = GoLiveBody.parse(request.body);

    const org = await db
      .from('organizations')
      .select('name')
      .eq('id', organizationId)
      .maybeSingle();
    if (org.error) throw org.error;
    if (!org.data) return reply.code(404).send({ error: 'not_found' });

    // Typed confirmation matched SERVER-side against the org name (resolved from the JWT-scoped org,
    // never the request). A stale/blank/other-org phrase cannot flip.
    if (confirm !== org.data.name) {
      throw new AppError('Confirmation phrase does not match the organization name', {
        code: 'confirm_mismatch',
        statusCode: 400,
      });
    }

    // Server-side readiness re-check — the client's view is never trusted past a red prereq.
    const readiness = await gatherReadiness(db, organizationId, opts.readinessEnv);
    if (!readiness.ready) {
      return reply.code(409).send({ error: 'not_ready', data: readiness });
    }

    const admin = getSupabaseAdmin();
    if (!admin) {
      throw new AppError('Service-role client unavailable', {
        code: 'admin_unavailable',
        statusCode: 503,
      });
    }

    // Compare-and-swap on the safe expected value: flip ONLY from a not-live state (dry_run=true).
    // Covers first go-live (enabled=false,dry_run=true) AND re-go-live after a pause
    // (enabled=true,dry_run=true). If already live (dry_run=false) → 0 rows → honest no-op.
    const cas = await admin
      .from('organizations')
      .update({ sending_enabled: true, sending_dry_run: false })
      .eq('id', organizationId)
      .eq('sending_dry_run', true)
      .select('id');
    if (cas.error) throw cas.error;

    if ((cas.data ?? []).length === 0) {
      return { data: { status: 'already_live', mode: await getSendingMode(db, organizationId) } };
    }

    await recordAuditSafe(admin, {
      organizationId,
      kind: 'sending_go_live',
      userId,
      source: 'user',
      args: { via: 'productized' },
    });
    return { data: { status: 'went_live', mode: await getSendingMode(db, organizationId) } };
  });

  // Pause live sending — the always-safe reverse (dry_run → true). OWNER only (starting AND stopping
  // live sending stays with the accountable owner). No typed confirm (safe direction). Service-role
  // CAS; audited sending_paused. The AUTOMATIC anomaly monitor pauses autonomy separately.
  app.post('/sending/pause-live', async (request) => {
    const { db, organizationId, userId } = requireAuth(request);
    requireRole(request, ['owner']);
    const admin = getSupabaseAdmin();
    if (!admin) {
      throw new AppError('Service-role client unavailable', {
        code: 'admin_unavailable',
        statusCode: 503,
      });
    }
    const cas = await admin
      .from('organizations')
      .update({ sending_dry_run: true })
      .eq('id', organizationId)
      .eq('sending_dry_run', false)
      .select('id');
    if (cas.error) throw cas.error;
    const paused = (cas.data ?? []).length > 0;
    if (paused) {
      await recordAuditSafe(admin, {
        organizationId,
        kind: 'sending_paused',
        userId,
        source: 'user',
      });
    }
    return {
      data: {
        status: paused ? 'paused' : 'already_paused',
        mode: await getSendingMode(db, organizationId),
      },
    };
  });
};
