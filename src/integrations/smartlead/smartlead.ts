import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { createSandboxSmartleadClient } from './sandbox.js';
import type {
  SmartleadEmailAccount,
  SmartleadLead,
  SmartleadProvisioningClient,
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
export function createSmartleadClient(): SmartleadProvisioningClient {
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
      // Surface Smartlead's own error body (truncated) — self-diagnosing, like the Apollo adapter.
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        /* ignore body read failure */
      }
      throw new AppError(`Smartlead ${path} failed (${res.status})${detail ? `: ${detail}` : ''}`, {
        code: 'smartlead_error',
        statusCode: res.status === 429 ? 429 : 502,
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
      // Surface Smartlead's own error body (truncated) so a real provisioning/send failure is
      // self-diagnosing rather than an opaque "(502)". Mirrors the Apollo adapter.
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        /* ignore body read failure */
      }
      throw new AppError(
        `Smartlead ${method} ${path} failed (${res.status})${detail ? `: ${detail}` : ''}`,
        { code: 'smartlead_error', statusCode: res.status === 429 ? 429 : 502 },
      );
    }
    return res.json().catch(() => ({}));
  }

  // Credential-bearing calls (mailbox connect + warmup) must NEVER surface Smartlead's raw response
  // body in an error: if Smartlead ever echoed the submitted password/username back in a validation
  // error, the generic send() path (which truncates the body into the AppError message) would leak
  // it. sendNoEcho reads NO response body on failure — a status-only, generic error — and the request
  // body (which holds the password) is never logged. Used only by createEmailAccount / enableWarmup.
  async function sendNoEcho(path: string, body: unknown, action: string): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(url(path), {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SMARTLEAD_TIMEOUT_MS),
      });
    } catch {
      throw new AppError(`Smartlead is unreachable while trying to ${action}`, {
        code: 'smartlead_error',
        statusCode: 502,
      });
    }
    if (!res.ok) {
      throw new AppError(`Smartlead could not ${action} (${res.status})`, {
        code: 'smartlead_error',
        // Preserve 406 (Smartlead's ACCOUNT_VERIFICATION_FAILED = bad SMTP/IMAP creds, verified live) +
        // 429 so callers can tell "the customer's creds are wrong" from "the provider is down". The
        // response body is NEVER read (it may echo the password) — only the status code.
        statusCode: res.status === 429 ? 429 : res.status === 406 ? 406 : 502,
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

    // ---- mailbox connect (S3) ----
    // POST /email-accounts/save (upsert; omit `id` → create). The password is pass-through: mapped to
    // Smartlead's `password` and sent ONCE — never returned to the caller, never logged. We read only
    // data.id + the connection-validation flags from the response. Uses sendNoEcho so a Smartlead
    // error can't echo the credential. (Bare path — url() adds /api/v1 base + ?api_key=.)
    async createEmailAccount(input) {
      type SaveRes = {
        id?: number | string;
        is_smtp_success?: boolean;
        is_imap_success?: boolean;
        data?: { id?: number | string; is_smtp_success?: boolean; is_imap_success?: boolean };
      };
      let res: SaveRes;
      try {
        res = (await sendNoEcho(
          '/email-accounts/save',
          {
            from_name: input.fromName,
            from_email: input.fromEmail,
            user_name: input.userName, // NOTE: `user_name` with underscore (Smartlead gotcha)
            password: input.password, // pass-through — the only place the secret is used
            smtp_host: input.smtpHost,
            smtp_port: input.smtpPort,
            imap_host: input.imapHost,
            imap_port: input.imapPort,
            warmup_enabled: true,
            type: 'SMTP',
            ...(input.maxEmailPerDay ? { max_email_per_day: input.maxEmailPerDay } : {}),
          },
          'connect the mailbox',
        )) as SaveRes;
      } catch (e) {
        // Bad SMTP/IMAP creds → Smartlead returns HTTP 406 (ACCOUNT_VERIFICATION_FAILED) — verified
        // live, NOT the assumed 200+is_smtp_success:false. Surface it as a clean bad-creds result so the
        // route returns 422 ("check host/port + app password"), never a 502 provider-outage error. The
        // response body is never read (it may echo the password) — the 406 status alone drives this.
        if (e instanceof AppError && e.statusCode === 406) {
          return { id: '', smtpOk: false, imapOk: false };
        }
        throw e;
      }
      // Defensive: the reference example wraps in `data`, but tolerate a top-level id too.
      const id = res.data?.id ?? res.id;
      if (id == null) {
        throw new AppError('Smartlead did not return an email-account id', {
          code: 'smartlead_error',
          statusCode: 502,
        });
      }
      // Absent flag → treat as ok (older API); only an explicit false is a validation failure.
      return {
        id: String(id),
        smtpOk: (res.data?.is_smtp_success ?? res.is_smtp_success) !== false,
        imapOk: (res.data?.is_imap_success ?? res.is_imap_success) !== false,
      };
    },
    async enableWarmup(emailAccountId): Promise<void> {
      // Dedicated warmup endpoint (the authoritative path); safe recommended defaults.
      await sendNoEcho(
        `/email-accounts/${emailAccountId}/warmup`,
        {
          warmup_enabled: true,
          total_warmup_per_day: 20,
          daily_rampup: 2,
          reply_rate_percentage: 30,
        },
        'enable warmup',
      );
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
      // Smartlead's CURRENT contract (verified live 2026-07-06): the body is an OBJECT
      // { sequences: [...] } (a bare array 400s "value must be of type object"); variants live under
      // `seq_variants` (`variants` 400s "not allowed"); and variant_distribution_type is
      // 'MANUAL_EQUAL' ('MANUALLY_EQUAL' 406s "Unsupported value").
      await send('POST', `/campaigns/${campaignId}/sequences`, {
        sequences: [
          {
            seq_number: 1,
            seq_delay_details: { delay_in_days: 0 },
            variant_distribution_type: 'MANUAL_EQUAL',
            seq_variants: [{ subject: subjectVar, email_body: bodyVar, variant_label: 'A' }],
          },
        ],
      });
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
        // Smartlead renamed this field: max_leads_per_day → max_new_leads_per_day (verified live
        // 2026-07-06; the old name 400s "max_new_leads_per_day is required", which then 500s START
        // with "Cron Exp value is empty").
        max_new_leads_per_day: maxLeadsPerDay,
      });
    },
    async setStatus(campaignId, status): Promise<void> {
      // Smartlead's status endpoint is POST, not PATCH (PATCH now 404s "Cannot PATCH …/status";
      // POST returns 200 — verified live 2026-07-06). This was the final provisioning-chain drift.
      await send('POST', `/campaigns/${campaignId}/status`, { status });
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
