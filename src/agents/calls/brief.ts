import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from '../../config/env.js';
import { createOpenAIEmbeddings } from '../../integrations/embeddings/openai.js';
import { campaignTypeCoaching, type LeadType } from '../draft/generate.js';

// Phase 4 Slice 4.9 — the CALL BRIEF, assembled ON READ from REAL data (no LLM). Reuses the Writer's
// grounding gather (coaching/proof/KB) MINUS the Writer. The "talking points" LLM synthesis is a
// deferred enhancement — with the Writer unavailable (exhausted credits) it is an honest-shell
// {unavailable, []}, never fabricated, never coaching-echoed-as-LLM. The KB embedding call is guarded
// (createOpenAIEmbeddings throws a 503 synchronously when unconfigured) → kbChunks=[] never a 500.

const LEAD_TABLE: Record<LeadType, string> = {
  person: 'people',
  company: 'companies',
  local_business: 'local_businesses',
};

export interface CallRecord {
  id: string;
  organization_id: string;
  lead_type: LeadType;
  lead_id: string;
  thread_id: string | null;
  campaign_id: string | null;
  phone: string | null;
  status: string;
  outcome: string | null;
  scheduled_at: string | null;
  called_at: string | null;
}

export interface BriefMessage {
  direction: string;
  channel: string;
  subject: string | null;
  status: string;
  category: string | null;
  at: string;
  snippet: string;
}
export interface CallBrief {
  call: {
    id: string;
    status: string;
    outcome: string | null;
    phone: string | null;
    scheduledAt: string | null;
    calledAt: string | null;
  };
  lead: {
    leadType: LeadType;
    leadId: string;
    name: string | null;
    title: string | null;
    company: string | null;
    industry: string | null;
    location: string | null;
    phone: string | null;
  };
  pastInteractions: { threadCount: number; lastMessageAt: string | null; summary: BriefMessage[] };
  grounding: {
    coachingPoints: string[];
    proofItems: { id: string; text: string }[];
    icp: { id: string; name: string }[];
    kbChunks: { id: string; content: string }[];
    campaignAngle: string | null;
  };
  talkingPoints: { status: 'generated' | 'unavailable'; items: string[] };
}

/** PURE: a plain truncation of a message body (no LLM narrative). */
export function snippet(body: string | null | undefined, max = 160): string {
  const s = (body ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** PURE: the newest `limit` messages → an honest summary (deterministic; never an LLM summary). */
export function summarizeMessages(
  rows: {
    direction: string;
    channel: string;
    subject: string | null;
    status: string;
    category: string | null;
    created_at: string;
    body: string | null;
  }[],
  limit = 5,
): BriefMessage[] {
  return rows.slice(0, limit).map((m) => ({
    direction: m.direction,
    channel: m.channel,
    subject: m.subject,
    status: m.status,
    category: m.category,
    at: m.created_at,
    snippet: snippet(m.body),
  }));
}

function leadView(leadType: LeadType, lead: Record<string, unknown>) {
  const s = (k: string) => (lead[k] == null ? null : String(lead[k]));
  if (leadType === 'person') {
    return {
      name: s('full_name') ?? ([s('first_name'), s('last_name')].filter(Boolean).join(' ') || null),
      title: s('title'),
      company: s('company_name'),
      industry: null as string | null,
      location: s('location'),
      phone: s('phone'),
    };
  }
  if (leadType === 'company') {
    return {
      name: s('name'),
      title: null,
      company: s('name'),
      industry: s('industry'),
      location: s('location'),
      phone: null,
    };
  }
  return {
    name: s('name'),
    title: s('category'),
    company: s('name'),
    industry: s('category'),
    location: s('city'),
    phone: s('phone'),
  };
}

/**
 * Assemble the brief for a loaded call row, under the caller's (RLS) client. Always returns real
 * structured data; the KB block is guarded so it degrades to [] (never 500) when OpenAI is absent.
 */
export async function assembleBrief(
  db: SupabaseClient,
  organizationId: string,
  call: CallRecord,
): Promise<CallBrief> {
  const leadRes = await db
    .from(LEAD_TABLE[call.lead_type])
    .select('*')
    .eq('id', call.lead_id)
    .maybeSingle();
  if (leadRes.error) throw leadRes.error;
  const lead = (leadRes.data ?? {}) as Record<string, unknown>;
  const lv = leadView(call.lead_type, lead);

  // Past interactions: all threads for the lead + their newest messages (RLS-scoped to the org).
  const threads = await db
    .from('threads')
    .select('id')
    .eq('lead_type', call.lead_type)
    .eq('lead_id', call.lead_id);
  if (threads.error) throw threads.error;
  const threadIds = (threads.data ?? []).map((t) => t.id as string);
  let summary: BriefMessage[] = [];
  let lastMessageAt: string | null = null;
  if (threadIds.length > 0) {
    const msgs = await db
      .from('messages')
      .select('direction, channel, subject, body, status, category, created_at')
      .in('thread_id', threadIds)
      .order('created_at', { ascending: false })
      .limit(5);
    if (msgs.error) throw msgs.error;
    const rows = (msgs.data ?? []) as Parameters<typeof summarizeMessages>[0];
    summary = summarizeMessages(rows);
    lastMessageAt = (rows[0]?.created_at as string | undefined) ?? null;
  }

  // Grounding (REAL, verbatim, labeled) — the Writer's gather minus the Writer.
  const [cpRes, piRes, icpRes] = await Promise.all([
    db.from('coaching_points').select('content').limit(20),
    db.from('proof_items').select('id, title, body').limit(20),
    db.from('icp_profiles').select('id, name').limit(10),
  ]);
  if (cpRes.error) throw cpRes.error;
  if (piRes.error) throw piRes.error;
  if (icpRes.error) throw icpRes.error;
  const coachingPoints = (cpRes.data ?? []).map((r) => String(r.content));
  const proofItems = (piRes.data ?? []).map((r) => ({
    id: String(r.id),
    text: [r.title, r.body].filter(Boolean).join(' — '),
  }));
  const icp = (icpRes.data ?? []).map((r) => ({ id: String(r.id), name: String(r.name) }));

  let campaignAngle: string | null = null;
  if (call.campaign_id) {
    const camp = await db
      .from('campaigns')
      .select('campaign_type')
      .eq('id', call.campaign_id)
      .maybeSingle();
    if (camp.error) throw camp.error;
    campaignAngle = campaignTypeCoaching(camp.data?.campaign_type as string | null | undefined);
  }

  // KB retrieval — GUARDED (createOpenAIEmbeddings throws a 503 synchronously when unconfigured; the
  // RPC/embed may also throw). Any failure → kbChunks = [] (honest-empty), NEVER a 500.
  let kbChunks: { id: string; content: string }[] = [];
  const queryText = [lv.title, lv.company ?? lv.name, lv.industry].filter(Boolean).join(' ');
  if (env.OPENAI_API_KEY && queryText) {
    try {
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
    } catch {
      kbChunks = [];
    }
  }

  return {
    call: {
      id: call.id,
      status: call.status,
      outcome: call.outcome,
      phone: call.phone,
      scheduledAt: call.scheduled_at,
      calledAt: call.called_at,
    },
    lead: { leadType: call.lead_type, leadId: call.lead_id, ...lv },
    pastInteractions: { threadCount: threadIds.length, lastMessageAt, summary },
    grounding: { coachingPoints, proofItems, icp, kbChunks, campaignAngle },
    // 🔌 LLM synthesis deferred — honest-shell. The structured grounding above IS the real brief.
    talkingPoints: { status: 'unavailable', items: [] },
  };
}
