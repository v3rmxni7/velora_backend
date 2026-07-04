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
    const fetchMock = vi.fn().mockResolvedValue({
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
    });
    vi.stubGlobal('fetch', fetchMock);
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

    // Request shape (verified live 2026-06-30): POST to /api/v1, filters in the QUERY STRING
    // (arrays as key[]), auth via X-Api-Key ONLY — NO Authorization: Bearer (that 401s on Apollo).
    const [reqUrl, reqInit] = fetchMock.mock.calls[0] ?? [];
    const url = new URL(String(reqUrl));
    expect(url.pathname).toBe('/api/v1/mixed_people/api_search');
    expect(url.searchParams.getAll('person_titles[]')).toEqual(['cto']);
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('per_page')).toBe('10');
    const headers = (reqInit?.headers ?? {}) as Record<string, string>;
    expect(reqInit?.method).toBe('POST');
    expect(headers['X-Api-Key']).toBe('test-key');
    expect(headers.Authorization).toBeUndefined(); // NO Bearer — Apollo would 401 INVALID_ACCESS_TOKEN
  });

  it('throws (never fabricates) on a non-2xx response, surfacing Apollo’s own error body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        text: async () => '{"error":"Not allowed"}',
        json: async () => ({}),
      }),
    );
    const provider = createApolloProvider('test-key');
    await expect(provider.searchPeople(filters)).rejects.toMatchObject({
      code: 'apollo_error',
      // the thrown message carries Apollo's verbatim complaint, so a live failure is self-diagnosing
      message: expect.stringContaining('Not allowed'),
    });
  });

  it('maps 429 to a 429 (rate-limited), not a generic 502', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => 'rate limited',
        json: async () => ({}),
      }),
    );
    const provider = createApolloProvider('test-key');
    await expect(provider.searchPeople(filters)).rejects.toMatchObject({
      code: 'apollo_error',
      statusCode: 429,
    });
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

describe('Apollo enrichPerson — people/match, never fabricates (mocked fetch)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('maps a revealed work email, hitting people/match with id from the stored apollo:<id>', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        person: {
          id: 'p9',
          name: 'Ada Lovelace',
          title: 'CTO',
          email: 'ada@acme.com',
          linkedin_url: 'https://linkedin.com/in/ada',
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = createApolloProvider('test-key');
    const r = await provider.enrichPerson({ externalId: 'apollo:p9', fullName: 'Ada Lovelace' });
    expect(r).toEqual({
      email: 'ada@acme.com',
      title: 'CTO',
      linkedinUrl: 'https://linkedin.com/in/ada',
    });
    const [reqUrl, reqInit] = fetchMock.mock.calls[0] ?? [];
    const url = new URL(String(reqUrl));
    expect(url.pathname).toBe('/api/v1/people/match');
    expect(url.searchParams.get('id')).toBe('p9');
    // Work emails only — personal-email reveal stays off (deliverability + compliance).
    expect(url.searchParams.get('reveal_personal_emails')).toBe('false');
    const headers = (reqInit?.headers ?? {}) as Record<string, string>;
    expect(headers['X-Api-Key']).toBe('test-key');
    expect(headers.Authorization).toBeUndefined();
  });

  it('returns null (never a fabricated address) when the match carries a locked/placeholder email', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          person: { id: 'p1', email: 'email_not_unlocked@domain.com' },
        }),
      }),
    );
    const provider = createApolloProvider('test-key');
    expect(await provider.enrichPerson({ externalId: 'apollo:p1' })).toBeNull();
  });

  it('returns null when Apollo finds no match', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ person: null }) }),
    );
    const provider = createApolloProvider('test-key');
    expect(await provider.enrichPerson({ externalId: 'apollo:missing' })).toBeNull();
  });

  it('skips the paid call entirely when there is nothing to match on', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = createApolloProvider('test-key');
    // no externalId, no linkedin, and name without company → not enough to match honestly
    expect(await provider.enrichPerson({ fullName: 'Ada Lovelace' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces Apollo errors (never a silent null on a failed paid call)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 402,
        text: async () => 'insufficient export credits',
        json: async () => ({}),
      }),
    );
    const provider = createApolloProvider('test-key');
    await expect(provider.enrichPerson({ externalId: 'apollo:p1' })).rejects.toMatchObject({
      code: 'apollo_error',
      message: expect.stringContaining('insufficient export credits'),
    });
  });
});

describe('Seed enrichPerson — fixture-only, never fabricates for foreign leads', () => {
  it('enriches its own seed:* leads from the fixture', async () => {
    const p = selectLeadProvider('seed', {});
    const all = await p.searchPeople({ limit: 1 });
    const first = all[0];
    expect(first).toBeDefined();
    if (!first) return;
    const r = await p.enrichPerson({ externalId: first.externalId });
    // the fixture person's email (if any) — and NEVER an invented one
    expect(r?.email).toBe(first.email);
  });

  it('returns null for a foreign (apollo:*) lead — no fabricated fixture email on a real person', async () => {
    const p = selectLeadProvider('seed', {});
    expect(await p.enrichPerson({ externalId: 'apollo:12345', fullName: 'Real Person' })).toBeNull();
  });
});
