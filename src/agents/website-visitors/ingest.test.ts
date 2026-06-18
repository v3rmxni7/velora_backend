import { describe, expect, it } from 'vitest';
import {
  mapIdentificationToCompanyRow,
  mapIdentificationToPersonRow,
  sanitizeUrl,
  validateBeacon,
} from './ingest.js';

// Pure-function units for the website-visitor ingest core (4.6). The DB-touching processVisit / sweep
// are covered by the RUN_DB_IT integration suite; here we pin the pure pieces (the public-write guard
// + URL minimization + the identification→lead mapping/provenance).

describe('validateBeacon', () => {
  it('accepts a beacon with an anon visitor id and an event id', () => {
    expect(validateBeacon({ anonVisitorId: 'v1', eventId: 'e1' })).toEqual({
      ok: true,
      anonVisitorId: 'v1',
      eventId: 'e1',
    });
  });
  it('rejects a missing anon visitor id', () => {
    expect(validateBeacon({ eventId: 'e1' })).toEqual({
      ok: false,
      error: 'missing_anon_visitor_id',
    });
    expect(validateBeacon({ anonVisitorId: '  ', eventId: 'e1' })).toEqual({
      ok: false,
      error: 'missing_anon_visitor_id',
    });
  });
  it('rejects a missing event id (the dedup nonce)', () => {
    expect(validateBeacon({ anonVisitorId: 'v1' })).toEqual({
      ok: false,
      error: 'missing_event_id',
    });
  });
  it('rejects null/undefined', () => {
    expect(validateBeacon(null).ok).toBe(false);
    expect(validateBeacon(undefined).ok).toBe(false);
  });
});

describe('sanitizeUrl', () => {
  it('drops the query string and fragment (which can carry PII), keeping origin+path', () => {
    expect(sanitizeUrl('https://acme.com/pricing?email=a@b.com&token=secret#frag')).toBe(
      'https://acme.com/pricing',
    );
  });
  it('keeps a clean url unchanged', () => {
    expect(sanitizeUrl('https://acme.com/about')).toBe('https://acme.com/about');
  });
  it('strips query/fragment from a non-absolute string too', () => {
    expect(sanitizeUrl('/path/page?x=1#y')).toBe('/path/page');
  });
  it('returns null for empty/garbage input', () => {
    expect(sanitizeUrl(null)).toBeNull();
    expect(sanitizeUrl(undefined)).toBeNull();
    expect(sanitizeUrl('')).toBeNull();
  });
});

describe('mapIdentificationToPersonRow', () => {
  it('maps a resolved person to a person row with website_visitors provenance', () => {
    expect(
      mapIdentificationToPersonRow('org-1', {
        externalId: 'rb2b-9',
        email: 'casey@acme.com',
        fullName: 'Casey Visitor',
        firstName: 'Casey',
        lastName: 'Visitor',
        title: 'VP Sales',
        companyName: 'Acme',
      }),
    ).toEqual({
      organization_id: 'org-1',
      provider: 'website_visitor',
      external_id: 'rb2b-9',
      email: 'casey@acme.com',
      full_name: 'Casey Visitor',
      first_name: 'Casey',
      last_name: 'Visitor',
      title: 'VP Sales',
      company_name: 'Acme',
      source: 'website_visitors',
    });
  });
  it('nulls optional fields when absent', () => {
    expect(
      mapIdentificationToPersonRow('org-2', { externalId: 'p7', email: 'x@y.com' }),
    ).toMatchObject({
      provider: 'website_visitor',
      external_id: 'p7',
      email: 'x@y.com',
      full_name: null,
      title: null,
      source: 'website_visitors',
    });
  });
});

describe('mapIdentificationToCompanyRow', () => {
  it('maps a resolved company to a company row (no email — display-only)', () => {
    expect(
      mapIdentificationToCompanyRow('org-1', {
        externalId: 'co-3',
        name: 'Acme Inc',
        domain: 'acme.com',
        industry: 'SaaS',
      }),
    ).toEqual({
      organization_id: 'org-1',
      provider: 'website_visitor',
      external_id: 'co-3',
      name: 'Acme Inc',
      domain: 'acme.com',
      industry: 'SaaS',
      source: 'website_visitors',
    });
  });
});
