import { describe, expect, it } from 'vitest';
import { chunkText } from './chunk.js';

describe('chunkText', () => {
  it('returns no chunks for blank input', () => {
    expect(chunkText('   \n  ')).toEqual([]);
  });

  it('produces a single chunk with a sha256 hash for short text', () => {
    const chunks = chunkText('Hello world. This is Velora.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.index).toBe(0);
    expect(chunks[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(chunks[0]?.tokenCountEstimate).toBeGreaterThan(0);
  });

  it('splits long text into multiple sequentially-indexed chunks', () => {
    const chunks = chunkText('a'.repeat(8000));
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c, i) => {
      expect(c.index).toBe(i);
    });
  });
});
