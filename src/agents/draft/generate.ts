import type { SupabaseClient } from '@supabase/supabase-js';
import { createOpenAIEmbeddings } from '../../integrations/embeddings/openai.js';
import { AppError } from '../../lib/errors.js';
import type { ProviderRegistry } from '../llm/complete.js';
import type { Usage } from '../llm/types.js';
import { type ResearcherInputs, type ResearchResult, runResearcher } from './researcher.js';
import { renderTemplate } from './template.js';
import { decideDraftMode, type Fact, filterFacts, verifyDraft } from './verify.js';
import { runWriter, type WriterInput, type WriterResult } from './writer.js';

// MIN_FACTS / MIN_LEAD_FACTS live with the gate in verify.ts (decideDraftMode).
const MIN_FACT_CONFIDENCE = 0.6;

// Per-type coaching (4.3): steers the angle for non-cold campaign types. cold_outbound returns null
// → NO extra coaching line → a cold draft is byte-identical to Phase-2 (preserves dedupe + tests).
const CAMPAIGN_TYPE_COACHING: Record<string, string> = {
  warm_outbound:
    'This is a warm outbound campaign — the recipient is an existing contact from the customer’s CRM; reference the existing relationship rather than introducing the company from scratch.',
  cross_sell:
    'This is a cross-sell/upsell to an EXISTING customer; acknowledge they already use the product and focus on one relevant expansion, not a cold pitch.',
  website_visitor:
    'This recipient recently visited the customer’s website; reference that timely interest naturally as the reason for reaching out.',
  intent_signals:
    'This lead was surfaced by a timely intent signal (e.g. a funding round or a new senior hire); lead with that trigger as the reason for reaching out now.',
};

/** The coaching line for a campaign type, or null for cold/unknown (no extra steering). PURE. */
export function campaignTypeCoaching(campaignType: string | null | undefined): string | null {
  return CAMPAIGN_TYPE_COACHING[campaignType ?? ''] ?? null;
}

export type LeadType = 'person' | 'company' | 'local_business';
const TABLE: Record<LeadType, string> = {
  person: 'people',
  company: 'companies',
  local_business: 'local_businesses',
};
const LEAD_FIELD_KEYS: Record<LeadType, string[]> = {
  person: [
    'full_name',
    'first_name',
    'last_name',
    'title',
    'seniority',
    'department',
    'company_name',
    'location',
    'country',
  ],
  company: ['name', 'domain', 'industry', 'size_band', 'location', 'country'],
  local_business: ['name', 'category', 'city', 'country'],
};

export interface GenerateInput {
  db: SupabaseClient; // service-role
  organizationId: string;
  leadType: LeadType;
  leadId: string;
  campaignId?: string | null;
  /** Sequence step (1 = first touch). >1 coaches the Writer to produce a brief follow-up. */
  stepNumber?: number;
  /** A/Z cohort (4.4). Resolved here to a steering angle; null → no angle → byte-identical draft. */
  variantId?: string | null;
}
// Injectable seams (default to the real LLM agents) — lets verification fire the template
// path deterministically and run the cheap-tier A/B by swapping the provider registry.
export interface GenerateDeps {
  researcher?: (inputs: ResearcherInputs) => Promise<ResearchResult>;
  writer?: (input: WriterInput) => Promise<WriterResult | null>;
  registry?: ProviderRegistry;
}

export interface DraftPayload {
  subject: string;
  body: string;
  draftMode: 'personalized' | 'template';
  confidence: number;
  reason?: string;
  grounding: {
    mode: 'personalized' | 'template';
    overallConfidence: number; // task-level
    facts: Fact[]; // each carries its own per-fact confidence
    usedFactIds: string[];
    verification: { ok: boolean; unverified: string[]; regenerated: boolean };
  };
  usage?: { researcher?: Usage; writer?: Usage };
}

function buildLeadFields(
  leadType: LeadType,
  lead: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of LEAD_FIELD_KEYS[leadType]) {
    const v = lead[k];
    if (typeof v === 'string' && v.trim()) out[k] = v;
  }
  return out;
}

