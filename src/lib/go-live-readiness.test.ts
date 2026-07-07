import { describe, expect, it } from 'vitest';
import { evaluateReadiness, type ReadinessFacts } from './go-live-readiness.js';

// All prereqs green.
const GREEN: ReadinessFacts = {
  warmMailboxes: 1,
  activeSenders: 1,
  creditBalance: 100,
  postalAddressSet: true,
  goLiveReviewed: true,
  smartleadConfigured: true,
  verifierConfigured: true,
  unsubscribeConfigured: true,
  webhookSecretSet: true,
};

describe('evaluateReadiness (pure)', () => {
  it('is ready when every prereq is green', () => {
    const r = evaluateReadiness(GREEN);
    expect(r.ready).toBe(true);
    expect(r.items.every((i) => i.ok)).toBe(true);
  });

  it('is NOT ready if ANY single blocking prereq is red', () => {
    const overrides: Partial<ReadinessFacts>[] = [
      { warmMailboxes: 0 },
      { activeSenders: 0 },
      { creditBalance: 0 },
      { postalAddressSet: false },
      { goLiveReviewed: false },
      { smartleadConfigured: false },
      { verifierConfigured: false },
      { unsubscribeConfigured: false },
      { webhookSecretSet: false },
    ];
    for (const o of overrides) {
      const r = evaluateReadiness({ ...GREEN, ...o });
      expect(r.ready).toBe(false);
      // exactly the flipped item is not-ok
      const red = r.items.filter((i) => !i.ok);
      expect(red.length).toBe(1);
    }
  });

  it('surfaces the L1 compliance prereqs (postal address + unsubscribe) as blocking', () => {
    const noAddr = evaluateReadiness({ ...GREEN, postalAddressSet: false });
    expect(noAddr.ready).toBe(false);
    expect(noAddr.items.find((i) => i.key === 'postal_address')?.blocking).toBe(true);

    const noUnsub = evaluateReadiness({ ...GREEN, unsubscribeConfigured: false });
    expect(noUnsub.ready).toBe(false);
    expect(noUnsub.items.find((i) => i.key === 'unsubscribe_config')?.blocking).toBe(true);
  });

  it('the staff-review gate is blocking (anti-abuse: unreviewed org is not ready)', () => {
    const r = evaluateReadiness({ ...GREEN, goLiveReviewed: false });
    expect(r.ready).toBe(false);
    expect(r.items.find((i) => i.key === 'staff_review')?.ok).toBe(false);
  });
});
