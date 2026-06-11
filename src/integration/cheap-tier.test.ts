import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateDraft } from '../agents/draft/generate.js';
import type { ProviderRegistry } from '../agents/llm/complete.js';
import { createAnthropicProvider } from '../agents/llm/providers/anthropic.js';
import { createDeepSeekProvider } from '../agents/llm/providers/deepseek.js';
import type { Usage } from '../agents/llm/types.js';
import { env } from '../config/env.js';

// Opt-in (RUN_DB_IT=1) — A/B: same lead through the draft loop on Anthropic-only vs DeepSeek
// researcher (Writer held on Sonnet). Hits the live DB + real Anthropic/DeepSeek/OpenAI.
const ready =
  process.env.RUN_DB_IT === '1' &&
  !!env.SUPABASE_URL &&
  !!env.SUPABASE_ANON_KEY &&
  !!env.SUPABASE_SERVICE_ROLE_KEY &&
  !!env.ANTHROPIC_API_KEY &&
  !!env.OPENAI_API_KEY &&
  !!env.DEEPSEEK_API_KEY;

const SUPABASE_URL = env.SUPABASE_URL ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

// $/1M tokens (corrected pricing).
const PRICE: Record<string, { in: number; out: number }> = {
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'deepseek-chat': { in: 0.14, out: 0.28 },
};
const cost = (u?: Usage): number => {
  if (!u) return 0;
  const p = PRICE[u.model] ?? { in: 0, out: 0 };
  return (u.inputTokens * p.in + u.outputTokens * p.out) / 1_000_000;
};

describe.skipIf(!ready)('Slice 3b live — cheap-tier A/B (Anthropic vs DeepSeek researcher)', () => {
  const admin = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stamp = Date.now();
  let orgId = '';
  let leadId = '';

  beforeAll(async () => {
    const org = await admin
      .from('organizations')
      .insert({ name: `s3b-${stamp}` })
      .select('id')
      .single();
    if (org.error) throw org.error;
    orgId = org.data.id as string;
    await admin.from('coaching_points').insert({
      organization_id: orgId,
      content: 'Friendly, concise, value-first tone. One clear CTA. No hype.',
    });
    await admin.from('proof_items').insert({
      organization_id: orgId,
      category: 'customer',
      title: 'Acme',
      body: 'Helped a SaaS engineering team ship faster.',
    });
    const lead = await admin
      .from('people')
      .insert({
        organization_id: orgId,
        provider: 'seed',
        external_id: `s3b:${stamp}`,
        first_name: 'Jordan',
        last_name: 'Lee',
        full_name: 'Jordan Lee',
        title: 'CTO',
        seniority: 'c_level',
        department: 'engineering',
        company_name: 'Nimbus Labs',
        location: 'San Francisco',
        country: 'US',
        source: 'find_leads',
      })
      .select('id')
      .single();
    if (lead.error) throw lead.error;
    leadId = lead.data.id as string;
  }, 120_000);

  afterAll(async () => {
    if (orgId) await admin.from('organizations').delete().eq('id', orgId);
  });

  it('runs the same lead on both tiers; Writer unchanged; prints drafts + tokens + cost', async () => {
    const anthropicOnly: ProviderRegistry = { anthropic: createAnthropicProvider() };
    const cheap: ProviderRegistry = {
      anthropic: createAnthropicProvider(),
      deepseek: createDeepSeekProvider(),
    };

    const a = await generateDraft(
      { db: admin, organizationId: orgId, leadType: 'person', leadId },
      { registry: anthropicOnly },
    );
    const b = await generateDraft(
      { db: admin, organizationId: orgId, leadType: 'person', leadId },
      { registry: cheap },
    );

    const report = (label: string, p: typeof a) => {
      const rc = cost(p.usage?.researcher);
      const wc = cost(p.usage?.writer);
      console.error(
        `\n===== ${label} =====\n` +
          `mode=${p.draftMode}  groundedFacts=${p.grounding.facts.length}\n` +
          `SUBJECT: ${p.subject}\nBODY:\n${p.body}\n` +
          `researcher: ${JSON.stringify(p.usage?.researcher)}  $${rc.toFixed(6)}\n` +
          `writer:     ${JSON.stringify(p.usage?.writer)}  $${wc.toFixed(6)}\n` +
          `per-lead AI cost: $${(rc + wc).toFixed(6)}`,
      );
    };
    report('A — Anthropic-only (Haiku researcher)', a);
    report('B — Cheap (DeepSeek researcher)', b);

    // Researcher provider actually swapped per registry:
    expect(a.usage?.researcher?.model).toBe('claude-haiku-4-5');
    expect(b.usage?.researcher?.model?.startsWith('deepseek')).toBe(true);
    // Writer held on Sonnet in both:
    if (a.draftMode === 'personalized') expect(a.usage?.writer?.model).toBe('claude-sonnet-4-6');
    if (b.draftMode === 'personalized') expect(b.usage?.writer?.model).toBe('claude-sonnet-4-6');
    // Both produce a usable draft:
    expect(a.body.length).toBeGreaterThan(0);
    expect(b.body.length).toBeGreaterThan(0);
  }, 120_000);
});
