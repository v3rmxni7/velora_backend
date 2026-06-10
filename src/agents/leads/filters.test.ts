import { describe, expect, it } from 'vitest';
import { CompanyFiltersSchema, LocalFiltersSchema, PeopleFiltersSchema } from './filters.js';

describe('LeadFilters Zod boundary (authoritative)', () => {
  it('accepts a valid people filter and defaults limit to 25', () => {
    const r = PeopleFiltersSchema.parse({ seniorities: ['c_level'], companyIndustries: ['saas'] });
    expect(r.limit).toBe(25);
    expect(r.seniorities).toEqual(['c_level']);
  });

  it('rejects unknown fields (strict)', () => {
    expect(() => PeopleFiltersSchema.parse({ evil: true })).toThrow();
    expect(() => CompanyFiltersSchema.parse({ foo: 1 })).toThrow();
    expect(() => LocalFiltersSchema.parse({ bar: 'x' })).toThrow();
  });

  it('rejects invalid enum values', () => {
    expect(() => PeopleFiltersSchema.parse({ seniorities: ['president'] })).toThrow();
    expect(() => PeopleFiltersSchema.parse({ companyIndustries: ['crypto'] })).toThrow();
    expect(() => CompanyFiltersSchema.parse({ size: 'huge' })).toThrow();
  });

  it('clamps limit to 1..100 and falls back to 25 on garbage', () => {
    expect(PeopleFiltersSchema.parse({ limit: 999 }).limit).toBe(100);
    expect(PeopleFiltersSchema.parse({ limit: 0 }).limit).toBe(1);
    expect(PeopleFiltersSchema.parse({ limit: 'abc' }).limit).toBe(25);
  });

  it('caps array sizes', () => {
    const tooMany = Array.from({ length: 30 }, (_, i) => `kw${i}`);
    expect(() => PeopleFiltersSchema.parse({ keywords: tooMany })).toThrow();
  });
});
