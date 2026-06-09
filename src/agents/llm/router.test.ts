import { describe, expect, it } from 'vitest';
import { selectModel } from './router.js';

describe('selectModel', () => {
  it('routes the writer task to a strong model with a capped output length', () => {
    const route = selectModel('writer');
    expect(route.tier).toBe('strong');
    expect(route.maxOutputTokens).toBeDefined();
    expect(route.maxOutputTokens ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(200);
  });
});
