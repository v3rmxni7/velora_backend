import { runCrmSync } from '../../../agents/crm/sync.js';
import { env } from '../../../config/env.js';
import { getSupabaseAdmin } from '../../../db/client.js';
import { getCrmClient } from '../../../integrations/crm/client.js';
import { inngest } from '../client.js';

// Phase 4 Slice 4.7 — the CRM sync monitor. A cron sweep (every 30 min) that pulls PERSON contacts
// from connected CRM integrations → source='crm' leads → DRY-RUN enrollment into the connection's
// linked warm_outbound/cross_sell campaign. concurrency:{limit:1} is the overlap guard (a cron has no
// event.data → the dedupeKey pattern doesn't apply); the enrollment unique key gives idempotency.
// getCrmClient(env,...) is null until a real CRM is connected (🔌), so in prod this sweep is a
// documented NO-OP — nothing syncs, warm/cross_sell stay honestly source-not-connected. The logic
// lives in runCrmSync (a plain function tests call directly with a FakeCrmClient). Mirrors
// signal-monitor / website-visitor-monitor.
export const crmSyncMonitor = inngest.createFunction(
  {
    id: 'crm-sync-monitor',
    concurrency: { limit: 1 },
    triggers: [{ cron: '*/30 * * * *' }],
  },
  async ({ step }) =>
    step.run('sweep', async () => {
      const db = getSupabaseAdmin();
      if (!db) throw new Error('Supabase admin client not configured');
      // Prod factory: bind a persist callback (service-role) so a rotated HubSpot refresh_token is
      // written back to THIS integration's vault row. Fires only when the token actually rotates.
      return runCrmSync(db, (provider, oauth, integrationId) =>
        getCrmClient(env, provider, oauth, {
          persist: async (o) => {
            // Check the write: supabase-js does NOT throw on a DB error, so an unchecked update would
            // SILENTLY drop a rotated refresh_token (the in-memory token advances, the vault keeps the
            // stale one → the next sweep 400s). Throw so runCrmSync records status='error' (visible,
            // token-free) and the tenant is prompted to reconnect, instead of a silent break.
            const { error } = await db
              .from('integration_secrets')
              .update({ oauth: o })
              .eq('integration_id', integrationId);
            if (error) throw error;
          },
        }),
      );
    }),
);
