import { events, inngest } from '../client.js';

// Inbound events (reply / bounce / unsubscribe / complaint) are delivered by the Smartlead WEBHOOK —
// the single source of truth: src/api/routes/webhooks.ts → applySmartleadEvent (HMAC-verified). This
// pull-based poller is a DEFERRED fallback that intentionally no-ops today; it never silently ingests
// anything (so it can't fabricate a thread/reply). If a polling mode is ever needed, implement the fetch here.
export const inboxPoller = inngest.createFunction(
  {
    id: 'inbox-poller',
    idempotency: 'event.data.dedupeKey',
    triggers: [{ event: events.inboxPoll }],
  },
  async ({ event, step }) =>
    step.run('noop', async () => ({ ok: true, dedupeKey: event.data.dedupeKey })),
);
