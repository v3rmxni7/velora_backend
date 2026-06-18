import type { Env } from '../../config/env.js';

// Phase 4 Slice 4.6 — the de-anonymization resolver seam (🔌 EXTERNAL, NOT connected). A visit →
// person/company resolution is the part you BUY (RB2B-style identity-graph for people; reverse-IP for
// companies). No real provider is implemented in this slice, so getResolver() returns null and the
// website-visitor-monitor sweep is a documented no-op — anonymous visits are recorded but never
// resolved, and the People/Companies tabs stay honestly empty. The pipeline is proven end-to-end by a
// TEST-ONLY FakeResolver. The resolver operates on the visit's STORED identifiers (anon_visitor_id,
// domain) + the vendor's own network — we never store or pass a raw IP (GDPR/CCPA minimization).

/** The stored, non-PII identifiers a resolver gets — never a raw IP. */
export interface ResolverVisit {
  organizationId: string;
  trackedDomainId: string;
  domain: string;
  anonVisitorId: string;
  pageUrl: string | null;
  referrer: string | null;
}

export interface ResolvedPerson {
  externalId: string;
  email: string;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  companyName?: string;
}
export interface ResolvedCompany {
  externalId: string;
  name: string;
  domain?: string;
  industry?: string;
}
export type ResolveResult =
  | { kind: 'person'; confidence?: number; person: ResolvedPerson }
  | { kind: 'company'; confidence?: number; company: ResolvedCompany }
  | { kind: 'none' };

export interface VisitorResolver {
  /** Vendor name — persisted on the identification + the credit_ledger reference for traceability. */
  readonly provider: string;
  resolve(visit: ResolverVisit): Promise<ResolveResult>;
}

/**
 * The honest-empty switch. Returns null unless a provider key is set — and even with a key, this slice
 * ships NO real provider (it returns null), so de-anon is entirely dormant. The real RB2B-style person
 * resolver + reverse-IP company resolver ship with the de-anon connection slice, where PERSON
 * resolution is DOUBLE-gated: a key AND a per-org `website_visitor_person_resolution_enabled` consent
 * flag (default false). Key-present alone must NEVER be sufficient to resolve a real human.
 */
export function getResolver(env: Env): VisitorResolver | null {
  if (!env.WEBSITE_VISITOR_RESOLVER_API_KEY) return null; // not connected → honest-empty
  // 🔌 deferred: a key is set, but no provider is implemented in 4.6. No-op so we never resolve with a
  // half-built provider (and the person-consent gate isn't wired yet).
  return null;
}

/**
 * TEST-ONLY fixture. Lets the integration suite prove the visit→lead→enrollment pipeline
 * deterministically. NEVER used in production: getResolver() above returns null there, so the monitor
 * is a real no-op. A green test suite does NOT mean de-anon "works" — it means the seam is correct.
 */
export class FakeResolver implements VisitorResolver {
  readonly provider: string;
  constructor(
    private readonly result: ResolveResult,
    provider = 'fake',
  ) {
    this.provider = provider;
  }
  async resolve(): Promise<ResolveResult> {
    return this.result;
  }
}
