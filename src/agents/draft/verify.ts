// Anti-hallucination — DETERMINISTIC checks (no LLM judging itself).
//
// DEFENSE LAYERS, in order of importance:
//   1. Source-binding (filterFacts) — the Researcher's facts are dropped unless their
//      sourceRef is one we actually provided. Kills fabricated AND falsely-cited facts.
//   2. The labeling gate (decideDraftMode, below) — 'personalized' requires ≥MIN_FACTS
//      verified facts AND ≥MIN_LEAD_FACTS substantive lead facts (a real lead field,
//      not the lead's own name; proof/kb support the pitch but don't make a draft about
//      THIS lead). Anything less → the Writer never runs; generate.ts renders the
//      code-only safe template instead.
//   3. usedFactIds ⊆ facts (below).
//   4. Hard-claim token scan (below) — a CONSERVATIVE BACKSTOP only. It catches high-risk
//      *hard* claims (%, $, 4+-digit numbers, multi-word proper nouns) that don't trace to
//      the allowed corpus. It does NOT catch soft/qualitative claims ("you're scaling
//      fast") — do not over-trust it. Layers 1–2 are the primary guarantees.

export interface Fact {
  id: string;
  text: string;
  sourceType: 'kb_chunk' | 'lead_field' | 'proof_item';
  sourceRef: string;
  confidence: number;
}

/** Drop facts whose sourceRef wasn't one we provided (false/fabricated citation), or low confidence. */
export function filterFacts(
  facts: Fact[],
  allowedRefs: Set<string>,
  minConfidence: number,
): Fact[] {
  return facts.filter((f) => allowedRefs.has(f.sourceRef) && f.confidence >= minConfidence);
}

// Pure-identity lead fields: knowing someone's NAME is not knowing something about them.
// 'name' covers company/local_business identity. Everything else a lead row carries
// (title, seniority, department, company_name, industry, location…) is substantive.
export const IDENTITY_FIELDS = new Set(['first_name', 'last_name', 'full_name', 'name']);

/** A fact that makes a draft about THIS lead: a real lead field, not the lead's own name. */
export function isSubstantiveLeadFact(f: Fact): boolean {
  if (f.sourceType !== 'lead_field') return false; // proof/kb support the pitch, not the lead
  return !IDENTITY_FIELDS.has(f.sourceRef.replace(/^lead\./, ''));
}

/** Total verified facts (any source) required before the Writer may run. */
export const MIN_FACTS = 2;
/** Substantive lead facts required for the 'personalized' label to be earned. */
export const MIN_LEAD_FACTS = 1;

/**
 * The labeling gate (defense layer 2), single-sourced and pure. 'personalized' is earned
 * only when we know enough overall AND at least one real thing about this specific lead —
 * org proof alone, or the lead's own name, never buys the label.
 */
export function decideDraftMode(
  grounded: Fact[],
): { mode: 'personalized' } | { mode: 'template'; reason: string } {
  if (grounded.length < MIN_FACTS) {
    return { mode: 'template', reason: 'insufficient verified facts' };
  }
  if (grounded.filter(isSubstantiveLeadFact).length < MIN_LEAD_FACTS) {
    return { mode: 'template', reason: 'no lead-specific facts' };
  }
  return { mode: 'personalized' };
}

export interface VerifyResult {
  ok: boolean;
  unverified: string[];
}

/**
 * Extract high-risk "hard" claims: %, $ amounts, 4+-digit numbers, and capitalized words that
 * are NOT sentence-initial (so greetings / "I" / sentence starts are skipped). A fabricated
 * company/product name surfaces as such a word and won't be in the corpus; known names
 * (recipient, company, proof) are in the corpus and pass.
 */
/** Fold diacritics (é→e) then drop non-alphanumerics. Applied identically to a body word AND to the
 *  corpus, so a real name with intra-word punctuation/accents — O'Brien, L'Oréal, Coca-Cola, Zoë —
 *  matches instead of being deleted into a different token and falsely flagged. Preserves case (the
 *  proper-noun regex needs the leading capital). */
export function foldToken(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]/g, '');
}

export function extractHardClaims(body: string): string[] {
  const claims = new Set<string>();
  for (const m of body.matchAll(/\$\s?\d[\d,.]*/g)) claims.add(m[0].trim());
  for (const m of body.matchAll(/\d[\d,.]*\s?%/g)) claims.add(m[0].trim());
  for (const m of body.matchAll(/\b\d{4,}\b/g)) claims.add(m[0]);
  for (const segment of body.split(/[.!?\n]+/)) {
    const words = segment.trim().split(/\s+/);
    for (let i = 1; i < words.length; i++) {
      const w = foldToken(words[i] ?? ''); // fold accents BEFORE stripping so é isn't lost as a letter
      if (/^[A-Z][a-zA-Z]{2,}$/.test(w)) claims.add(w);
    }
  }
  return [...claims];
}

/**
 * Verify a generated draft: every used fact id must be a provided fact, and every hard claim
 * in the body must trace to the allowed corpus (facts + lead fields + proof). Backstop only —
 * see the defense-layers note above.
 */
export function verifyDraft(
  body: string,
  allowedCorpus: string,
  usedFactIds: string[],
  factIds: string[],
): VerifyResult {
  const unverified: string[] = [];
  for (const id of usedFactIds) {
    if (!factIds.includes(id)) unverified.push(`unknown-fact:${id}`);
  }
  const rawCorpus = allowedCorpus.toLowerCase();
  // Folded corpus (accents dropped, punctuation removed) so a folded proper-noun claim matches a
  // corpus name with an apostrophe/accent/hyphen. Money/%/number claims are checked against the raw
  // corpus first, so they keep their exact form.
  const foldedCorpus = foldToken(allowedCorpus).toLowerCase();
  for (const claim of extractHardClaims(body)) {
    if (rawCorpus.includes(claim.toLowerCase())) continue;
    const fc = foldToken(claim).toLowerCase();
    if (fc && foldedCorpus.includes(fc)) continue;
    unverified.push(`unverified-claim:${claim}`);
  }
  return { ok: unverified.length === 0, unverified };
}
