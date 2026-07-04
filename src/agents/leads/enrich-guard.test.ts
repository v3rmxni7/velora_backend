import { describe, expect, it } from 'vitest';
import { assessEnrichRate } from './enrich-guard.js';

// The enrichment daily spend ceiling — same two-ceiling math as search/send governors.
describe('assessEnrichRate — the daily enrichment spend ceiling', () => {
  const caps = { perOrg: 100, global: 500 };
  it('allows an enrichment under both ceilings', () => {
    expect(assessEnrichRate(0, 0, caps)).toBe(false);
    expect(assessEnrichRate(99, 499, caps)).toBe(false);
  });
  it('blocks at the per-org ceiling', () => {
    expect(assessEnrichRate(100, 0, caps)).toBe(true);
  });
  it('blocks at the global ceiling (even when the org is under its own cap)', () => {
    expect(assessEnrichRate(0, 500, caps)).toBe(true);
  });
  it('a zero cap means enrichment is disabled (blocks immediately)', () => {
    expect(assessEnrichRate(0, 0, { perOrg: 0, global: 500 })).toBe(true);
  });
});
