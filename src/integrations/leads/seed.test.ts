import { describe, expect, it } from 'vitest';
import { createSeedProvider } from './seed.js';

const provider = createSeedProvider();

describe('SeedProvider', () => {
  it('filters people by seniority', async () => {
    const r = await provider.searchPeople({ seniorities: ['c_level'], limit: 200 });
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((p) => p.seniority === 'c_level')).toBe(true);
  });

  it('filters people by company industry', async () => {
    const r = await provider.searchPeople({ companyIndustries: ['saas'], limit: 200 });
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((p) => p.companyIndustry === 'saas')).toBe(true);
  });

  it('respects the limit (bounded results)', async () => {
    const r = await provider.searchPeople({ limit: 5 });
    expect(r.length).toBe(5);
  });

  it('filters companies by industry', async () => {
    const r = await provider.searchCompanies({ industries: ['fintech'], limit: 200 });
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((c) => c.industry === 'fintech')).toBe(true);
  });

  it('filters local businesses by category', async () => {
    const r = await provider.searchLocal({ category: ['restaurant'], limit: 200 });
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((b) => b.category === 'restaurant')).toBe(true);
  });
});
