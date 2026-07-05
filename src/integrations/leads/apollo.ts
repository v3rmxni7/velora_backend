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
  PersonEnrichRef,
  PersonEnrichment,
  PersonMatch,
  Seniority,
  SizeBand,
} from './types.js';

// Apollo.io lead-data adapter (the README's primary provider). Drop-in for the LeadProvider seam.
//
// REQUEST SHAPE (verified live 2026-06-30 against a real key): Apollo's search endpoints take their
// filters as URL QUERY-STRING params (arrays as `key[]=v`), NOT a JSON body — sending them in the body
// returns a 422. Base is `/api/v1`; auth is the `X-Api-Key` header ONLY — adding `Authorization:
// Bearer` makes Apollo validate the key as an OAuth access token and 401 (INVALID_ACCESS_TOKEN) even
// with X-Api-Key present. people → `mixed_people/api_search` (the net-new prospecting endpoint;
// `mixed_people/search` is DEPRECATED for API callers per Apollo's 422, and api_search does NOT return
// emails — a lead carries no address until a later enrichment step), companies → `mixed_companies/search`.
// It is built to FAIL SAFE, never to fabricate:
//   • Responses are zod-parsed leniently; an unexpected shape throws a 502 'apollo_bad_response' (the
//     route surfaces an honest error) — it NEVER invents leads.
//   • Locked / placeholder emails (Apollo returns these until a paid "reveal") are dropped, so a
//     PersonMatch only ever carries a real address.
//   • A non-2xx provider response throws 'apollo_error' WITH Apollo's own error body — no silent empty
//     list, and a real failure is self-diagnosing rather than opaque.
// Spend is contained UPSTREAM by the find-leads route's guardrail (daily quota + credit enforce);
// this adapter performs exactly one search call per invocation.

const APOLLO_BASE = 'https://api.apollo.io/api/v1';
// Bound a hung-but-not-down Apollo. undici fetch has NO default total timeout, so an accepted-then-
// silent socket would hang the SYNCHRONOUS /find-leads request forever. The abort rejects fetch →
// caught → honest 502 apollo_unreachable (audit: resilience/med).
const APOLLO_TIMEOUT_MS = 20_000;

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

// FORWARD map (Velora vocabulary → Apollo's person_seniorities enum). Apollo AND-matches every
// filter against its OWN controlled vocabulary (owner/founder/c_suite/partner/vp/head/director/
// manager/senior/entry/intern); passing Velora values like 'c_level' or 'mid' raw matches ZERO
// people — which is why a "founders / c-level" search returned nothing. Expand each Velora tier to
// the Apollo values it covers (person_seniorities is an array, so one tier → several Apollo values).
const SENIORITY_TO_APOLLO: Record<string, string[]> = {
  c_level: ['c_suite', 'founder', 'owner', 'partner'],
  vp: ['vp'],
  director: ['director', 'head'],
  manager: ['manager'],
  senior: ['senior'],
  mid: ['senior'], // Apollo has no mid tier; senior is the closest IC band
  entry: ['entry', 'intern'],
};
const toApolloSeniorities = (xs: readonly string[]): string[] => [
  ...new Set(xs.flatMap((s) => SENIORITY_TO_APOLLO[s.toLowerCase()] ?? [])),
];

// FORWARD map (Velora department vocabulary → Apollo person_departments). Best-effort values, to be
// live-verified: an unrecognized Apollo department matches ZERO people (same class as the seniority
// bug), so a wrong value here silently drops results — never a 422. 'other' → no filter. Verified
// live via find-leads searches; any value that returns nothing gets corrected.
const DEPARTMENT_TO_APOLLO: Record<string, string[]> = {
  engineering: ['engineering'],
  sales: ['sales', 'business_development'],
  marketing: ['marketing'],
  product: ['product_management'],
  finance: ['finance'],
  operations: ['operations'],
  hr: ['human_resources'],
  legal: ['legal'],
  support: ['support'],
  other: [],
};
const toApolloDepartments = (xs: readonly string[]): string[] => [
  ...new Set(xs.flatMap((d) => DEPARTMENT_TO_APOLLO[d.toLowerCase()] ?? [])),
];

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
// people/match wraps a single person (or null when Apollo finds no match).
const MatchResponse = z.object({ person: ApolloPerson.optional().nullable() }).passthrough();
const CompaniesResponse = z
  .object({
    organizations: z.array(ApolloOrg).default([]),
    accounts: z.array(ApolloOrg).optional(),
  })
  .passthrough();

