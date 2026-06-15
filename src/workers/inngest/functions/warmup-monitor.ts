import { refreshMailboxWarmup } from '../../../agents/sending/mailbox-sync.js';
import { getSupabaseAdmin } from '../../../db/client.js';
import { createSmartleadClient } from '../../../integrations/smartlead/smartlead.js';
import { events, inngest } from '../client.js';

// Refresh one mailbox's warmup reputation from Smartlead (service-role write; org from payload).
// Idempotent per dedupeKey; a mailbox with no Smartlead link is a no-op.
export const warmupMonitor = inngest.createFunction(
  {
    id: 'warmup-monitor',
    idempotency: 'event.data.dedupeKey',
    triggers: [{ event: events.warmupCheck }],
  },
  async ({ event, step }) =>
    step.run('refresh-warmup', async () => {
      const db = getSupabaseAdmin();
      if (!db) throw new Error('Supabase admin client not configured');
      const { mailboxId } = event.data;
      const result = await refreshMailboxWarmup(db, createSmartleadClient(), mailboxId);
      return { ok: result.ok, mailboxId };
    }),
);
