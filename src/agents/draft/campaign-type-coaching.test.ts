import { describe, expect, it } from 'vitest';
import { campaignTypeCoaching } from './generate.js';

describe('campaignTypeCoaching (4.3 — type-appropriate angle)', () => {
  it('returns NO line for cold_outbound (byte-identical to a Phase-2 cold draft)', () => {
    expect(campaignTypeCoaching('cold_outbound')).toBeNull();
  });
  it('returns null for unknown / missing types', () => {
    expect(campaignTypeCoaching(undefined)).toBeNull();
    expect(campaignTypeCoaching(null)).toBeNull();
    expect(campaignTypeCoaching('nonsense')).toBeNull();
  });
  it('returns a steering line for each non-cold type', () => {
    for (const t of ['warm_outbound', 'cross_sell', 'website_visitor', 'intent_signals']) {
      expect(campaignTypeCoaching(t)).toBeTypeOf('string');
      expect((campaignTypeCoaching(t) as string).length).toBeGreaterThan(0);
    }
  });
});
