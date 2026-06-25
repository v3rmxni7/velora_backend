import { afterEach, describe, expect, it, vi } from 'vitest';
import { assessLeadSearchRate } from '../../agents/leads/search-guard.js';
import { createApolloProvider } from './apollo.js';
import { selectLeadProvider } from './index.js';
import type { PeopleFilters } from './types.js';

// Lead-sourcing slice — the SAFETY logic, verified without a live key or DB. (The live Apollo HTTP
// mapping itself needs a real APOLLO_API_KEY to verify end-to-end; here we mock fetch to prove the
// adapter maps correctly and FAILS SAFE — never fabricating leads.)

describe('selectLeadProvider — honest-off without a key', () => {
  it("defaults to the free, unmetered seed provider for 'seed'", () => {
    const p = selectLeadProvider('seed', {});
    expect(p.name).toBe('seed');
    expect(p.metered).toBe(false);
  });

  it("falls back to seed when 'apollo' is selected but no key is set (no silent spend)", () => {
    const p = selectLeadProvider('apollo', {});
    expect(p.name).toBe('seed');
    expect(p.metered).toBe(false);
  });

  it("returns the metered Apollo provider only when 'apollo' AND its key are present", () => {
    const p = selectLeadProvider('apollo', { apollo: 'test-key' });
    expect(p.name).toBe('apollo');
    expect(p.metered).toBe(true);
  });
});

describe('assessLeadSearchRate — the daily spend ceiling', () => {
  const caps = { perOrg: 25, global: 100 };
  it('allows a search under both ceilings', () => {
    expect(assessLeadSearchRate(0, 0, caps)).toBe(false);
    expect(assessLeadSearchRate(24, 99, caps)).toBe(false);
  });
  it('blocks at the per-org ceiling', () => {
    expect(assessLeadSearchRate(25, 0, caps)).toBe(true);
  });
  it('blocks at the global ceiling', () => {
    expect(assessLeadSearchRate(0, 100, caps)).toBe(true);
  });
});

describe('Apollo adapter — maps real results + fails safe (mocked fetch)', () => {
  const filters: PeopleFilters = { titleKeywords: ['cto'], limit: 10 };
  afterEach(() => vi.unstubAllGlobals());

  it('maps people, keeps real emails, and DROPS Apollo locked/placeholder emails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          people: [
            {
              id: '1',
              first_name: 'Ada',
              last_name: 'Lovelace',
              name: 'Ada Lovelace',
              title: 'CTO',
              email: 'ada@acme.com',
              seniority: 'c_suite',
              departments: ['engineering'],
              city: 'San Francisco',
              state: 'CA',
              country: 'US',
              linkedin_url: 'https://linkedin.com/in/ada',
              organization: {
                id: 'o1',
                name: 'Acme',
                industry: 'computer software',
                estimated_num_employees: 150,
              },
            },
            { id: '2', name: 'Locked Lead', email: 'email_not_unlocked@domain.com' },
          ],
        }),
      }),
    );
    const provider = createApolloProvider('test-key');
    const results = await provider.searchPeople(filters);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      externalId: 'apollo:1',
      fullName: 'Ada Lovelace',
      email: 'ada@acme.com',
      seniority: 'c_level', // mapped from Apollo 'c_suite'
      department: 'engineering',
      companyName: 'Acme',
      companyIndustry: 'saas', // mapped from 'computer software'
      companySize: '51-200', // derived from 150 employees
      companyExternalId: 'apollo:o1',
    });
    // The locked-email lead is returned WITHOUT a fabricated address.
    expect(results[1]?.email).toBeUndefined();
  });

  it('throws (never fabricates) on a non-2xx provider response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) }),
    );
    const provider = createApolloProvider('test-key');
    await expect(provider.searchPeople(filters)).rejects.toMatchObject({ code: 'apollo_error' });
  });

  it('throws (never fabricates) on an unexpected response shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ people: 'not-an-array' }) }),
    );
    const provider = createApolloProvider('test-key');
    await expect(provider.searchPeople(filters)).rejects.toMatchObject({
      code: 'apollo_bad_response',
    });
  });

  it('returns an honest empty list for local-business search (Apollo has no local data)', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const provider = createApolloProvider('test-key');
    expect(await provider.searchLocal({ limit: 10 })).toEqual([]);
    expect(globalThis.fetch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});
