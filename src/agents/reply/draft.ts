import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { LeadType } from '../draft/generate.js';
import { type Fact, type VerifyResult, verifyDraft } from '../draft/verify.js';
import { complete, type ProviderRegistry } from '../llm/complete.js';
import type { ReplyCategory } from './classify.js';

// Phase 3 Slice 3.3b — the grounded REPLY writer. Drafts a reply to an inbound response for HUMAN
// review (a 'reply_approval' task). It is never sent (auto-send is 3.4). Anti-hallucination, like
// the cold writer: it may state ONLY proof facts (human-curated), the verifyDraft backstop catches
// fabricated hard claims, and a repeated failure falls back to a safe reply with zero specific
// claims. The inbound body + the prior outbound are in the corpus so acknowledging the prospect's
// words / referencing our first email is not flagged.

const ReplySchema = z
  .object({
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(1500),
    usedFactIds: z.array(z.string().max(40)).max(20),
  })
  .strip();

const REPLY_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    subject: { type: 'string' },
    body: { type: 'string' },
    usedFactIds: { type: 'array', items: { type: 'string' } },
  },
  required: ['subject', 'body', 'usedFactIds'],
};

type DraftOut = z.infer<typeof ReplySchema>;

export interface ReplyDraftDeps {
  /** Injectable LLM step (default = the configured 'reply_drafter' route). */
  draft?: (ctx: { system: string; user: string }) => Promise<DraftOut | null>;
  registry?: ProviderRegistry;
}

export interface ComposeReplyInput {
  category: ReplyCategory;
  inboundBody: string;
  priorOutbound?: { subject: string | null; body: string | null };
  coaching: string[];
  proofFacts: Fact[];
}

export interface ReplyDraftPayload {
  subject: string;
  body: string;
  draftMode: 'personalized' | 'template';
  confidence: number;
  grounding: {
    mode: 'personalized' | 'template';
    facts: Fact[];
    usedFactIds: string[];
    verification: VerifyResult & { regenerated: boolean };
  };
}

function defaultDraft(reg?: ProviderRegistry) {
  return async (ctx: { system: string; user: string }): Promise<DraftOut | null> => {
    const res = await complete(
      'reply_drafter',
      {
        system: ctx.system,
        messages: [{ role: 'user', content: ctx.user }],
        jsonSchema: REPLY_JSON_SCHEMA,
        maxOutputTokens: 400,
      },
      reg,
    );
    let raw: unknown;
    try {
      raw = JSON.parse(res.text);
    } catch {
      return null;
    }
    const parsed = ReplySchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  };
}

const SAFE_FALLBACK = {
  subject: 'Re: your reply',
  body: 'Thanks for getting back to me — happy to share more. Would you be open to a quick call next week?',
};

/**
 * Compose a grounded reply (PURE of the DB). Up to two writer attempts under the verify backstop;
 * a repeated failure degrades to a safe, claim-free reply (always verifies). Returns the payload to
 * store on a reply_approval task. The corpus includes the conversation context so acknowledging it
 * is allowed; only fabricated HARD claims (%/$/proper-nouns not in the corpus) are rejected.
 */
