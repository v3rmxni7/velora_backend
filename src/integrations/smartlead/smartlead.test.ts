import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors.js';
import { SANDBOX_ACCOUNT_ID } from './sandbox.js';
import { createSmartleadClient, normalizeAccountsResponse } from './smartlead.js';

describe('createSmartleadClient', () => {
  it('returns the sandbox client when SMARTLEAD_API_KEY is not configured (dev/demo default)', async () => {
    // No key in the test env → the factory yields the read-only sandbox simulator, not a throw.
    const client = createSmartleadClient();
    const accounts = await client.listEmailAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.id).toBe(SANDBOX_ACCOUNT_ID);
  });

  it('sandbox refuses real sends (so a no-key client can never fake a send)', async () => {
    const client = createSmartleadClient();
    await expect(client.addLead('c1', { email: 'x@y.example', custom_fields: {} })).rejects.toThrow(
      AppError,
    );
  });
});

describe('normalizeAccountsResponse', () => {
  it('passes through a bare array', () => {
    expect(normalizeAccountsResponse([{ id: 1, from_email: 'a@x.com' }])).toHaveLength(1);
  });
  it('unwraps a {data:[...]} envelope', () => {
    expect(normalizeAccountsResponse({ data: [{ id: 1, from_email: 'a@x.com' }] })).toHaveLength(1);
  });
  it('returns [] for anything else (null / object / string)', () => {
    expect(normalizeAccountsResponse(null)).toEqual([]);
    expect(normalizeAccountsResponse({ nope: true })).toEqual([]);
    expect(normalizeAccountsResponse('oops')).toEqual([]);
  });
});
