import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { complete } from '../llm/complete.js';

const SuggestionSchema = z.object({
  label: z.string().min(1).max(120),
  query: z.string().min(1).max(300),
  entityType: z.enum(['person', 'company', 'local_business']),
});
const ResultSchema = z.object({ suggestions: z.array(SuggestionSchema).max(5) }).strict();
export type IcpSuggestion = z.infer<typeof SuggestionSchema>;

const ICP_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string' },
          query: { type: 'string' },
          entityType: { type: 'string', enum: ['person', 'company', 'local_business'] },
        },
        required: ['label', 'query', 'entityType'],
      },
    },
  },
  required: ['suggestions'],
};

export interface IcpInput {
  coachingPoints: string[];
  proofItems: string[];
}

const SYSTEM = [
  "You propose 3-5 ideal-customer-profile lead searches for a B2B sales team, based on the company's knowledge base.",
  'Each suggestion: a short human "label", a natural-language "query" the team could run on a lead database,',
  'and "entityType" (person | company | local_business). Base them only on the provided KB; do not invent unrelated industries.',
  'Return only JSON.',
].join(' ');

/** Generate ICP search suggestions from the org's KB. Model/parse failures → 502 (not user error). */
export async function icpSuggestions(kb: IcpInput): Promise<IcpSuggestion[]> {
  const content = [
    `Coaching points:\n${kb.coachingPoints.slice(0, 40).join('\n') || '(none)'}`,
    `\nProof / customers:\n${kb.proofItems.slice(0, 40).join('\n') || '(none)'}`,
  ].join('\n');

  const res = await complete('icp_suggestions', {
    system: SYSTEM,
    messages: [{ role: 'user', content }],
    jsonSchema: ICP_JSON_SCHEMA,
  });

  let raw: unknown;
  try {
    raw = JSON.parse(res.text);
  } catch {
    throw new AppError('Could not parse ICP suggestions', {
      code: 'icp_parse_failed',
      statusCode: 502,
    });
  }
  const parsed = ResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('Invalid ICP suggestions', { code: 'icp_invalid', statusCode: 502 });
  }
  return parsed.data.suggestions;
}
