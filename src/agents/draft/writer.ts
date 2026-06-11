import { z } from 'zod';
import { complete, type ProviderRegistry } from '../llm/complete.js';
import type { Usage } from '../llm/types.js';
import type { Fact } from './verify.js';

const WriterSchema = z
  .object({
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(1500),
    usedFactIds: z.array(z.string().max(40)).max(20),
  })
  .strict();

const WRITER_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    subject: { type: 'string' },
    body: { type: 'string' },
    usedFactIds: { type: 'array', items: { type: 'string' } },
  },
  required: ['subject', 'body', 'usedFactIds'],
};

export interface WriterResult {
  subject: string;
  body: string;
  usedFactIds: string[];
  usage?: Usage;
}
export interface WriterInput {
  facts: Fact[];
  coaching: string[];
  firstName?: string;
  companyName?: string;
  strictReminder?: boolean;
}

export async function runWriter(
  input: WriterInput,
  reg?: ProviderRegistry,
): Promise<WriterResult | null> {
  const factLines = input.facts.map((f) => `- [${f.id}] ${f.text}`).join('\n') || '(none)';
  const coaching = input.coaching.slice(0, 20).join('\n') || '(none)';
  const system = [
    'Write a concise B2B cold outbound email (~3-4 sentences, under 200 tokens).',
    'Follow the COACHING for tone/style. You may state ONLY facts from the FACTS list;',
    'do NOT add any other specific claim about the person or company (no invented numbers,',
    'companies, or achievements). Personalize using the recipient first name / company only.',
    'Return JSON {subject, body, usedFactIds} where usedFactIds lists the fact ids you used.',
    input.strictReminder
      ? 'IMPORTANT: a prior draft contained an unverifiable claim — use ONLY the listed facts.'
      : '',
  ].join(' ');
  const recipient =
    `${input.firstName ?? ''}${input.companyName ? ` at ${input.companyName}` : ''}`.trim();
  const content = `Recipient: ${recipient || '(unknown)'}\n\nCOACHING:\n${coaching}\n\nFACTS:\n${factLines}`;

  const res = await complete(
    'writer',
    { system, messages: [{ role: 'user', content }], jsonSchema: WRITER_JSON_SCHEMA },
    reg,
  );
  let raw: unknown;
  try {
    raw = JSON.parse(res.text);
  } catch {
    return null;
  }
  const parsed = WriterSchema.safeParse(raw);
  if (!parsed.success) return null;
  return {
    ...parsed.data,
    usage: { model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens },
  };
}
