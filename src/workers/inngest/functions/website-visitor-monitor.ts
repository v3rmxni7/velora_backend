import { runVisitorSweep } from '../../../agents/website-visitors/ingest.js';
import { getResolver } from '../../../agents/website-visitors/resolver.js';
import { env } from '../../../config/env.js';
import { getSupabaseAdmin } from '../../../db/client.js';
import { inngest } from '../client.js';

// Phase 4 Slice 4.6 — the website-visitor monitor. A cron sweep (every 10 min) that resolves pending
// website_visits → identified person/company lead (source='website_visitors') → enrollment (person
// only) into the tracked domain's website_visitor campaign, DRY-RUN-safe. concurrency:{limit:1} is the
// overlap guard (a cron has no event.data → the dedupeKey pattern doesn't apply); the per-visit CAS +
// the enrollment unique key give idempotency. getResolver(env) is null until a de-anon vendor is
// connected (🔌), so in prod this sweep is a documented NO-OP — visits accrue, nothing is resolved, the
// People/Companies tabs stay honestly empty. The logic lives in runVisitorSweep (a plain function tests
// call directly with a FakeResolver). Mirrors signal-monitor / anomaly-monitor.
export const websiteVisitorMonitor = inngest.createFunction(
  {
    id: 'website-visitor-monitor',
    concurrency: { limit: 1 },
    triggers: [{ cron: '*/10 * * * *' }],
  },
  async ({ step }) =>
    step.run('sweep', async () => {
      const db = getSupabaseAdmin();
      if (!db) throw new Error('Supabase admin client not configured');
      return runVisitorSweep(db, getResolver(env));
    }),
);
