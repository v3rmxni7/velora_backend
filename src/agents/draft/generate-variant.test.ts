import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { type GenerateDeps, generateDraft } from './generate.js';
import type { ResearchResult } from './researcher.js';
import type { WriterInput, WriterResult } from './writer.js';

// Proves the 4.4 variant ANGLE threads into the grounded Writer's coaching[] — and that a no-variant
// draft is byte-identical — WITHOUT a live LLM (fake researcher + writer via deps). The fake
// researcher returns 2 substantive lead facts so decideDraftMode → 'personalized' and the Writer
// runs; the fake writer captures the coaching array it was handed.

// A minimal fake Supabase client answering only the queries generateDraft makes. The fake lead has
// no title/company/industry → queryText is empty → no embeddings/RPC (no OpenAI call).
function fakeDb(cfg: {
  coaching: string[];
  campaignType?: string;
  angle?: string;
}): SupabaseClient {
  const single: Record<string, unknown> = {
    people: { full_name: 'Jordan Lee' },
    campaigns: { campaign_type: cfg.campaignType ?? 'cold_outbound' },
    campaign_variants: cfg.angle != null ? { angle: cfg.angle } : null,
  };
  const list: Record<string, unknown[]> = {
    coaching_points: cfg.coaching.map((content) => ({ content })),
    proof_items: [],
  };
  const make = (table: string) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: () => Promise.resolve({ data: list[table] ?? [], error: null }),
      maybeSingle: () => Promise.resolve({ data: single[table] ?? null, error: null }),
    };
    return chain;
  };
  return { from: (t: string) => make(t) } as unknown as SupabaseClient;
}

const fakeResearcher = async (): Promise<ResearchResult> => ({
  facts: [
    {
      id: 'f1',
      text: 'leads engineering',
      sourceType: 'lead_field',
      sourceRef: 'lead.title',
      confidence: 0.9,
    },
    {
      id: 'f2',
      text: 'in the platform org',
      sourceType: 'lead_field',
      sourceRef: 'lead.department',
      confidence: 0.9,
    },
  ],
  allowedRefs: new Set(['lead.title', 'lead.department']),
  usage: undefined,
});

function depsCapturing(sink: (coaching: string[]) => void): GenerateDeps {
  return {
    researcher: fakeResearcher,
    writer: async (input: WriterInput): Promise<WriterResult> => {
      sink([...input.coaching]);
      return { subject: 'Hi', body: 'Hello there.', usedFactIds: ['f1'], usage: undefined };
    },
  };
}

const base = { organizationId: 'o', leadType: 'person' as const, leadId: 'l', campaignId: 'c' };

describe('generateDraft — variant angle threading (4.4)', () => {
  it('cold step-1, no variant → coaching is byte-identical (no steering prepended)', async () => {
    let captured: string[] = [];
    await generateDraft(
      { db: fakeDb({ coaching: ['cp-1', 'cp-2'] }), ...base },
      depsCapturing((c) => (captured = c)),
    );
    expect(captured).toEqual(['cp-1', 'cp-2']);
  });

  it('a variant angle is threaded to the FRONT of the Writer coaching', async () => {
    let captured: string[] = [];
    await generateDraft(
      {
        db: fakeDb({ coaching: ['cp-1'], angle: 'lead with peer social proof' }),
        ...base,
        variantId: 'v1',
      },
      depsCapturing((c) => (captured = c)),
    );
    expect(captured[0]).toBe('lead with peer social proof');
    expect(captured).toContain('cp-1');
  });

  it('the angle survives the Writer 20-line cap even with >20 coaching points (front-loaded)', async () => {
    let captured: string[] = [];
    const many = Array.from({ length: 25 }, (_, i) => `cp-${i}`);
    await generateDraft(
      { db: fakeDb({ coaching: many, angle: 'A-angle' }), ...base, variantId: 'v1' },
      depsCapturing((c) => (captured = c)),
    );
    // The Writer keeps coaching.slice(0,20); a front-loaded angle is always within it.
    expect(captured.slice(0, 20)).toContain('A-angle');
  });
});