// Apollo search params: filters live in the QUERY STRING; arrays repeat as `key[]=v`.
type ApolloParams = Record<string, string | string[] | undefined>;
function buildSearchUrl(path: string, params: ApolloParams): URL {
  const u = new URL(`${APOLLO_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    if (Array.isArray(v)) for (const item of v) u.searchParams.append(`${k}[]`, item);
    else u.searchParams.set(k, v);
  }
  return u;
}

export function createApolloProvider(apiKey: string): LeadProvider {
  async function call(path: string, params: ApolloParams): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(buildSearchUrl(path, params), {
        method: 'POST',
        headers: {
          accept: 'application/json',
          // Apollo API-key auth is the X-Api-Key header ONLY. Do NOT also send Authorization: Bearer —
          // Apollo then tries to validate the key as an OAuth ACCESS TOKEN and rejects the request with
          // 401 INVALID_ACCESS_TOKEN even though X-Api-Key is present (verified live 2026-06-30).
          'X-Api-Key': apiKey,
        },
        signal: AbortSignal.timeout(APOLLO_TIMEOUT_MS),
      });
    } catch {
      throw new AppError('Lead provider (Apollo) is unreachable', {
        code: 'apollo_unreachable',
        statusCode: 502,
      });
    }
    if (!res.ok) {
      // Surface Apollo's own error body (truncated) — honest + self-diagnosing, never a guessed result.
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        /* ignore body read failure */
      }
      throw new AppError(
        `Lead provider (Apollo) returned ${res.status}${detail ? `: ${detail}` : ''}`,
        {
          code: 'apollo_error',
          statusCode: res.status === 429 ? 429 : 502,
        },
      );
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
      const sizeRange = f.companySize ? sizeToRange(f.companySize) : undefined;
      const params: ApolloParams = {
        page: '1',
        per_page: String(clampLimit(f.limit)),
        ...(f.titleKeywords?.length ? { person_titles: f.titleKeywords } : {}),
        ...(f.seniorities?.length ? { person_seniorities: toApolloSeniorities(f.seniorities) } : {}),
        ...(f.departments?.length ? { person_departments: toApolloDepartments(f.departments) } : {}),
        ...(f.locations?.length ? { person_locations: f.locations } : {}),
        ...(sizeRange ? { organization_num_employees_ranges: [sizeRange] } : {}),
        ...(f.keywords?.length ? { q_keywords: f.keywords.join(' ') } : {}),
      };
      const data = parse(PeopleResponse, await call('/mixed_people/api_search', params));
      // INDUSTRY-TAG HARVEST (temporary, verify-B): api_search filters industry by opaque hex tag id,
      // not name — so log the (name → tag id) pairs Apollo returns to build a VERIFIED map with zero
      // guessing. Removed once the industry map is wired. No PII (industry + tag id only).
      const seenIndustries = new Map<string, string>();
      for (const pp of data.people) {
        const o = pp.organization as Record<string, unknown> | null | undefined;
        const name = typeof o?.industry === 'string' ? o.industry : undefined;
        const tagId =
          (typeof o?.industry_tag_id === 'string' && o.industry_tag_id) ||
          (Array.isArray(o?.organization_industry_tag_ids) && o?.organization_industry_tag_ids[0]) ||
          undefined;
        if (name && tagId) seenIndustries.set(name, String(tagId));
      }
      if (seenIndustries.size > 0) {
        console.log(
          '[apollo-industry-probe]',
          JSON.stringify([...seenIndustries.entries()].slice(0, 25)),
        );
      }
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
      const sizeRange = f.size ? sizeToRange(f.size) : undefined;
      const params: ApolloParams = {
        page: '1',
        per_page: String(clampLimit(f.limit)),
        ...(f.nameKeywords?.length ? { q_organization_name: f.nameKeywords.join(' ') } : {}),
        ...(f.locations?.length ? { organization_locations: f.locations } : {}),
        ...(sizeRange ? { organization_num_employees_ranges: [sizeRange] } : {}),
        ...(f.keywords?.length ? { q_organization_keyword_tags: f.keywords } : {}),
      };
      const data = parse(CompaniesResponse, await call('/mixed_companies/search', params));
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

    // Enrichment: `people/match` — the endpoint that DOES return emails (api_search never does).
    // Apollo charges ONE export credit per successful email reveal on their meter; a no-match should
    // cost nothing (to be confirmed against the Apollo dashboard in the live small-test). Same
    // conventions as search: query-string params, X-Api-Key only, timeout, error-body surfacing.
    // reveal_personal_emails stays false — work emails only (deliverability + compliance).
    // FAIL-SAFE: no match / locked / placeholder email → null. Never fabricates an address.
    async enrichPerson(ref: PersonEnrichRef): Promise<PersonEnrichment | null> {
      const apolloId = ref.externalId?.startsWith('apollo:')
        ? ref.externalId.slice('apollo:'.length)
        : undefined;
      // Nothing to match on → honest null without a paid call.
      if (!apolloId && !ref.linkedinUrl && !(ref.fullName && ref.companyName)) return null;
      const params: ApolloParams = {
        reveal_personal_emails: 'false',
        ...(apolloId ? { id: apolloId } : {}),
        ...(ref.fullName ? { name: ref.fullName } : {}),
        ...(ref.companyName ? { organization_name: ref.companyName } : {}),
        ...(ref.linkedinUrl ? { linkedin_url: ref.linkedinUrl } : {}),
      };
      const data = parse(MatchResponse, await call('/people/match', params));
      const p = data.person;
      if (!p) return null;
      const email = realEmail(p.email);
      if (!email) return null;
      return {
        email,
        title: p.title ?? undefined,
        linkedinUrl: p.linkedin_url ?? undefined,
      };
    },
  };
}
