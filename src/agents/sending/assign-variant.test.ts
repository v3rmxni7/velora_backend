import { describe, expect, it } from 'vitest';
import { assignVariantIndex } from './assign-variant.js';

describe('assignVariantIndex (4.4 — deterministic even A/Z assignment)', () => {
  it('count <= 1 → always index 0 (single/zero variant)', () => {
    expect(assignVariantIndex('c:person:l', 0)).toBe(0);
    expect(assignVariantIndex('c:person:l', 1)).toBe(0);
  });

  it('is deterministic: the same key → the same index', () => {
    const key = 'camp-1:person:lead-1';
    expect(assignVariantIndex(key, 3)).toBe(assignVariantIndex(key, 3));
    expect(assignVariantIndex(key, 3)).toBe(assignVariantIndex(key, 3));
  });

  it('always returns an index in [0, count)', () => {
    for (let i = 0; i < 100; i++) {
      const idx = assignVariantIndex(`camp:person:lead-${i}`, 3);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(3);
    }
  });

  it('count=2 splits a large key set roughly evenly (no skew toward a variant)', () => {
    let a = 0;
    let b = 0;
    for (let i = 0; i < 400; i++) {
      if (assignVariantIndex(`camp:person:${i}`, 2) === 0) a += 1;
      else b += 1;
    }
    // Even by construction; allow generous skew (~200/200).
    expect(a).toBeGreaterThan(140);
    expect(b).toBeGreaterThan(140);
  });
});
