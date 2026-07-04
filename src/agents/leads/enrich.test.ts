import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { LeadProvider, PersonEnrichment } from '../../integrations/leads/types.js';
import { enrichPersonLead } from './enrich.js';

// Money-path tests for the enrichment orchestrator: enforce-before / debit-after / failed-enrich-
// costs-nothing / claim-based concurrency. The db is a minimal chainable stub programmed per table.

interface Behavior {
  person?: Record<string, unknown> | null;
  claimRows?: { id: string }[]; // rows the claim UPDATE returns (empty = lost the race)
  reReadEmail?: string | null; // email seen on the post-race re-read
  ledgerCountToday?: number; // 'enrichment' rows today (org and global both use this)
  balanceRows?: { delta: number }[];
}

function stubDb(b: Behavior, log: { debits: unknown[]; emailWrites: unknown[] }): SupabaseClient {
  let peopleReads = 0;
  return {
    from(table: string) {
      if (table === 'people') {
        return {
          select: (_cols: string) => ({
            eq: () => ({
              maybeSingle: async () => {
                peopleReads += 1;
                // 1st read = the person row; later reads = the post-race re-read (email only).
                return {
                  data: peopleReads === 1 && b.person !== undefined
                    ? b.person
                    : { email: b.reReadEmail ?? null },
                  error: null,
                };
              },
            }),
          }),
          update: (patch: Record<string, unknown>) => ({
            eq: () => ({
              is: () => {
                // email write: .update({email}).eq().is().select()
                if ('email' in patch) {
                  return {
                    select: async () => {
                      log.emailWrites.push(patch);
                      return { data: [{ id: 'p1' }], error: null };
                    },
                  };
                }
                // claim: .update({enriched_at}).eq().is().or().select()
                return {
                  or: () => ({
                    select: async () => ({ data: b.claimRows ?? [{ id: 'p1' }], error: null }),
                  }),
                };
              },
            }),
          }),
        };
      }
      if (table === 'credit_ledger') {
        return {
          select: (_cols: string, opts?: { count?: string; head?: boolean }) => {
            if (opts?.head) {
              // count query: .eq('reason').gte()[.eq(org)] → thenable with count
              const q = {
                eq: () => q,
                gte: () => q,
                then: (res: (v: { count: number; error: null }) => void) =>
                  res({ count: b.ledgerCountToday ?? 0, error: null }),
              };
              return q;
            }
            // balance query: .eq(org) → thenable with rows
            return {
              eq: async () => ({ data: b.balanceRows ?? [{ delta: 200 }], error: null }),
            };
          },
          insert: async (row: unknown) => {
            log.debits.push(row);
            return { error: null };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
}

const PERSON = {
  id: 'p1',
  organization_id: 'org1',
  email: null,
  external_id: 'apollo:x1',
  full_name: 'Ada Lovelace',
  company_name: 'Acme',
  linkedin_url: null,
  enriched_at: null,
};

function provider(
  result: PersonEnrichment | null,
  opts: { metered?: boolean } = {},
): LeadProvider & { enrichCalls: number } {
  const p = {
    name: 'apollo',
    metered: opts.metered ?? true,
    enrichCalls: 0,
    searchPeople: vi.fn(),
    searchCompanies: vi.fn(),
    searchLocal: vi.fn(),
    async enrichPerson() {
      p.enrichCalls += 1;
      return result;
    },
  };
  return p as unknown as LeadProvider & { enrichCalls: number };
}

describe('enrichPersonLead — enforce-before / debit-after / never-fabricate', () => {
  it('success: writes the email and debits exactly once, day-keyed', async () => {
    const log = { debits: [] as unknown[], emailWrites: [] as unknown[] };
    const db = stubDb({ person: PERSON }, log);
    const p = provider({ email: 'ada@acme.com' });
    const r = await enrichPersonLead(db, 'p1', p);
    expect(r).toEqual({ outcome: 'enriched', email: 'ada@acme.com' });
    expect(log.emailWrites).toEqual([{ email: 'ada@acme.com' }]);
    expect(log.debits).toHaveLength(1);
    const debit = log.debits[0] as Record<string, unknown>;
    expect(debit.reason).toBe('enrichment');
    expect(debit.delta).toBe(-1);
    expect(String(debit.idempotency_key)).toMatch(/^enrichment:p1:\d{4}-\d{2}-\d{2}$/);
  });

  it('no-match: costs NOTHING (no debit, no email write)', async () => {
    const log = { debits: [] as unknown[], emailWrites: [] as unknown[] };
    const db = stubDb({ person: PERSON }, log);
    const p = provider(null);
    const r = await enrichPersonLead(db, 'p1', p);
    expect(r.outcome).toBe('no_email_found');
    expect(log.debits).toHaveLength(0);
    expect(log.emailWrites).toHaveLength(0);
  });

  it('already has an email: short-circuits with zero provider calls', async () => {
    const log = { debits: [] as unknown[], emailWrites: [] as unknown[] };
    const db = stubDb({ person: { ...PERSON, email: 'has@one.com' } }, log);
    const p = provider({ email: 'should-not-be-used@x.com' });
    const r = await enrichPersonLead(db, 'p1', p);
    expect(r).toEqual({ outcome: 'already', email: 'has@one.com' });
    expect(p.enrichCalls).toBe(0);
    expect(log.debits).toHaveLength(0);
  });

  it('quota reached: defers BEFORE any paid call', async () => {
    const log = { debits: [] as unknown[], emailWrites: [] as unknown[] };
    const db = stubDb({ person: PERSON, ledgerCountToday: 100_000 }, log);
    const p = provider({ email: 'ada@acme.com' });
    const r = await enrichPersonLead(db, 'p1', p);
    expect(r.outcome).toBe('quota');
    expect(p.enrichCalls).toBe(0);
    expect(log.debits).toHaveLength(0);
  });

  it('insufficient credit: enforce-BEFORE — Apollo is never called', async () => {
    const log = { debits: [] as unknown[], emailWrites: [] as unknown[] };
    const db = stubDb({ person: PERSON, balanceRows: [{ delta: 0 }] }, log);
    const p = provider({ email: 'ada@acme.com' });
    const r = await enrichPersonLead(db, 'p1', p);
    expect(r.outcome).toBe('insufficient_credit');
    expect(p.enrichCalls).toBe(0);
    expect(log.debits).toHaveLength(0);
  });

  it('recent failed attempt: honest no_email_found without re-spending', async () => {
    const log = { debits: [] as unknown[], emailWrites: [] as unknown[] };
    const db = stubDb(
      { person: { ...PERSON, enriched_at: new Date().toISOString() } },
      log,
    );
    const p = provider({ email: 'ada@acme.com' });
    const r = await enrichPersonLead(db, 'p1', p);
    expect(r.outcome).toBe('no_email_found');
    expect(p.enrichCalls).toBe(0);
  });

  it('lost the concurrency claim: re-reads once and uses the winner’s email (no second paid call)', async () => {
    const log = { debits: [] as unknown[], emailWrites: [] as unknown[] };
    const db = stubDb({ person: PERSON, claimRows: [], reReadEmail: 'won@race.com' }, log);
    const p = provider({ email: 'should-not-be-used@x.com' });
    const r = await enrichPersonLead(db, 'p1', p);
    expect(r).toEqual({ outcome: 'already', email: 'won@race.com' });
    expect(p.enrichCalls).toBe(0);
    expect(log.debits).toHaveLength(0);
  });

  it('unmetered (seed) provider: skips quota/credit/debit but still writes only real fixture emails', async () => {
    const log = { debits: [] as unknown[], emailWrites: [] as unknown[] };
    // ledger count astronomically high + zero balance — must NOT matter for an unmetered provider
    const db = stubDb(
      { person: PERSON, ledgerCountToday: 100_000, balanceRows: [{ delta: 0 }] },
      log,
    );
    const p = provider({ email: 'seed@example.com' }, { metered: false });
    const r = await enrichPersonLead(db, 'p1', p);
    expect(r).toEqual({ outcome: 'enriched', email: 'seed@example.com' });
    expect(log.debits).toHaveLength(0); // free — never debited
  });
});
