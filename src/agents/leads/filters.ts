import { z } from 'zod';
import type { EntityType } from '../../integrations/leads/types.js';
import { AppError } from '../../lib/errors.js';
import { complete } from '../llm/complete.js';

// Allowed-value vocabularies (mirror integrations/leads/types.ts). The Zod schemas
// below are the AUTHORITATIVE boundary; the JSON Schema handed to the model mirrors
// them so structured outputs constrain it at the model layer too.
const SENIORITIES = ['c_level', 'vp', 'director', 'manager', 'senior', 'mid', 'entry'] as const;
const DEPARTMENTS = [
  'engineering',
  'sales',
  'marketing',
  'product',
  'finance',
  'operations',
  'hr',
  'legal',
  'support',
  'other',
] as const;
const INDUSTRIES = [
  'saas',
  'fintech',
  'healthcare',
  'ecommerce',
  'manufacturing',
  'agency',
  'edtech',
  'biotech',
  'logistics',
  'real_estate',
] as const;
const SIZES = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5000+'] as const;
const LOCAL_CATEGORIES = [
  'restaurant',
  'dentist',
  'gym',
  'salon',
  'law_firm',
  'cafe',
  'auto_repair',
  'real_estate_agency',
] as const;

const strArr = z.array(z.string().min(1).max(100)).max(20);
// limit: default 25 when absent; clamp valid values to 1..100; fall back to 25 on garbage.
const Limit = z.coerce
  .number()
  .int()
  .transform((n) => Math.min(Math.max(Math.trunc(n), 1), 100))
  .catch(25)
  .default(25);

export const PeopleFiltersSchema = z
  .object({
    titleKeywords: strArr.optional(),
    seniorities: z.array(z.enum(SENIORITIES)).max(10).optional(),
    departments: z.array(z.enum(DEPARTMENTS)).max(12).optional(),
    companyIndustries: z.array(z.enum(INDUSTRIES)).max(12).optional(),
    companySize: z.enum(SIZES).optional(),
    locations: strArr.optional(),
    keywords: strArr.optional(),
    limit: Limit,
  })
  .strict();

export const CompanyFiltersSchema = z
  .object({
    nameKeywords: strArr.optional(),
    industries: z.array(z.enum(INDUSTRIES)).max(12).optional(),
    size: z.enum(SIZES).optional(),
    locations: strArr.optional(),
    keywords: strArr.optional(),
    limit: Limit,
  })
  .strict();

export const LocalFiltersSchema = z
  .object({
    category: z.array(z.enum(LOCAL_CATEGORIES)).max(8).optional(),
    nameKeywords: strArr.optional(),
    locations: strArr.optional(),
    limit: Limit,
  })
  .strict();

// Anthropic structured outputs reject numeric/length keywords (maxItems, maxLength).
// Keep the model schema to types + enums + structure; the Zod layer enforces caps.
const strArrJson = () => ({ type: 'array', items: { type: 'string' } });
const enumArrJson = (values: readonly string[]) => ({
  type: 'array',
  items: { type: 'string', enum: [...values] },
});

/** JSON Schema mirror handed to the model (structured outputs). Zod stays authoritative. */
function jsonSchemaFor(entityType: EntityType): Record<string, unknown> {
  if (entityType === 'person') {
    return {
      type: 'object',
      additionalProperties: false,
      properties: {
        titleKeywords: strArrJson(),
        seniorities: enumArrJson(SENIORITIES),
        departments: enumArrJson(DEPARTMENTS),
        companyIndustries: enumArrJson(INDUSTRIES),
        companySize: { type: 'string', enum: [...SIZES] },
        locations: strArrJson(),
        keywords: strArrJson(),
        limit: { type: 'integer' },
      },
    };
  }
  if (entityType === 'company') {
    return {
      type: 'object',
      additionalProperties: false,
      properties: {
        nameKeywords: strArrJson(),
        industries: enumArrJson(INDUSTRIES),
        size: { type: 'string', enum: [...SIZES] },
        locations: strArrJson(),
        keywords: strArrJson(),
        limit: { type: 'integer' },
      },
    };
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      category: enumArrJson(LOCAL_CATEGORIES),
      nameKeywords: strArrJson(),
      locations: strArrJson(),
      limit: { type: 'integer' },
    },
  };
}

const SYSTEM = [
  'You convert a natural-language B2B lead-search request into a JSON filter object.',
  'Rules: only use fields defined in the provided schema; use enum values EXACTLY as listed;',
  'omit any field you are not confident about; never invent values or fields. Return only JSON.',
].join(' ');

/** Run the model, parse, and validate against the entity schema. All failures → 422 (no query runs). */
async function runNl<T>(entityType: EntityType, query: string, schema: z.ZodType<T>): Promise<T> {
  const res = await complete('nl_to_filters', {
    system: SYSTEM,
    messages: [{ role: 'user', content: `Entity: ${entityType}\nRequest: ${query}` }],
    jsonSchema: jsonSchemaFor(entityType),
  });
  let raw: unknown;
  try {
    raw = JSON.parse(res.text);
  } catch {
    throw new AppError('Could not parse the search query into filters', {
      code: 'nl_parse_failed',
      statusCode: 422,
    });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('The query did not produce a valid filter', {
      code: 'nl_invalid_filters',
      statusCode: 422,
    });
  }
  return parsed.data;
}

export const nlToFiltersPerson = (query: string) => runNl('person', query, PeopleFiltersSchema);
export const nlToFiltersCompany = (query: string) => runNl('company', query, CompanyFiltersSchema);
export const nlToFiltersLocal = (query: string) =>
  runNl('local_business', query, LocalFiltersSchema);
