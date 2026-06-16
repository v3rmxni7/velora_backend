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
  draftGenerate: eventType('draft/generate', {
    schema: staticSchema<
      Dedupe & {
        organizationId: string;
        leadType: 'person' | 'company' | 'local_business';
        leadId: string;
        campaignId?: string;
      }
    >(),
  }),
  // Phase 3 Slice 3.2 — a follow-up step is due at `dueTs`. The consumer sleeps until then, then
  // re-checks + sends step `nextStep` (or halts). dedupeKey = `followup:${enrollmentId}:${nextStep}`.
  campaignFollowup: eventType('campaign/followup.due', {
    schema: staticSchema<
      Dedupe & { organizationId: string; enrollmentId: string; nextStep: number; dueTs: number }
    >(),
  }),
};

export const inngest = new Inngest({
  id: 'velora-backend',
  // Dev mode locally (works with `npx inngest-cli dev`, no keys); cloud mode in prod,
  // which is activated by setting INNGEST_SIGNING_KEY + registering the app (deferred).
  isDev: env.NODE_ENV !== 'production',
  ...(env.INNGEST_EVENT_KEY ? { eventKey: env.INNGEST_EVENT_KEY } : {}),
});