export async function composeReplyDraft(
  input: ComposeReplyInput,
  deps: ReplyDraftDeps = {},
): Promise<ReplyDraftPayload> {
  const draft = deps.draft ?? defaultDraft(deps.registry);
  const factIds = input.proofFacts.map((f) => f.id);
  const corpus = [
    ...input.proofFacts.map((f) => f.text),
    ...input.coaching,
    input.inboundBody,
    input.priorOutbound?.subject ?? '',
    input.priorOutbound?.body ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  const factLines = input.proofFacts.map((f) => `- [${f.id}] ${f.text}`).join('\n') || '(none)';
  const coaching = input.coaching.slice(0, 20).join('\n') || '(none)';
  const baseSystem = [
    'You are replying to an inbound response to a cold B2B sales email. Write a concise, friendly reply',
    `(2-4 sentences). The prospect's message was classified as "${input.category}". Acknowledge what they`,
    'said, address it, and propose ONE clear next step (e.g. a short call). You may state ONLY facts from',
    'the FACTS list — do NOT invent numbers, companies, customers, or achievements. Follow the COACHING',
    'for tone. Return JSON {subject, body, usedFactIds} where usedFactIds lists the fact ids you used.',
  ].join(' ');
  const user = [
    input.priorOutbound?.body ? `OUR FIRST EMAIL:\n${input.priorOutbound.body}\n` : '',
    `THEIR REPLY:\n${input.inboundBody}\n`,
    `COACHING:\n${coaching}\n`,
    `FACTS:\n${factLines}`,
  ].join('\n');

  for (let attempt = 0; attempt < 2; attempt++) {
    const regenerated = attempt > 0;
    const system = regenerated
      ? `${baseSystem} IMPORTANT: a prior draft contained an unverifiable claim — use ONLY the listed facts and no other specifics.`
      : baseSystem;
    const out = await draft({ system, user });
    if (!out) continue;
    const v = verifyDraft(out.body, corpus, out.usedFactIds, factIds);
    if (v.ok) {
      const usedProof = input.proofFacts.filter((f) => out.usedFactIds.includes(f.id));
      const grounded = usedProof.length > 0;
      const confidence = grounded
        ? Math.round((usedProof.reduce((s, f) => s + f.confidence, 0) / usedProof.length) * 1000) /
          1000
        : 0;
      return {
        subject: out.subject,
        body: out.body,
        draftMode: grounded ? 'personalized' : 'template',
        confidence,
        grounding: {
          mode: grounded ? 'personalized' : 'template',
          facts: input.proofFacts,
          usedFactIds: out.usedFactIds,
          verification: { ...v, regenerated },
        },
      };
    }
  }

  // Both attempts failed verification (or returned null) → safe, claim-free fallback. The fallback
  // body has no hard claims, so it verifies trivially (ok:true); draftMode 'template' + empty
  // usedFactIds + regenerated mark it as the safe path.
  return {
    subject: input.priorOutbound?.subject
      ? `Re: ${input.priorOutbound.subject}`
      : SAFE_FALLBACK.subject,
    body: SAFE_FALLBACK.body,
    draftMode: 'template',
    confidence: 0,
    grounding: {
      mode: 'template',
      facts: input.proofFacts,
      usedFactIds: [],
      verification: { ok: true, unverified: [], regenerated: true },
    },
  };
}

// ---- DB orchestration: load context → compose → file a reply_approval task (idempotent) ----

export interface RunReplyDraftInput {
  db: SupabaseClient; // service-role (Inngest job)
  organizationId: string;
  enrollmentId: string;
  threadId: string;
  /** The Smartlead message id of the inbound reply — namespaces the draft (one per reply). */
  inboundMessageId: string;
  category: ReplyCategory;
}

export async function runReplyDraft(
  input: RunReplyDraftInput,
  deps: ReplyDraftDeps = {},
): Promise<{ task: Record<string, unknown> | null }> {
  const { db, organizationId: org, enrollmentId, threadId, inboundMessageId, category } = input;

  const enr = await db
    .from('enrollments')
    .select('lead_type, lead_id, campaign_id')
    .eq('id', enrollmentId)
    .maybeSingle();
  if (enr.error) throw enr.error;
  if (!enr.data) return { task: null };

  // The inbound reply body (the message the inbound handler stored before enqueuing).
  const inboundKey = `reply:${org}:${enrollmentId}:${inboundMessageId}`;
  const inbound = await db
    .from('messages')
    .select('body')
    .eq('organization_id', org)
    .eq('dedupe_key', inboundKey)
    .maybeSingle();
  if (inbound.error) throw inbound.error;
  const inboundBody = (inbound.data?.body as string | null) ?? '';

  // The most recent outbound message in the thread (our prior touch) — conversation context.
  const prior = await db
    .from('messages')
    .select('subject, body')
    .eq('organization_id', org)
    .eq('thread_id', threadId)
    .eq('direction', 'outbound')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (prior.error) throw prior.error;

  const [cpRes, piRes] = await Promise.all([
    db.from('coaching_points').select('content').eq('organization_id', org).limit(20),
    db.from('proof_items').select('id, title, body').eq('organization_id', org).limit(20),
  ]);
  const coaching = (cpRes.data ?? []).map((r) => String(r.content));
  const proofFacts: Fact[] = (piRes.data ?? []).map((r) => ({
    id: `proof.${r.id}`,
    text: [r.title, r.body].filter(Boolean).join(' — '),
    sourceType: 'proof_item',
    sourceRef: `proof.${r.id}`,
    confidence: 1,
  }));

  const payload = await composeReplyDraft(
    {
      category,
      inboundBody,
      priorOutbound: prior.data
        ? { subject: prior.data.subject as string | null, body: prior.data.body as string | null }
        : undefined,
      coaching,
      proofFacts,
    },
    deps,
  );

  const dedupeKey = `reply_draft:${org}:${enrollmentId}:${inboundMessageId}`;
  const up = await db
    .from('tasks')
    .upsert(
      {
        organization_id: org,
        type: 'reply_approval',
        status: 'pending',
        lead_type: enr.data.lead_type as LeadType,
        lead_id: enr.data.lead_id as string,
        campaign_id: enr.data.campaign_id as string,
        thread_id: threadId,
        subject: payload.subject,
        body: payload.body,
        draft_mode: payload.draftMode,
        confidence: payload.confidence,
        grounding: payload.grounding,
        dedupe_key: dedupeKey,
      },
      { onConflict: 'organization_id,dedupe_key', ignoreDuplicates: true },
    )
    .select('*');
  if (up.error) throw up.error;
  return { task: (up.data ?? [])[0] ?? null };
}
