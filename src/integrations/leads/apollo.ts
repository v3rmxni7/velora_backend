import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import type {
  CompanyFilters,
  CompanyMatch,
  Department,
  Industry,
  LeadProvider,
  LocalFilters,
  LocalMatch,
  PeopleFilters,
  PersonMatch,
  Seniority,
  SizeBand,
} from './types.js';

// Apollo.io lead-data adapter (the README's primary provider). Drop-in for the LeadProvider seam.
//
// ⚠️ LIVE-VERIFICATION NOTE: this maps Velora's filters/results to Apollo's documented v1 REST API
// (mixed_people/search, mixed_companies/search), but the exact request params and response field
// names can only be end-to-end verified with a live APOLLO_API_KEY (the one piece that can't be tested
// without spending). It is built to FAIL SAFE, never to fabricate:
//   • Responses are zod-parsed leniently; an unexpected shape throws a 502 'apollo_bad_response' (the
//     route surfaces an honest error) — it NEVER invents leads.
//   • Locked / placeholder emails (Apollo returns these until a paid "reveal") are dropped, so a
//     PersonMatch only ever carries a real address.
//   • A non-2xx provider response throws 'apollo_error' with the status — no silent empty list.
// Spend is contained UPSTREAM by the find-leads route's guardrail (daily quota + credit enforce);
// this adapter performs exactly one search call per invocation.

const APOLLO_BASE = 'https://api.apollo.io/v1';

// --- best-effort enum maps (Apollo's vocabulary → Velora's). Unknown → a safe non-fabricating
// fallback. seniority/department are REQUIRED on a match, so they always resolve to a valid value. ---
const SENIORITY_MAP: Record<string, Seniority> = {
  owner: 'c_level',
  founder: 'c_level',
  c_suite: 'c_level',
  c_level: 'c_level',
  partner: 'vp',
  vp: 'vp',
  head: 'director',
  director: 'director',
  manager: 'manager',
  senior: 'senior',
  entry: 'entry',
  intern: 'entry',
};
const DEPARTMENT_MAP: Record<string, Department> = {
  engineering: 'engineering',
  information_technology: 'engineering',
  sales: 'sales',
  business_development: 'sales',
  marketing: 'marketing',
  product: 'product',
  product_management: 'product',
  finance: 'finance',
  accounting: 'finance',
  operations: 'operations',
  human_resources: 'hr',
  legal: 'legal',
  support: 'support',
  customer_service: 'support',
};
const INDUSTRY_MAP: Record<string, Industry> = {
  'information technology & services': 'saas',
  'computer software': 'saas',
  saas: 'saas',
  'financial services': 'fintech',
  fintech: 'fintech',
  banking: 'fintech',
  'hospital & health care': 'healthcare',
  healthcare: 'healthcare',
  'consumer goods': 'ecommerce',
  retail: 'ecommerce',
  ecommerce: 'ecommerce',
  manufacturing: 'manufacturing',
  'marketing & advertising': 'agency',
  agency: 'agency',
  education: 'edtech',
  edtech: 'edtech',
  biotechnology: 'biotech',
  biotech: 'biotech',
  logistics: 'logistics',
  'logistics & supply chain': 'logistics',
  'real estate': 'real_estate',
  real_estate: 'real_estate',
};

const mapSeniority = (s?: string | null): Seniority =>
  SENIORITY_MAP[(s ?? '').toLowerCase()] ?? 'mid';
const mapDepartment = (d?: string | null): Department =>
  DEPARTMENT_MAP[(d ?? '').toLowerCase()] ?? 'other';
const mapIndustry = (i?: string | null): Industry | undefined =>
  INDUSTRY_MAP[(i ?? '').toLowerCase()];

/** Apollo employee-count band string for a search filter, e.g. "51-200" → "51,200". */
function sizeToRange(size?: SizeBand): string | undefined {
  if (!size) return undefined;
  if (size === '5000+') return '5001,1000000';
  return size.replace('-', ',');
}
/** Estimated employee count → Velora SizeBand (display only; never required). */
function countToBand(n?: number | null): SizeBand | undefined {
  if (!n || n <= 0) return undefined;
  if (n <= 10) return '1-10';
  if (n <= 50) return '11-50';
  if (n <= 200) return '51-200';
  if (n <= 500) return '201-500';
  if (n <= 1000) return '501-1000';
  if (n <= 5000) return '1001-5000';
  return '5000+';
}

// A real email vs Apollo's locked/placeholder ("email_not_unlocked@...", null, "not_unlocked").
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function realEmail(e?: string | null): string | undefined {
  if (!e || !EMAIL_RE.test(e)) return undefined;
  if (/not_unlocked|domain\.com$/i.test(e)) return undefined;
  return e.toLowerCase();
}

const clampLimit = (n: number) => Math.max(1, Math.min(100, Math.floor(n)));

// Lenient response schemas — validate the structure we read; tolerate extra/missing optional fields.
const ApolloOrg = z
  .object({
    id: z.string().optional(),
    name: z.string().optional().nullable(),
    industry: z.string().optional().nullable(),
    estimated_num_employees: z.number().optional().nullable(),
    primary_domain: z.string().optional().nullable(),
    website_url: z.string().optional().nullable(),
    linkedin_url: z.string().optional().nullable(),
  })
  .passthrough();
