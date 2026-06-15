import { describe, expect, it } from 'vitest';
import { parseClassification, REPLY_CATEGORIES } from './classify.js';

describe('parseClassification (total — never throws)', () => {
  it('accepts every valid category', () => {
    for (const c of REPLY_CATEGORIES) {
      expect(parseClassification({ category: c })).toBe(c);
    }
  });
  it('ignores extra keys', () => {
    expect(parseClassification({ category: 'interested', confidence: 0.9 })).toBe('interested');
  });
  it('defaults to "other" on a bad/unknown category', () => {
    expect(parseClassification({ category: 'maybe' })).toBe('other');
  });
  it('defaults to "other" on junk shapes', () => {
    for (const junk of [null, undefined, 'interested', 42, {}, { foo: 'bar' }, []]) {
      expect(parseClassification(junk)).toBe('other');
    }
  });
});
