import { describe, expect, it } from 'vitest';
import { assessCredits, SEND_COST } from './pipeline.js';

describe('assessCredits (the credit gate — enforced live in 2.5, recorded in dry-run)', () => {
  it('sufficient when balance covers the cost', () => {
    expect(assessCredits(10, SEND_COST)).toEqual({ balance: 10, cost: 1, sufficient: true });
  });
  it('exact balance is sufficient', () => {
    expect(assessCredits(1, 1).sufficient).toBe(true);
  });
  it('insufficient below cost (incl. a zero balance)', () => {
    expect(assessCredits(0, 1).sufficient).toBe(false);
    expect(assessCredits(0.5, 1).sufficient).toBe(false);
  });
});
