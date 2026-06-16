import { describe, expect, it } from 'vitest';
import { assessHealth, type HealthThresholds } from './anomaly.js';

const T: HealthThresholds = { maxBounceRate: 0.05, minSends: 20, maxComplaints: 0 };

describe('assessHealth (deterministic circuit-breaker)', () => {
  it('AT the bounce-rate threshold → no breach (strict >)', () => {
    // 1/20 = exactly 0.05 → not over.
    const v = assessHealth({ sends: 20, bounces: 1, complaints: 0 }, T);
    expect(v.breach).toBe(false);
    expect(v.bounceRate).toBeCloseTo(0.05, 5);
  });
  it('OVER the bounce-rate threshold → breach', () => {
    const v = assessHealth({ sends: 20, bounces: 2, complaints: 0 }, T); // 0.10
    expect(v.breach).toBe(true);
    expect(v.reason).toContain('bounce_rate');
  });
  it('UNDER min-sends → no breach even at a high rate (tiny sample is not judged)', () => {
    const v = assessHealth({ sends: 19, bounces: 19, complaints: 0 }, T); // 100% but n<min
    expect(v.breach).toBe(false);
  });
  it('ANY complaint over the max → breach, regardless of volume', () => {
    expect(assessHealth({ sends: 0, bounces: 0, complaints: 1 }, T).breach).toBe(true);
    expect(assessHealth({ sends: 5, bounces: 0, complaints: 1 }, T).reason).toContain('complaints');
  });
  it('zero sends, no complaints → no breach (rate uncomputable)', () => {
    expect(assessHealth({ sends: 0, bounces: 0, complaints: 0 }, T).breach).toBe(false);
  });
});
