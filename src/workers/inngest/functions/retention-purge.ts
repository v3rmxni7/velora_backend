import { runRetentionPurge } from '../../../agents/compliance/retention.js';
import { getSupabaseAdmin } from '../../../db/client.js';
import { inngest } from '../client.js';

// Phase 4 Slice 4.12 — data-retention purge. A daily cron that ages out anonymous/transient telemetry
// (website_visits + processed/failed signal_events) per each org's retention window. DRY-RUN-FIRST:
// while an org's retention_dry_run flag is on (default), the sweep REPORTS + audits the would-purge
// counts and deletes NOTHING; only a deliberate flip enables real deletion. concurrency:{limit:1} is
// the overlap guard. The logic lives in runRetentionPurge (a plain function tests call directly).
// Mirrors anomaly-monitor / signal-monitor / website-visitor-monitor.
export const retentionPurge = inngest.createFunction(
  {
    id: 'retention-purge',
    concurrency: { limit: 1 },
    triggers: [{ cron: '0 2 * * *' }], // daily at 02:00 UTC
  },
  async ({ step }) =>
    step.run('purge', async () => {
      const db = getSupabaseAdmin();
      if (!db) throw new Error('Supabase admin client not configured');
      return runRetentionPurge(db);
    }),
);
