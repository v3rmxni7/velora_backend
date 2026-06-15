import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors.js';
import { createSmartleadClient, normalizeAccountsResponse } from './smartlead.js';

describe('createSmartleadClient', () => {
  it('throws 503 when SMARTLEAD_API_KEY is not configured (offline default)', () => {
    // No key in the test env → the factory must refuse to build a client.
    expect(() => createSmartleadClient()).toThrow(AppError);
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
