import { events, inngest } from '../client.js';

// Stub: ingests replies from connected mailboxes.
export const inboxPoller = inngest.createFunction(
  {
    id: 'inbox-poller',
    idempotency: 'event.data.dedupeKey',
    triggers: [{ event: events.inboxPoll }],
  },
  async ({ event, step }) =>
    step.run('noop', async () => ({ ok: true, dedupeKey: event.data.dedupeKey })),
);
