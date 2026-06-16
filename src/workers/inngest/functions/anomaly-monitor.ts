import { runAnomalySweep } from '../../../agents/sending/anomaly.js';
import { env } from '../../../config/env.js';
import { getSupabaseAdmin } from '../../../db/client.js';
import { inngest } from '../client.js';

// Phase 3 Slice 3.5 — the self-protection monitor. A cron sweep (every 15 min) that auto-pauses
// autonomy for any org breaching its sending-health thresholds. concurrency:{limit:1} is the
// overlap guard — a cron fires with no event.data, so the dedupeKey idempotency pattern doesn't
// apply; limit:1 guarantees two sweeps never run at once. The logic lives in runAnomalySweep (a
// plain function tests call directly). It only ever halts (autonomy true→false), never enables.
export const anomalyMonitor = inngest.createFunction(
  {
    id: 'anomaly-monitor',
    concurrency: { limit: 1 },
    triggers: [{ cron: '*/15 * * * *' }],
  },
  async ({ step }) =>
    step.run('sweep', async () => {
      const db = getSupabaseAdmin();
      if (!db) throw new Error('Supabase admin client not configured');
      return runAnomalySweep(
        db,
        {
          maxBounceRate: env.ANOMALY_BOUNCE_RATE,
          minSends: env.ANOMALY_MIN_SENDS,
          maxComplaints: env.ANOMALY_MAX_COMPLAINTS,
        },
        env.ANOMALY_WINDOW_HOURS,
      );
    }),
);
