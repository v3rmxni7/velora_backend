import { events, inngest } from '../client.js';

// Stub: polls mailbox warmup state / reputation.
export const warmupMonitor = inngest.createFunction(
  {
    id: 'warmup-monitor',
    idempotency: 'event.data.dedupeKey',
    triggers: [{ event: events.warmupCheck }],
  },
  async ({ event, step }) =>
    step.run('noop', async () => ({ ok: true, dedupeKey: event.data.dedupeKey })),
);
