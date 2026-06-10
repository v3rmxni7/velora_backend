import { ingestDocument } from '../../../agents/kb/ingest.js';
import { getSupabaseAdmin } from '../../../db/client.js';
import { events, inngest } from '../client.js';

// Idempotent KB ingestion: scrape → chunk → embed → store. Writes via the
// service-role client (trusted backend job); org is scoped by the event payload.
export const kbIngest = inngest.createFunction(
  {
    id: 'kb-ingest',
    idempotency: 'event.data.dedupeKey',
    triggers: [{ event: events.kbIngest }],
  },
  async ({ event, step }) =>
    step.run('ingest', async () => {
      const db = getSupabaseAdmin();
      if (!db) throw new Error('Supabase admin client not configured');
      const { organizationId, sourceUrl } = event.data;
      return ingestDocument({ db, organizationId, sourceUrl });
    }),
);
