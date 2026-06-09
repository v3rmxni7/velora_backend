import { events, inngest } from '../client.js';

// Stub: enriches a lead via a data provider. Idempotency-keyed so a retry never
// double-charges the provider or the credit_ledger.
export const enrichment = inngest.createFunction(
  {
    id: 'enrichment',
    idempotency: 'event.data.dedupeKey',
    triggers: [{ event: events.leadEnrich }],
  },
  async ({ event, step }) =>
    step.run('noop', async () => ({ ok: true, dedupeKey: event.data.dedupeKey })),
);
