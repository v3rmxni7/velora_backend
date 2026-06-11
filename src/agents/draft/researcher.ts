import { z } from 'zod';
import { complete, type ProviderRegistry } from '../llm/complete.js';
import type { Usage } from '../llm/types.js';
import type { Fact } from './verify.js';

const FactSchema = z.object({
  id: z.string().min(1).max(40),
  text: z.string().min(1).max(300),
  sourceType: z.enum(['kb_chunk', 'lead_field', 'proof_item']),
  sourceRef: z.string().min(1).max(200),
  confidence: z.number().min(0).max(1),
});

// Structured-output schema for the model: types + enums + structure only (Anthropic rejects
// maxItems/maxLength; per-fact Zod below enforces caps). DeepSeek uses JSON mode (no schema
// enforcement), so the parser tolerates shape drift and the Zod gate stays authoritative.
const RESEARCHER_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          sourceType: { type: 'string', enum: ['kb_chunk', 'lead_field', 'proof_item'] },
          sourceRef: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['id', 'text', 'sourceType', 'sourceRef', 'confidence'],
      },
    },
  },
  required: ['facts'],
};

export interface ResearcherInputs {
  leadFields: Record<string, string>;
  proof: { id: string; text: string }[];
  kbChunks: { id: string; content: string }[];
}
export interface ResearchResult {
  facts: Fact[];
  /** Source ids we actually provided — used to drop fabricated/false-cited facts. */
  allowedRefs: Set<string>;
  usage?: Usage;
}

const SYSTEM = [
  'You extract VERIFIED facts about a sales lead, each bound to its source.',
  'Use ONLY the provided sources. Each source has a bracketed id like [lead.title], [proof.<id>], or [kb.<id>].',
  'For every fact, set sourceRef to EXACTLY one of those ids and sourceType accordingly (lead_field | proof_item | kb_chunk).',
  'Do NOT invent facts or sources. confidence in 0..1. Return at most 8 concise facts (each under 12 words).',
  'Return ONLY this JSON shape: {"facts":[{"id":"f1","text":"...","sourceType":"lead_field","sourceRef":"lead.title","confidence":0.9}]}',
].join(' ');

/** Normalize provider shape drift (array vs {facts}, `fact`→`text`, missing id, bracketed ref). */
function coerceFactArray(raw: unknown): unknown[] {
  const arr = Array.isArray(raw) ? raw : (raw as { facts?: unknown } | null)?.facts;
  if (!Array.isArray(arr)) return [];
  return arr.map((item, i) => {
    const o = (item ?? {}) as Record<string, unknown>;
    const text = typeof o.text === 'string' ? o.text : typeof o.fact === 'string' ? o.fact : '';
    const sourceRef =
      typeof o.sourceRef === 'string' ? o.sourceRef.replace(/[[\]]/g, '').trim() : o.sourceRef;
    return {
      id: typeof o.id === 'string' && o.id ? o.id : `fact_${i + 1}`,
      text,
      sourceType: o.sourceType,
      sourceRef,
      confidence: o.confidence,
    };
  });
}

export async function runResearcher(
  inputs: ResearcherInputs,
  reg?: ProviderRegistry,
): Promise<ResearchResult> {
  const allowedRefs = new Set<string>();
  const leadLines = Object.entries(inputs.leadFields).map(([k, v]) => {
    const ref = `lead.${k}`;
    allowedRefs.add(ref);
    return `- [${ref}] ${v}`;
  });
  const proofLines = inputs.proof.map((p) => {
    const ref = `proof.${p.id}`;
    allowedRefs.add(ref);
    return `- [${ref}] ${p.text}`;
  });
  const kbLines = inputs.kbChunks.map((c) => {
    const ref = `kb.${c.id}`;
    allowedRefs.add(ref);
    return `- [${ref}] ${c.content}`;
  });
  const content = [
    `LEAD FIELDS:\n${leadLines.join('\n') || '(none)'}`,
    `\nPROOF:\n${proofLines.join('\n') || '(none)'}`,
    `\nKNOWLEDGE:\n${kbLines.join('\n') || '(none)'}`,
  ].join('\n');

  const res = await complete(
    'researcher',
    {
      system: SYSTEM,
      messages: [{ role: 'user', content }],
      jsonSchema: RESEARCHER_JSON_SCHEMA,
      maxOutputTokens: 1500, // headroom so JSON-mode providers don't truncate
    },
    reg,
  );
  const usage: Usage = {
    model: res.model,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
  };

  let raw: unknown;
  try {
    raw = JSON.parse(res.text);
  } catch {
    return { facts: [], allowedRefs, usage };
  }
  // Validate per-fact and keep the valid ones (tolerant of partial drift; the gate is still hard).
  const facts: Fact[] = [];
  for (const candidate of coerceFactArray(raw)) {
    const parsed = FactSchema.safeParse(candidate);
    if (parsed.success) facts.push(parsed.data);
  }
  return { facts, allowedRefs, usage };
}