export async function generateDraft(
  input: GenerateInput,
  deps: GenerateDeps = {},
): Promise<DraftPayload> {
  const { db, organizationId, leadType, leadId } = input;
  const research = deps.researcher ?? ((i: ResearcherInputs) => runResearcher(i, deps.registry));
  const write = deps.writer ?? ((i: WriterInput) => runWriter(i, deps.registry));

  const leadRes = await db
    .from(TABLE[leadType])
    .select('*')
    .eq('id', leadId)
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (leadRes.error) throw leadRes.error;
  if (!leadRes.data)
    throw new AppError('Lead not found', { code: 'lead_not_found', statusCode: 404 });
  const lead = leadRes.data as Record<string, unknown>;
  const leadFields = buildLeadFields(leadType, lead);

  const [cpRes, piRes] = await Promise.all([
    db.from('coaching_points').select('content').eq('organization_id', organizationId).limit(20),
    db
      .from('proof_items')
      .select('id, title, body')
      .eq('organization_id', organizationId)
      .limit(20),
  ]);
  const coachingPoints = (cpRes.data ?? []).map((r) => String(r.content));
  // Steering lines (follow-up cue, campaign-type angle, A/Z variant angle) go at the FRONT of
  // coaching[] so they always survive the Writer's coaching.slice(0,20) cap, even for an org with
  // many coaching points (4.4; also fixes a latent 3.2/4.3 truncation). When there are NO steering
  // lines (a cold step-1 with no variant) coaching === coachingPoints → byte-identical to pre-4.4.
  const steering: string[] = [];
  // Follow-up steps (step 2+) get a brief-follow-up cue; step 1 gets none.
  if ((input.stepNumber ?? 1) > 1) {
    steering.push(
      'This is a brief follow-up to an earlier, unanswered email. Acknowledge the prior note in one short line, add a single fresh reason to reply, and keep it shorter than a first touch. Do NOT repeat the first email.',
    );
  }
  // 4.3 type angle + 4.4 variant angle — resolved HERE (the single site already hitting campaigns).
  // cold/unknown type → no line; null variant → no line (each keeps the byte-identical guarantee).
  if (input.campaignId) {
    const camp = await db
      .from('campaigns')
      .select('campaign_type')
      .eq('id', input.campaignId)
      .maybeSingle();
    const typeLine = campaignTypeCoaching(camp.data?.campaign_type as string | null | undefined);
    if (typeLine) steering.push(typeLine);
  }
  if (input.variantId) {
    const v = await db
      .from('campaign_variants')
      .select('angle')
      .eq('id', input.variantId)
      .maybeSingle();
    const angle = (v.data?.angle as string | null | undefined) ?? null;
    if (angle?.trim()) steering.push(angle.trim());
  }
  const coaching = [...steering, ...coachingPoints];
  const proof = (piRes.data ?? []).map((r) => ({
    id: String(r.id),
    text: [r.title, r.body].filter(Boolean).join(' — '),
  }));

  // KB retrieval via embedding + match_kb_chunks (org-scoped). Skipped when there's no query.
  const queryText = [
    leadFields.title,
    leadFields.company_name ?? leadFields.name,
    leadFields.industry,
  ]
    .filter(Boolean)
    .join(' ');
  let kbChunks: { id: string; content: string }[] = [];
  if (queryText) {
    const [emb] = await createOpenAIEmbeddings().embed([queryText]);
    if (emb) {
      const m = await db.rpc('match_kb_chunks', {
        p_org_id: organizationId,
        p_query_embedding: emb,
        p_match_count: 6,
      });
      if (!m.error && Array.isArray(m.data)) {
        kbChunks = (m.data as { id: unknown; content: unknown }[]).map((c) => ({
          id: String(c.id),
          content: String(c.content),
        }));
      }
    }
  }

  const result = await research({ leadFields, proof, kbChunks });
  const researcherUsage = result.usage;
  const grounded = filterFacts(result.facts, result.allowedRefs, MIN_FACT_CONFIDENCE);
  const overallConfidence = grounded.length
    ? Math.round((grounded.reduce((s, f) => s + f.confidence, 0) / grounded.length) * 1000) / 1000
    : 0;

  const firstName = typeof lead.first_name === 'string' ? lead.first_name : undefined;
  const companyName =
    leadFields.company_name ?? (leadType !== 'person' ? leadFields.name : undefined);
  const valueProp = proof[0]?.text ?? coaching[0] ?? '';

  // Gate (verify.ts decideDraftMode): 'personalized' must be earned — enough verified
  // facts AND at least one substantive lead fact; otherwise the safe template (the
  // strong Writer never runs).
  const decision = decideDraftMode(grounded);
  if (decision.mode === 'template') {
    const t = renderTemplate({ firstName, companyName }, valueProp);
    return {
      ...t,
      draftMode: 'template',
      confidence: overallConfidence,
      reason: decision.reason,
      grounding: {
        mode: 'template',
        overallConfidence,
        facts: grounded,
        usedFactIds: [],
        verification: { ok: true, unverified: [], regenerated: false },
      },
      usage: { researcher: researcherUsage },
    };
  }

  // Writer + deterministic post-gen verification, with one regeneration on failure.
  const allowedCorpus = [
    ...grounded.map((f) => f.text),
    ...Object.values(leadFields),
    ...proof.map((p) => p.text),
  ]
    .filter(Boolean)
    .join(' ');
  const factIds = grounded.map((f) => f.id);

  let verification = { ok: false, unverified: [] as string[] };
  let regenerated = false;
  let writerUsage: Usage | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) regenerated = true;
    const w = await write({
      facts: grounded,
      coaching,
      firstName,
      companyName,
      strictReminder: attempt > 0,
    });
    if (!w) continue;
    writerUsage = w.usage;
    const v = verifyDraft(w.body, allowedCorpus, w.usedFactIds, factIds);
    if (v.ok) {
      return {
        subject: w.subject,
        body: w.body,
        draftMode: 'personalized',
        confidence: overallConfidence,
        grounding: {
          mode: 'personalized',
          overallConfidence,
          facts: grounded,
          usedFactIds: w.usedFactIds,
          verification: { ...v, regenerated },
        },
        usage: { researcher: researcherUsage, writer: writerUsage },
      };
    }
    verification = v;
  }

  // Both attempts failed verification → safe template.
  const t = renderTemplate({ firstName, companyName }, valueProp);
  return {
    ...t,
    draftMode: 'template',
    confidence: overallConfidence,
    reason: 'draft failed verification',
    grounding: {
      mode: 'template',
      overallConfidence,
      facts: grounded,
      usedFactIds: [],
      verification: { ...verification, regenerated: true },
    },
    usage: { researcher: researcherUsage, writer: writerUsage },
  };
}
