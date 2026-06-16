import { AppError } from '../../lib/errors.js';
import type { SmartleadClient, SmartleadEmailAccount, SmartleadWarmupStats } from './types.js';

// A clearly-labeled, NON-functional Smartlead client, used ONLY when no SMARTLEAD_API_KEY is set
// (dev/demo). It simulates the READ surfaces so mailbox sync + warmth populate through the REAL
// classifyWarmth path, and REFUSES every write/send so it can never fake a real send or provision a
// campaign. createSmartleadClient() returns this when no key is present; a real key yields the real
// client, making this code unreachable. Nothing here ever touches the real Smartlead API.

// Sentinel id + reserved-TLD address make the demo mailbox unmistakable in the UI/DB — it can never
// be confused with a real synced account. `.example` is reserved + non-deliverable (RFC 2606).
export const SANDBOX_ACCOUNT_ID = 'sandbox-1';
export const SANDBOX_FROM_EMAIL = 'ava@demo.example';

/** Every write/send method routes here — the sandbox physically cannot perform a real action. */
function refuse(action: string): never {
  throw new AppError(
    `sandbox Smartlead client cannot ${action} (no SMARTLEAD_API_KEY configured)`,
    {
      code: 'smartlead_sandbox',
      statusCode: 503,
    },
  );
}

export function createSandboxSmartleadClient(): SmartleadClient {
  return {
    // ---- read: simulate one unmistakably-demo, warm-able account ----
    async listEmailAccounts(): Promise<SmartleadEmailAccount[]> {
      return [
        {
          id: SANDBOX_ACCOUNT_ID,
          from_email: SANDBOX_FROM_EMAIL,
          from_name: 'Ava (demo)',
          type: 'SANDBOX', // → mapProvider 'unknown'
          max_email_per_day: 50,
          warmup_details: { status: 'ACTIVE' }, // → mapWarmupStatus 'warming' on first sync
        },
      ];
    },
    async getWarmupStats(): Promise<SmartleadWarmupStats> {
      // Clears the real classifyWarmth thresholds (sent >= 100, spamRate <= 0.05) → the demo mailbox
      // is promoted to 'warm' THROUGH the real warmth logic, not hard-set.
      return { sent_count: 120, inbox_count: 118, spam_count: 0 };
    },

    // ---- write / send: refuse (never fake a real send or provision) ----
    async createCampaign() {
      return refuse('create a campaign');
    },
    async saveSequence() {
      return refuse('save a sequence');
    },
    async assignEmailAccounts() {
      return refuse('assign email accounts');
    },
    async setSchedule() {
      return refuse('set a schedule');
    },
    async setStatus() {
      return refuse('set campaign status');
    },
    async addLead() {
      return refuse('push a lead (send)');
    },
    async sendReply() {
      return refuse('send a reply');
    },
  };
}
