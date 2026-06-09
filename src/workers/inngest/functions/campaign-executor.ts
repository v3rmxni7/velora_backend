import { events, inngest } from '../client.js';

// Stub: sends the next step of a campaign. Idempotency-keyed so a retry never
// double-emails a prospect.
export const campaignExecutor = inngest.createFunction(
  {
    id: 'campaign-executor',
    idempotency: 'event.data.dedupeKey',
    triggers: [{ event: events.campaignExecute }],
  },
  async ({ event, step }) =>
    step.run('noop', async () => ({ ok: true, dedupeKey: event.data.dedupeKey })),
);
