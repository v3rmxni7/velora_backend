import { campaignExecutor } from './functions/campaign-executor.js';
import { enrichment } from './functions/enrichment.js';
import { inboxPoller } from './functions/inbox-poller.js';
import { warmupMonitor } from './functions/warmup-monitor.js';

export { inngest } from './client.js';

// Registered with the Inngest serve handler (mounted in Phase 1).
export const functions = [campaignExecutor, warmupMonitor, inboxPoller, enrichment];
