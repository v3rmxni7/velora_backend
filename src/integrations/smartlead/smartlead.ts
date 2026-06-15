import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import type { SmartleadClient, SmartleadEmailAccount, SmartleadWarmupStats } from './types.js';

/** Smartlead's list endpoint returns an array; tolerate a {data:[...]} envelope too. */
export function normalizeAccountsResponse(body: unknown): SmartleadEmailAccount[] {
  const arr = Array.isArray(body) ? body : (body as { data?: unknown } | null)?.data;
  return Array.isArray(arr) ? (arr as SmartleadEmailAccount[]) : [];
}

// Read-only Smartlead client (mirrors the scraper/embeddings adapter pattern): factory that
// validates the key, uses global fetch, passes ?api_key=, and throws AppError on misconfig/HTTP.
export function createSmartleadClient(): SmartleadClient {
  if (!env.SMARTLEAD_API_KEY) {
    throw new AppError('SMARTLEAD_API_KEY is not configured', {
      code: 'smartlead_unconfigured',
      statusCode: 503,
    });
  }
  const apiKey = env.SMARTLEAD_API_KEY;
  const base = env.SMARTLEAD_API_URL.replace(/\/+$/, '');

  async function get(path: string, params: Record<string, string> = {}): Promise<unknown> {
    const url = new URL(`${base}${path}`);
    url.searchParams.set('api_key', apiKey);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      throw new AppError(`Smartlead request failed (${res.status})`, {
        code: 'smartlead_error',
        statusCode: 502,
      });
    }
    return res.json();
  }

  return {
    async listEmailAccounts(): Promise<SmartleadEmailAccount[]> {
      return normalizeAccountsResponse(
        await get('/email-accounts/', { offset: '0', limit: '100' }),
      );
    },
    async getWarmupStats(emailAccountId): Promise<SmartleadWarmupStats> {
      return (await get(`/email-accounts/${emailAccountId}/warmup-stats`)) as SmartleadWarmupStats;
    },
  };
}
