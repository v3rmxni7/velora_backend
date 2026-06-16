import { campaignExecutor } from './functions/campaign-executor.js';
import { campaignFollowup } from './functions/campaign-followup.js';
import { draftGenerate } from './functions/draft-generate.js';
import { enrichment } from './functions/enrichment.js';
import { inboxPoller } from './functions/inbox-poller.js';
import { kbIngest } from './functions/kb-ingest.js';
import { warmupMonitor } from './functions/warmup-monitor.js';

export { inngest } from './client.js';

// Registered with the Inngest serve handler (mounted later).
export const functions = [
  campaignExecutor,
  campaignFollowup,
  warmupMonitor,
  inboxPoller,
  enrichment,
  kbIngest,
  draftGenerate,
];