const ApolloPerson = z
  .object({
    id: z.string(),
    first_name: z.string().optional().nullable(),
    last_name: z.string().optional().nullable(),
    name: z.string().optional().nullable(),
    title: z.string().optional().nullable(),
    email: z.string().optional().nullable(),
    seniority: z.string().optional().nullable(),
    departments: z.array(z.string()).optional().nullable(),
    city: z.string().optional().nullable(),
    state: z.string().optional().nullable(),
    country: z.string().optional().nullable(),
    linkedin_url: z.string().optional().nullable(),
    organization: ApolloOrg.optional().nullable(),
    organization_id: z.string().optional().nullable(),
  })
  .passthrough();
const PeopleResponse = z.object({ people: z.array(ApolloPerson).default([]) }).passthrough();
const CompaniesResponse = z
  .object({
    organizations: z.array(ApolloOrg).default([]),
    accounts: z.array(ApolloOrg).optional(),
  })
  .passthrough();

export function createApolloProvider(apiKey: string): LeadProvider {
  async function call(path: string, body: Record<string, unknown>): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${APOLLO_BASE}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Api-Key': apiKey,
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new AppError('Lead provider (Apollo) is unreachable', {
        code: 'apollo_unreachable',
        statusCode: 502,
      });
    }
    if (!res.ok) {
      throw new AppError(`Lead provider (Apollo) returned ${res.status}`, {
        code: 'apollo_error',
        statusCode: res.status === 429 ? 429 : 502,
      });
    }
    return res.json();
  }

  function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
    const out = schema.safeParse(raw);
    if (!out.success) {
      // Never fabricate: an unrecognized shape is an honest error, not an empty/guessed result.
      throw new AppError('Lead provider (Apollo) sent an unexpected response shape', {
        code: 'apollo_bad_response',
        statusCode: 502,
      });
    }
    return out.data;
  }

  return {
    name: 'apollo',
    metered: true,

    async searchPeople(f: PeopleFilters): Promise<PersonMatch[]> {
      const body = {
        page: 1,
        per_page: clampLimit(f.limit),
        ...(f.titleKeywords?.length ? { person_titles: f.titleKeywords } : {}),
        ...(f.seniorities?.length ? { person_seniorities: f.seniorities } : {}),
        ...(f.departments?.length ? { person_departments: f.departments } : {}),
        ...(f.locations?.length ? { person_locations: f.locations } : {}),
        ...(f.companySize
          ? { organization_num_employees_ranges: [sizeToRange(f.companySize)] }
          : {}),
        ...(f.keywords?.length ? { q_keywords: f.keywords.join(' ') } : {}),
      };
      const data = parse(PeopleResponse, await call('/mixed_people/search', body));
      return data.people.map((p): PersonMatch => {
        const org = p.organization ?? undefined;
        const full = p.name ?? `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim();
        return {
          externalId: `apollo:${p.id}`,
          firstName: p.first_name ?? '',
          lastName: p.last_name ?? '',
          fullName: full,
          email: realEmail(p.email),
          title: p.title ?? '',
          seniority: mapSeniority(p.seniority),
          department: mapDepartment(p.departments?.[0]),
          companyExternalId: org?.id
            ? `apollo:${org.id}`
            : p.organization_id
              ? `apollo:${p.organization_id}`
              : undefined,
          companyName: org?.name ?? undefined,
          companyIndustry: mapIndustry(org?.industry),
          companySize: countToBand(org?.estimated_num_employees),
          location: [p.city, p.state].filter(Boolean).join(', ') || undefined,
          country: p.country ?? undefined,
          linkedinUrl: p.linkedin_url ?? undefined,
        };
      });
    },

    async searchCompanies(f: CompanyFilters): Promise<CompanyMatch[]> {
      const body = {
        page: 1,
        per_page: clampLimit(f.limit),
        ...(f.nameKeywords?.length ? { q_organization_name: f.nameKeywords.join(' ') } : {}),
        ...(f.locations?.length ? { organization_locations: f.locations } : {}),
        ...(f.size ? { organization_num_employees_ranges: [sizeToRange(f.size)] } : {}),
        ...(f.keywords?.length ? { q_organization_keyword_tags: f.keywords } : {}),
      };
      const data = parse(CompaniesResponse, await call('/mixed_companies/search', body));
      const orgs = data.organizations.length ? data.organizations : (data.accounts ?? []);
      return orgs.map(
        (o): CompanyMatch => ({
          externalId: `apollo:${o.id ?? o.name ?? ''}`,
          name: o.name ?? '',
          domain: o.primary_domain ?? o.website_url ?? undefined,
          industry: mapIndustry(o.industry) ?? 'saas',
          sizeBand: countToBand(o.estimated_num_employees) ?? '11-50',
          employeeCount: o.estimated_num_employees ?? undefined,
          linkedinUrl: o.linkedin_url ?? undefined,
        }),
      );
    },

    // Apollo is not a local-business directory — honest empty rather than a fabricated result.
    async searchLocal(_f: LocalFilters): Promise<LocalMatch[]> {
      return [];
    },
  };
}
