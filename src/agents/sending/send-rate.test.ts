import { describe, expect, it } from 'vitest';
import { assessSendRate } from './pipeline.js';

// H4 regression: the daily volume governor must trip on EITHER ceiling (per-org or global).
describe('assessSendRate (H4 — daily send governor)', () => {
  const caps = { perOrg: 50, global: 200 };
  it('allows when both counts are under their caps', () => {
    expect(assessSendRate(49, 199, caps)).toBe(false);
    expect(assessSendRate(0, 0, caps)).toBe(false);
  });
  it('trips when the per-org count reaches its cap', () => {
    expect(assessSendRate(50, 0, caps)).toBe(true);
    expect(assessSendRate(51, 0, caps)).toBe(true);
  });
  it('trips when the global count reaches its cap (even if the org is fine)', () => {
    expect(assessSendRate(0, 200, caps)).toBe(true);
  });
  it('a zero cap blocks everything', () => {
    expect(assessSendRate(0, 0, { perOrg: 0, global: 999 })).toBe(true);
  });
});
