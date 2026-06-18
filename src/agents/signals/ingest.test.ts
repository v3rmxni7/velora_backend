import { describe, expect, it } from 'vitest';
import { mapEventToPersonRow, validateEventPayload } from './ingest.js';

// Pure-function units for the signal ingest core (4.5). The DB-touching processSignalEvent / sweep
// are covered by the RUN_DB_IT integration suite; here we pin the two pure pieces.

describe('validateEventPayload', () => {
  it('accepts a payload with an externalId and an email', () => {
    expect(validateEventPayload({ externalId: 'x1', email: 'a@b.com' })).toEqual({ ok: true });
  });
  it('rejects a missing externalId (a contact must be stably identifiable)', () => {
    expect(validateEventPayload({ email: 'a@b.com' })).toEqual({
      ok: false,
      error: 'missing_external_id',
    });
    expect(validateEventPayload({ externalId: '   ', email: 'a@b.com' })).toEqual({
      ok: false,
      error: 'missing_external_id',
    });
  });
  it('rejects a missing email (a company lead would dead-end at no_email — must be a reachable person)', () => {
    expect(validateEventPayload({ externalId: 'x1' })).toEqual({
      ok: false,
      error: 'missing_email',
    });
  });
  it('rejects null/undefined', () => {
    expect(validateEventPayload(null).ok).toBe(false);
    expect(validateEventPayload(undefined).ok).toBe(false);
  });
});

describe('mapEventToPersonRow', () => {
  it('maps an event to a person row with traceable signals provenance', () => {
    const row = mapEventToPersonRow(
      'org-1',
      { key: 'funding_announcement', category: 'funding' },
      {
        externalId: 'contact-9',
        email: 'cfo@acme.com',
        full_name: 'Casey Funder',
        first_name: 'Casey',
        last_name: 'Funder',
        title: 'CFO',
        company_name: 'Acme',
      },
    );
    expect(row).toEqual({
      organization_id: 'org-1',
      provider: 'signal:funding',
      external_id: 'funding_announcement:contact-9',
      email: 'cfo@acme.com',
      full_name: 'Casey Funder',
      first_name: 'Casey',
      last_name: 'Funder',
      title: 'CFO',
      company_name: 'Acme',
      source: 'signals',
    });
  });
  it('nulls the optional fields when absent (provider/external_id/source/email always present)', () => {
    const row = mapEventToPersonRow(
      'org-2',
      { key: 'new_leadership_hire', category: 'hiring' },
      { externalId: 'p7', email: 'vp@x.com' },
    );
    expect(row).toMatchObject({
      organization_id: 'org-2',
      provider: 'signal:hiring',
      external_id: 'new_leadership_hire:p7',
      email: 'vp@x.com',
      full_name: null,
      first_name: null,
      last_name: null,
      title: null,
      company_name: null,
      source: 'signals',
    });
  });
});
