import { z } from 'zod';
import { complete } from '../llm/complete.js';
import type { Fact } from './verify.js';

const FactSchema = z.object({
  id: z.string().min(1).max(40),
  text: z.string().min(1).max(300),
  sourceType: z.enum(['kb_chunk', 'lead_field', 'proof_item']),
  sourceRef: z.string().min(1).max(200),
  confidence: z.number().min(0).max(1),
});
const ResearcherSchema = z.object({ facts: z.array(FactSchema).max(12) }).strict();

// Structured-output schema for the model: types + enums + structure only (Anthropic rejects
// maxItems/maxLength; Zod above enforces caps).
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
}

const SYSTEM = [
  'You extract VERIFIED facts about a sales lead, each bound to its source.',
  'Use ONLY the provided sources. Each source is shown with a bracketed id like [lead.title], [proof.<id>], or [kb.<id>].',
  'For every fact, set sourceRef to EXACTLY one of those bracketed ids (copy it verbatim) and set sourceType accordingly',
  '(lead_field | proof_item | kb_chunk). Do NOT invent facts or sources. confidence in 0..1. Return JSON only.',
].join(' ');

export async function runResearcher(inputs: ResearcherInputs): Promise<ResearchResult> {
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

  const res = await complete('researcher', {
    system: SYSTEM,
    messages: [{ role: 'user', content }],
    jsonSchema: RESEARCHER_JSON_SCHEMA,
  });
  let raw: unknown;
  try {
    raw = JSON.parse(res.text);
  } catch {
    return { facts: [], allowedRefs };
  }
  const parsed = ResearcherSchema.safeParse(raw);
  if (!parsed.success) return { facts: [], allowedRefs };
  // Models sometimes copy the bracketed id literally ("[lead.title]") — normalize to the bare id
  // so source-binding matches allowedRefs.
  const facts = parsed.data.facts.map((f) => ({
    ...f,
    sourceRef: f.sourceRef.replace(/[[\]]/g, '').trim(),
  }));
  return { facts, allowedRefs };
}
