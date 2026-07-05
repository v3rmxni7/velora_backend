import { runSendRedrive } from '../../../agents/sending/redrive.js';
import { getSupabaseAdmin } from '../../../db/client.js';
import { inngest } from '../client.js';

// Send-redrive sweep — every 15 min, re-drive approved sends that DEFERRED (rate_limited /
// campaign_paused / sender_paused / insufficient_credit) so they complete once the block clears,
// instead of stranding forever. concurrency:{limit:1} is the overlap guard (a cron has no event.data
// so the dedupeKey pattern doesn't apply); executeSend's own dedupe-key claim additionally makes any
// re-drive at-most-once. All gates + the two-flag dry-run invariant are re-enforced per attempt.
export const sendRedrive = inngest.createFunction(
  {
    id: 'send-redrive',
    concurrency: { limit: 1 },
    triggers: [{ cron: '*/15 * * * *' }],
  },
  async ({ step }) =>
    step.run('sweep', async () => {
      const db = getSupabaseAdmin();
      if (!db) throw new Error('Supabase admin client not configured');
      return runSendRedrive(db);
    }),
);
