import { describe, expect, it, vi } from 'vitest';
import { env } from '../../config/env.js';
import {
  type CrmOAuthCreds,
  CrmAuthError,
  exchangeHubspotCode,
  getCrmClient,
  HubspotCrmClient,
  mapHubspotContact,
} from './client.js';

// T1 — HubSpot OAuth exchange + contacts client. All HTTP is via an injected fetch (no network); the
// security spine (tokens never echoed, conditional refresh-token persist) is proven here.

const creds: CrmOAuthCreds = { clientId: 'cid', clientSecret: 'csecret' };

interface Call {
  url: string;
  init?: { body?: unknown; headers?: Record<string, string> };
}
function recorder(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: unknown, init?: unknown) => {
    const call = { url: String(input), init: init as Call['init'] };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
function jsonRes(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('mapHubspotContact', () => {
  it('maps properties and builds a full name', () => {
    expect(
      mapHubspotContact({
        id: 55,
        properties: { email: ' a@x.com ', firstname: 'Ada', lastname: 'Lovelace', jobtitle: 'CTO', company: 'Analytical' },
      }),
    ).toEqual({
      externalId: '55',
      email: 'a@x.com',
      fullName: 'Ada Lovelace',
      firstName: 'Ada',
      lastName: 'Lovelace',
      title: 'CTO',
      companyName: 'Analytical',
    });
  });
  it('tolerates an email-less / bare contact', () => {
    expect(mapHubspotContact({ id: 7, properties: {} })).toMatchObject({
      externalId: '7',
      email: null,
      fullName: null,
    });
  });
});

describe('exchangeHubspotCode', () => {
  it('returns the vault bundle (refresh_token only — access token NOT persisted) on success', async () => {
    const { calls, fetchImpl } = recorder(() =>
      jsonRes({ access_token: 'ACCESS-XYZ', refresh_token: 'RT', expires_in: 1800, token_type: 'bearer' }),
    );
    const out = await exchangeHubspotCode(creds, 'code123', 'https://x/cb', fetchImpl);
    expect(out).toEqual({ oauth: { refresh_token: 'RT', token_type: 'bearer' } });
    expect(JSON.stringify(out)).not.toContain('ACCESS-XYZ'); // access token never stored
    expect(calls[0]?.url).toContain('/oauth/v1/token');
    expect(String(calls[0]?.init?.body)).toContain('grant_type=authorization_code');
    expect(String(calls[0]?.init?.body)).toContain('code=code123');
  });
  it('→ null on non-2xx (no throw, error body never read/echoed)', async () => {
    const { fetchImpl } = recorder(() => jsonRes({ error: 'invalid_grant', message: 'bad code' }, 400));
    expect(await exchangeHubspotCode(creds, 'c', 'https://x/cb', fetchImpl)).toBeNull();
  });
  it('→ null when the response has no refresh_token', async () => {
    const { fetchImpl } = recorder(() => jsonRes({ access_token: 'AT' }));
    expect(await exchangeHubspotCode(creds, 'c', 'https://x/cb', fetchImpl)).toBeNull();
  });
  it('→ null on a network error (no throw)', async () => {
    const fetchImpl = (async () => {
      throw new Error('econnreset');
    }) as unknown as typeof fetch;
    expect(await exchangeHubspotCode(creds, 'c', 'https://x/cb', fetchImpl)).toBeNull();
  });
});

describe('HubspotCrmClient.listContacts', () => {
  const contactsPage = {
    results: [
      { id: 1, properties: { email: 'a@x.com', firstname: 'A' } },
      { id: 2, properties: { email: 'b@x.com' } },
    ],
    paging: { next: { after: 'CUR2' } },
  };

  it('refreshes an access token, maps contacts, and returns the next cursor', async () => {
    const { calls, fetchImpl } = recorder((c) =>
      c.url.includes('/oauth/v1/token') ? jsonRes({ access_token: 'AT1', token_type: 'bearer' }) : jsonRes(contactsPage),
    );
    const client = new HubspotCrmClient(creds, { refresh_token: 'RT' }, { fetchImpl });
    const page = await client.listContacts();
    expect(page.contacts.map((x) => x.externalId)).toEqual(['1', '2']);
    expect(page.cursor).toBe('CUR2');
    const contactsCall = calls.find((c) => c.url.includes('/crm/v3/objects/contacts'));
    expect(contactsCall?.init?.headers?.authorization).toBe('Bearer AT1');
    expect(contactsCall?.url).toContain('properties=email');
    expect(contactsCall?.url).toContain('limit=100');
  });

  it('passes the after cursor; absent paging.next → undefined cursor', async () => {
    const { calls, fetchImpl } = recorder((c) =>
      c.url.includes('token') ? jsonRes({ access_token: 'AT' }) : jsonRes({ results: [] }),
    );
    const client = new HubspotCrmClient(creds, { refresh_token: 'RT' }, { fetchImpl });
    const page = await client.listContacts('CUR2');
    expect(page.cursor).toBeUndefined();
    expect(calls.find((c) => c.url.includes('contacts'))?.url).toContain('after=CUR2');
  });

  it('caches the access token — one refresh across multiple listContacts calls', async () => {
    const { calls, fetchImpl } = recorder((c) =>
      c.url.includes('token') ? jsonRes({ access_token: 'AT' }) : jsonRes({ results: [] }),
    );
    const client = new HubspotCrmClient(creds, { refresh_token: 'RT' }, { fetchImpl });
    await client.listContacts();
    await client.listContacts('CUR');
    expect(calls.filter((c) => c.url.includes('/oauth/v1/token')).length).toBe(1);
  });
});

describe('HubspotCrmClient — conditional refresh-token persist', () => {
  it('persists a ROTATED refresh_token', async () => {
    const persist = vi.fn(async () => {});
    const { fetchImpl } = recorder((c) =>
      c.url.includes('token') ? jsonRes({ access_token: 'AT', refresh_token: 'RT-NEW' }) : jsonRes({ results: [] }),
    );
    await new HubspotCrmClient(creds, { refresh_token: 'RT-OLD' }, { fetchImpl, persist }).listContacts();
    expect(persist).toHaveBeenCalledWith({ refresh_token: 'RT-NEW', token_type: 'bearer' });
  });
  it('does NOT persist when the refresh_token is unchanged (no DB churn)', async () => {
    const persist = vi.fn(async () => {});
    const { fetchImpl } = recorder((c) =>
      c.url.includes('token') ? jsonRes({ access_token: 'AT', refresh_token: 'RT' }) : jsonRes({ results: [] }),
    );
    await new HubspotCrmClient(creds, { refresh_token: 'RT' }, { fetchImpl, persist }).listContacts();
    expect(persist).not.toHaveBeenCalled();
  });
  it('a FAILING persist propagates (not silently swallowed) → the sync errors, not a stale token', async () => {
    const persist = vi.fn(async () => {
      throw new Error('vault_write_failed');
    });
    const { fetchImpl } = recorder((c) =>
      c.url.includes('token') ? jsonRes({ access_token: 'AT', refresh_token: 'RT-NEW' }) : jsonRes({ results: [] }),
    );
    await expect(
      new HubspotCrmClient(creds, { refresh_token: 'RT-OLD' }, { fetchImpl, persist }).listContacts(),
    ).rejects.toThrow('vault_write_failed');
  });
});

describe('HubspotCrmClient — failures never leak the token', () => {
  it('a revoked refresh token (400) → CrmAuthError(refresh_token_invalid) with NO token in the message', async () => {
    const { fetchImpl } = recorder(() => jsonRes({ message: 'BAD_REFRESH_TOKEN' }, 400));
    const client = new HubspotCrmClient(
      { clientId: 'cid', clientSecret: 'SEKRET' },
      { refresh_token: 'RT-SECRET' },
      { fetchImpl },
    );
    let err: Error | undefined;
    try {
      await client.listContacts();
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeInstanceOf(CrmAuthError);
    expect(err?.message).toBe('refresh_token_invalid');
    expect(err?.message ?? '').not.toContain('RT-SECRET');
    expect(err?.message ?? '').not.toContain('SEKRET');
  });
  it('a 5xx refresh → refresh_failed (generic, no token)', async () => {
    const { fetchImpl } = recorder(() => jsonRes({ error: 'server' }, 500));
    let err: Error | undefined;
    try {
      await new HubspotCrmClient(creds, { refresh_token: 'RT' }, { fetchImpl }).listContacts();
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toBe('refresh_failed');
  });
});

describe('getCrmClient gating (honest-empty)', () => {
  it('null for a non-CRM provider', () => {
    expect(getCrmClient(env, 'zoho', { refresh_token: 'x' })).toBeNull();
  });
  it('null when not connected (no stored token)', () => {
    expect(getCrmClient(env, 'hubspot', null)).toBeNull();
  });
  it('null for salesforce (client deferred / unconfigured)', () => {
    expect(getCrmClient(env, 'salesforce', { refresh_token: 'x' })).toBeNull();
  });
});
