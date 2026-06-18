import { runSignalSweep } from '../../../agents/signals/ingest.js';
import { getSupabaseAdmin } from '../../../db/client.js';
import { inngest } from '../client.js';

// Phase 4 Slice 4.5 — the signal monitor. A cron sweep (every 5 min) that processes pending
// signal_events → person lead (source='signals') → enrollment into the subscription's intent
// campaign, DRY-RUN-safe. concurrency:{limit:1} is the overlap guard (a cron has no event.data, so
// the dedupeKey pattern doesn't apply); the per-event status CAS + the enrollment unique key give
// idempotency. A paused campaign leaves its event pending → retried next sweep (no lost events). The
// logic lives in runSignalSweep (a plain function tests call directly). Mirrors anomaly-monitor.
export const signalMonitor = inngest.createFunction(
  {
    id: 'signal-monitor',
    concurrency: { limit: 1 },
    triggers: [{ cron: '*/5 * * * *' }],
  },
  async ({ step }) =>
    step.run('sweep', async () => {
      const db = getSupabaseAdmin();
      if (!db) throw new Error('Supabase admin client not configured');
      return runSignalSweep(db);
    }),
);
