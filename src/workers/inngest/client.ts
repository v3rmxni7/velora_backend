import { eventType, Inngest, staticSchema } from 'inngest';
import { env } from '../../config/env.js';

// Every event payload carries `dedupeKey` so the function-level idempotency
// expression ('event.data.dedupeKey') resolves against a real, typed property.
// `staticSchema` gives compile-time types with no runtime validation dependency.
type Dedupe = { dedupeKey: string };

export const events = {
  campaignExecute: eventType('campaign/execute', {
    schema: staticSchema<Dedupe & { organizationId: string; campaignId: string }>(),
  }),
  warmupCheck: eventType('mailbox/warmup.check', {
    schema: staticSchema<Dedupe & { organizationId: string; mailboxId: string }>(),
  }),
  inboxPoll: eventType('inbox/poll', {
    schema: staticSchema<Dedupe & { organizationId: string; senderId: string }>(),
  }),
  leadEnrich: eventType('lead/enrich', {
    schema: staticSchema<Dedupe & { organizationId: string; leadId: string }>(),
  }),
  kbIngest: eventType('kb/ingest', {
    schema: staticSchema<Dedupe & { organizationId: string; sourceUrl: string }>(),
  }),
};

export const inngest = new Inngest({
  id: 'velora-backend',
  ...(env.INNGEST_EVENT_KEY ? { eventKey: env.INNGEST_EVENT_KEY } : {}),
});
