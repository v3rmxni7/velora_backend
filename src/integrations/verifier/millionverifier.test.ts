import { describe, expect, it } from 'vitest';
import {
  createMillionVerifier,
  parseVerifyResponse,
  verdictFromResult,
} from './millionverifier.js';

describe('verdictFromResult', () => {
  it('ok → deliverable', () => {
    expect(verdictFromResult('ok')).toBe('deliverable');
  });
  it('invalid + disposable → undeliverable (never send)', () => {
    expect(verdictFromResult('invalid')).toBe('undeliverable');
    expect(verdictFromResult('disposable')).toBe('undeliverable');
  });
  it('catch_all / unknown / error / unexpected → risky (proceed, flagged)', () => {
    for (const r of ['catch_all', 'unknown', 'error', 'something_new']) {
      expect(verdictFromResult(r)).toBe('risky');
    }
  });
});

describe('parseVerifyResponse', () => {
  it('maps result + resultcode and derives the verdict', () => {
    expect(parseVerifyResponse({ result: 'ok', resultcode: 1 })).toEqual({
      result: 'ok',
      resultcode: 1,
      verdict: 'deliverable',
    });
    expect(parseVerifyResponse({ result: 'invalid', resultcode: 6 }).verdict).toBe('undeliverable');
  });
  it('defaults a missing result to unknown → risky', () => {
    expect(parseVerifyResponse({}).verdict).toBe('risky');
  });
});

describe('createMillionVerifier', () => {
  it('returns null when MILLIONVERIFIER_API_KEY is absent (verification skipped in sandbox)', () => {
    expect(createMillionVerifier()).toBeNull();
  });
});
