import { describe, expect, it } from 'vitest';
import {
  decideDraftMode,
  extractHardClaims,
  type Fact,
  filterFacts,
  isSubstantiveLeadFact,
  verifyDraft,
} from './verify.js';

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

  // Real names with intra-word punctuation / accents used to be DELETED into a different token and
  // falsely flagged (→ every O'Brien / L'Oréal draft fell back to template). They must PASS now.
  it("does NOT flag a real name with an apostrophe when it's in the corpus (O'Brien)", () => {
    const r = verifyDraft('Great work at O’Brien Consulting.', "o'brien consulting", [], []);
    expect(r.ok).toBe(true);
  });
  it('does NOT flag an accented/hyphenated corpus name (L’Oréal, Coca-Cola)', () => {
    const r = verifyDraft('Saw the L’Oréal and Coca-Cola case studies.', "l'oréal coca-cola case", [], []);
    expect(r.ok).toBe(true);
  });
  it('still flags a fabricated name even with the fold (Globex not in corpus)', () => {
    const r = verifyDraft('As seen at Globex.', "o'brien consulting", [], []);
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

describe('isSubstantiveLeadFact (identity fields never make a draft "about" the lead)', () => {
  it('real lead fields are substantive (title, company_name)', () => {
    expect(isSubstantiveLeadFact(mkFact({ sourceRef: 'lead.title' }))).toBe(true);
    expect(isSubstantiveLeadFact(mkFact({ sourceRef: 'lead.company_name' }))).toBe(true);
  });
  it('pure-identity fields are NOT substantive (first/last/full name, company name field)', () => {
    for (const ref of ['lead.first_name', 'lead.last_name', 'lead.full_name', 'lead.name']) {
      expect(isSubstantiveLeadFact(mkFact({ sourceRef: ref }))).toBe(false);
    }
  });
  it('proof and kb facts are NOT lead-specific (they support the pitch, not the lead)', () => {
    expect(isSubstantiveLeadFact(mkFact({ sourceType: 'proof_item', sourceRef: 'proof.x' }))).toBe(
      false,
    );
    expect(isSubstantiveLeadFact(mkFact({ sourceType: 'kb_chunk', sourceRef: 'kb.y' }))).toBe(
      false,
    );
  });
});

describe('decideDraftMode (the labeling gate — "personalized" must be earned)', () => {
  const proof = (id: string) =>
    mkFact({ id, sourceType: 'proof_item', sourceRef: `proof.${id}`, confidence: 0.9 });
  const lead = (id: string, field: string) =>
    mkFact({ id, sourceType: 'lead_field', sourceRef: `lead.${field}`, confidence: 1 });

  it('PROOF-ONLY (the B3 finding): org proof alone is NOT personalized', () => {
    const d = decideDraftMode([proof('p1'), proof('p2')]);
    expect(d).toEqual({ mode: 'template', reason: 'no lead-specific facts' });
  });
  it('NAME-FIELDS-ONLY (the B3 finding): first_name + full_name is NOT personalized', () => {
    const d = decideDraftMode([lead('f1', 'first_name'), lead('f2', 'full_name')]);
    expect(d).toEqual({ mode: 'template', reason: 'no lead-specific facts' });
  });
  it('the minimum that earns it: 1 substantive lead fact + 1 proof fact → personalized', () => {
    expect(decideDraftMode([lead('f1', 'title'), proof('p1')])).toEqual({
      mode: 'personalized',
    });
  });
  it('too few facts overall → insufficient verified facts (unchanged behavior)', () => {
    expect(decideDraftMode([lead('f1', 'title')])).toEqual({
      mode: 'template',
      reason: 'insufficient verified facts',
    });
    expect(decideDraftMode([])).toEqual({
      mode: 'template',
      reason: 'insufficient verified facts',
    });
  });
  it('two substantive lead facts → personalized', () => {
    expect(decideDraftMode([lead('f1', 'title'), lead('f2', 'company_name')])).toEqual({
      mode: 'personalized',
    });
  });
});
