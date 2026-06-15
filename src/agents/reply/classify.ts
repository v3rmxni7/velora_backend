import { z } from 'zod';
import { complete } from '../llm/complete.js';

// Reply classifier (Phase 2 Slice 2.6). Mirrors the icp.ts discipline: cheap-tier `complete`
// with a JSON schema + a Zod gate. Unlike icp/writer, a reply is inbound, untrusted text we do
// NOT want to fail on — parsing is total: any junk/empty/garbled output falls back to 'other'
// (the reply still escalates to the inbox; the category is only a triage hint).

export const REPLY_CATEGORIES = [
  'interested',
  'not_interested',
  'objection',
  'out_of_office',
  'unsubscribe',
  'other',
] as const;
export type ReplyCategory = (typeof REPLY_CATEGORIES)[number];

const ResultSchema = z.object({ category: z.enum(REPLY_CATEGORIES) }).strip();

const CLASSIFY_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: { category: { type: 'string', enum: [...REPLY_CATEGORIES] } },
  required: ['category'],
};

const SYSTEM = [
  'You classify a single inbound reply to a cold B2B sales email into ONE category.',
  'Categories: "interested" (wants to talk / asks for more / book a call),',
  '"not_interested" (clear no / not now / no budget), "objection" (a specific concern or pushback',
  'but not an outright no), "out_of_office" (auto-reply / vacation / left the company),',
  '"unsubscribe" (asks to stop / remove / opt out), "other" (anything else, ambiguous, or empty).',
  'Return only JSON: {"category": "..."}.',
].join(' ');

/** Total parser: never throws. Unknown/garbled shape → 'other'. */
export function parseClassification(raw: unknown): ReplyCategory {
  const parsed = ResultSchema.safeParse(raw);
  return parsed.success ? parsed.data.category : 'other';
}

/**
 * Classify an inbound reply body. Best-effort: model/parse failures degrade to 'other' rather
 * than throwing, so a webhook is never lost to a flaky LLM. Injectable in the send pipeline.
 */
export async function classifyReply(body: string): Promise<ReplyCategory> {
  const text = (body ?? '').trim();
  if (!text) return 'other';
  try {
    const res = await complete('reply_classifier', {
      system: SYSTEM,
      messages: [{ role: 'user', content: text.slice(0, 4000) }],
      jsonSchema: CLASSIFY_JSON_SCHEMA,
    });
    let raw: unknown;
    try {
      raw = JSON.parse(res.text);
    } catch {
      return 'other';
    }
    return parseClassification(raw);
  } catch {
    return 'other';
  }
}
