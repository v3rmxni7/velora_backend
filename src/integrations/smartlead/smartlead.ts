import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { createSandboxSmartleadClient } from './sandbox.js';
import type {
  SmartleadClient,
  SmartleadEmailAccount,
  SmartleadLead,
  SmartleadReply,
  SmartleadWarmupStats,
} from './types.js';

/** Smartlead's list endpoint returns an array; tolerate a {data:[...]} envelope too. */
export function normalizeAccountsResponse(body: unknown): SmartleadEmailAccount[] {
  const arr = Array.isArray(body) ? body : (body as { data?: unknown } | null)?.data;
  return Array.isArray(arr) ? (arr as SmartleadEmailAccount[]) : [];
}

// Bound a hung-but-not-down Smartlead. undici fetch has no default timeout; on a silent socket the
// abort rejects → caught → honest 502 smartlead_error. On the live cold-send push (executeSend → addLead)
// this routes a hang into the existing send_push_failed path rather than leaving the enrollment stuck
// 'queued' forever — the claim-before-push row still gates against any double-send. Audit: resilience/low.
const SMARTLEAD_TIMEOUT_MS = 20_000;

// Smartlead client (mirrors the scraper/embeddings adapter pattern): factory that validates the
// key, uses global fetch, passes ?api_key=, and throws AppError on misconfig/HTTP. Read methods
// (2.1) + write methods (2.5). Injectable — tests pass a fake.
export function createSmartleadClient(): SmartleadClient {
  if (!env.SMARTLEAD_API_KEY) {
    // Dev/demo with no key: a clearly-labeled sandbox client that simulates the READ surfaces
    // (mailbox sync + warmth) and refuses every real send/provision. A real key falls through to
    // the real client below, making the sandbox unreachable — it never touches the go-live flow.
    return createSandboxSmartleadClient();
  }
  const apiKey = env.SMARTLEAD_API_KEY;
  const base = env.SMARTLEAD_API_URL.replace(/\/+$/, '');

  function url(path: string, params: Record<string, string> = {}): URL {
    const u = new URL(`${base}${path}`);
    u.searchParams.set('api_key', apiKey);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u;
  }
  async function get(path: string, params: Record<string, string> = {}): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(url(path, params), {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(SMARTLEAD_TIMEOUT_MS),
      });
    } catch {
      throw new AppError('Smartlead is unreachable', { code: 'smartlead_error', statusCode: 502 });
    }
    if (!res.ok) {
      throw new AppError(`Smartlead request failed (${res.status})`, {
        code: 'smartlead_error',
        statusCode: 502,
      });
    }
    return res.json();
  }
  async function send(method: 'POST' | 'PATCH', path: string, body: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(url(path), {
        method,
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SMARTLEAD_TIMEOUT_MS),
      });
    } catch {
      throw new AppError(`Smartlead ${method} ${path} is unreachable`, {
        code: 'smartlead_error',
        statusCode: 502,
      });
    }
    if (!res.ok) {
      throw new AppError(`Smartlead ${method} ${path} failed (${res.status})`, {
        code: 'smartlead_error',
        statusCode: 502,
      });
    }
    return res.json().catch(() => ({}));
  }

  return {
    // ---- read (2.1) ----
    async listEmailAccounts(): Promise<SmartleadEmailAccount[]> {
      return normalizeAccountsResponse(
        await get('/email-accounts/', { offset: '0', limit: '100' }),
      );
    },
    async getWarmupStats(emailAccountId): Promise<SmartleadWarmupStats> {
      return (await get(`/email-accounts/${emailAccountId}/warmup-stats`)) as SmartleadWarmupStats;
    },

    // ---- write (2.5) ----
    async createCampaign(name: string): Promise<{ id: string }> {
      const res = (await send('POST', '/campaigns/create', { name, client_id: null })) as {
        id?: string | number;
      };
      if (res.id == null) {
        throw new AppError('Smartlead createCampaign returned no id', {
          code: 'smartlead_error',
          statusCode: 502,
        });
      }
      return { id: String(res.id) };
    },
    async saveSequence(campaignId, subjectVar, bodyVar): Promise<void> {
      await send('POST', `/campaigns/${campaignId}/sequences`, [
        {
          seq_number: 1,
          seq_delay_details: { delay_in_days: 0 },
          variant_distribution_type: 'MANUALLY_EQUAL',
          variants: [{ subject: subjectVar, email_body: bodyVar, variant_label: 'A' }],
        },
      ]);
    },
    async assignEmailAccounts(campaignId, emailAccountIds): Promise<void> {
      await send('POST', `/campaigns/${campaignId}/email-accounts`, {
        email_account_ids: emailAccountIds,
      });
    },
    async setSchedule(campaignId, maxLeadsPerDay): Promise<void> {
      await send('POST', `/campaigns/${campaignId}/schedule`, {
        timezone: 'America/New_York',
        days_of_the_week: [1, 2, 3, 4, 5],
        start_hour: '09:00',
        end_hour: '17:00',
        min_time_btw_emails: 10,
        max_leads_per_day: maxLeadsPerDay,
      });
    },
    async setStatus(campaignId, status): Promise<void> {
      await send('PATCH', `/campaigns/${campaignId}/status`, { status });
    },
    async addLead(campaignId, lead: SmartleadLead): Promise<void> {
      // Idempotency note (C1): the AUTHORITATIVE same-send guard is Velora's claim-before-push in
      // executeSend (the send:{org}:{enr}:{step} message row gates this call). Smartlead is a
      // secondary layer: re-adding an existing email to the SAME campaign updates the lead's custom
      // fields rather than creating a second lead/send (its default same-campaign de-dup); the flags
      // below only govern global block/unsubscribe/bounce lists and cross-campaign duplicates. There
      // is no Smartlead flag that re-enables same-campaign duplication, so we do not rely on one.
      await send('POST', `/campaigns/${campaignId}/leads`, {
        lead_list: [lead],
        settings: {
          ignore_global_block_list: false,
          ignore_unsubscribe_list: false,
          ignore_community_bounce_list: false,
          ignore_duplicate_leads_in_other_campaign: false,
        },
      });
    },
    async sendReply(campaignId, reply: SmartleadReply): Promise<void> {
      // In-thread reply via the master-inbox API. Idempotency note (C1): the AUTHORITATIVE
      // same-send guard is Velora's claim-before-push in executeReplySend (the reply_send:{org}:
      // {task} message row gates this call). Exact payload verified at go-live (the dry-run path
      // never reaches here).
      await send('POST', `/campaigns/${campaignId}/reply-email-thread`, {
        email_stats_id: reply.inReplyToMessageId,
        email_body: reply.body,
        reply_email_body: reply.body,
        to_email: reply.email,
        subject: reply.subject ?? '',
      });
    },
  };
}
