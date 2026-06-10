import { describe, expect, it } from 'vitest';
import { extractHardClaims, type Fact, filterFacts, verifyDraft } from './verify.js';

const mkFact = (over: Partial<Fact>): Fact => ({
  id: 'f1',
  text: 'based in London',
  sourceType: 'lead_field',
  sourceRef: 'location',
  confidence: 0.9,
  ...over,
});

describe('filterFacts (PRIMARY defense — source binding)', () => {
  const allowed = new Set(['location', 'kb.abc']);
  it('keeps facts whose source was provided and confidence is high enough', () => {
    expect(filterFacts([mkFact({})], allowed, 0.6)).toHaveLength(1);
  });
  it('drops facts citing a source we never provided (fabricated/false citation)', () => {
    const bad = mkFact({ sourceType: 'kb_chunk', sourceRef: 'made-up-id' });
    expect(filterFacts([bad], allowed, 0.6)).toHaveLength(0);
  });
  it('drops low-confidence facts', () => {
    expect(filterFacts([mkFact({ confidence: 0.3 })], allowed, 0.6)).toHaveLength(0);
  });
});

describe('verifyDraft (BACKSTOP — hard-claim token scan)', () => {
  const corpus = 'based in london cut onboarding time by 40% acme health';
  it('passes when used facts are known and hard claims trace to the corpus', () => {
    const r = verifyDraft('You cut onboarding time by 40% at Acme Health.', corpus, ['f1'], ['f1']);
    expect(r.ok).toBe(true);
  });
  it('rejects a fabricated percentage not in the corpus', () => {
    const r = verifyDraft('We boosted revenue 35% last year.', corpus, [], []);
    expect(r.ok).toBe(false);
    expect(r.unverified.some((u) => u.includes('35%'))).toBe(true);
  });
  it('rejects a fabricated proper-noun (company) not in the corpus', () => {
    const r = verifyDraft('As seen at Globex Corporation.', corpus, [], []);
    expect(r.ok).toBe(false);
  });
  it('does NOT flag a greeting + known names (sentence-initial words are skipped)', () => {
    const r = verifyDraft('Hi Jordan, I work with Nimbus Labs.', 'jordan nimbus labs', [], []);
    expect(r.ok).toBe(true);
  });

  it('rejects usedFactIds that are not provided facts', () => {
    const r = verifyDraft('Hello there.', corpus, ['ghost'], ['f1']);
    expect(r.ok).toBe(false);
  });

  // DOCUMENTS THE LIMITATION (real safety boundary): the token scan is a backstop and does
  // NOT catch soft/qualitative unsupported claims. The PRIMARY defenses are source-binding
  // (filterFacts) + the thin-facts→template gate in generate.ts. Do not over-trust this scan.
  it('does NOT catch a soft qualitative claim with no hard tokens (backstop limitation)', () => {
    const r = verifyDraft("I noticed you're scaling your team quickly.", corpus, [], []);
    expect(r.ok).toBe(true); // intentionally — soft claims are handled by layers 1–2, not here
  });
});

describe('extractHardClaims', () => {
  it('allows small CTA numbers (e.g. "15 min") — only %/$/4+digit/proper-nouns are hard', () => {
    expect(extractHardClaims('a quick 15 min call')).toEqual([]);
  });
});
