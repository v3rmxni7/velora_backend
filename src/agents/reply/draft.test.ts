import { describe, expect, it } from 'vitest';
import type { Fact } from '../draft/verify.js';
import { type ComposeReplyInput, composeReplyDraft, type ReplyDraftDeps } from './draft.js';

const proof: Fact = {
  id: 'proof.p1',
  text: 'cut onboarding time 40%',
  sourceType: 'proof_item',
  sourceRef: 'proof.p1',
  confidence: 1,
};

const base: Omit<ComposeReplyInput, 'category'> & { category: ComposeReplyInput['category'] } = {
  category: 'interested',
  inboundBody: 'Sounds interesting, tell me more.',
  priorOutbound: { subject: 'Quick idea', body: 'We help teams onboard faster.' },
  coaching: ['Be concise.'],
  proofFacts: [proof],
};

// A draft stub that returns a queued sequence of outputs (to drive regen).
const stub = (
  ...outs: ({ subject: string; body: string; usedFactIds: string[] } | null)[]
): ReplyDraftDeps => {
  let i = 0;
  return { draft: async () => outs[Math.min(i++, outs.length - 1)] ?? null };
};

describe('composeReplyDraft (grounded reply, human-reviewed)', () => {
  it('a clean reply citing a proof fact → personalized + verified', async () => {
    const deps = stub({
      subject: 'Re: Quick idea',
      body: 'Thanks! We cut onboarding time 40%. Open to a quick call next week?',
      usedFactIds: ['proof.p1'],
    });
    const r = await composeReplyDraft(base, deps);
    expect(r.draftMode).toBe('personalized');
    expect(r.grounding.verification.ok).toBe(true);
    expect(r.grounding.usedFactIds).toEqual(['proof.p1']);
    expect(r.confidence).toBeCloseTo(1, 3);
    expect(r.body).toContain('40%');
  });

  it('a fabricated hard claim fails verification twice → safe claim-free fallback (template)', async () => {
    // Both attempts invent "35%" (not in the corpus) → verify rejects → fallback.
    const bad = { subject: 'Re: x', body: 'We boosted revenue 35% last quarter.', usedFactIds: [] };
    const r = await composeReplyDraft(base, stub(bad, bad));
    expect(r.draftMode).toBe('template');
    expect(r.grounding.usedFactIds).toEqual([]);
    expect(r.grounding.verification.regenerated).toBe(true);
    expect(r.grounding.verification.ok).toBe(true); // the fallback itself is claim-free
    expect(r.body).not.toContain('35%');
    expect(r.body.toLowerCase()).toContain('call');
  });

  it('one bad attempt then a good one → regenerated + verified personalized', async () => {
    const r = await composeReplyDraft(
      base,
      stub(
        { subject: 'Re: x', body: 'We grew 99% somehow.', usedFactIds: [] }, // bad: 99% not in corpus
        {
          subject: 'Re: x',
          body: 'We cut onboarding time 40%. Worth a chat?',
          usedFactIds: ['proof.p1'],
        },
      ),
    );
    expect(r.grounding.verification.ok).toBe(true);
    expect(r.grounding.verification.regenerated).toBe(true);
    expect(r.draftMode).toBe('personalized');
  });

  it('acknowledging the prospect’s own words is NOT flagged (inbound is in the corpus)', async () => {
    // 'Acme' is a proper noun, but it came from the inbound body → allowed (not a fabrication).
    const input: ComposeReplyInput = { ...base, inboundBody: 'We already use Acme for this.' };
    const r = await composeReplyDraft(
      input,
      stub({
        subject: 'Re: x',
        body: 'Makes sense that you use Acme — happy to compare notes.',
        usedFactIds: [],
      }),
    );
    expect(r.grounding.verification.ok).toBe(true);
    expect(r.body).toContain('Acme');
    expect(r.draftMode).toBe('template'); // verified but cited no proof fact
  });
});
