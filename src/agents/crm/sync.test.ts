import { describe, expect, it } from 'vitest';
import { mapContactToPersonRow } from './sync.js';

// Pure-function unit for the CRM sync core (4.7). The DB-touching runCrmSync / processCrmContact are
// covered by the RUN_DB_IT integration suite (with a TEST-ONLY FakeCrmClient).

describe('mapContactToPersonRow', () => {
  it('maps a CRM contact to a person row with namespaced provider + crm provenance', () => {
    expect(
      mapContactToPersonRow('org-1', 'hubspot', {
        externalId: '12345',
        email: 'casey@acme.com',
        fullName: 'Casey Contact',
        firstName: 'Casey',
        lastName: 'Contact',
        title: 'VP Sales',
        companyName: 'Acme',
      }),
    ).toEqual({
      organization_id: 'org-1',
      provider: 'crm:hubspot', // namespaced so HubSpot id N ≠ Salesforce id N under (org,provider,external_id)
      external_id: '12345',
      email: 'casey@acme.com',
      full_name: 'Casey Contact',
      first_name: 'Casey',
      last_name: 'Contact',
      title: 'VP Sales',
      company_name: 'Acme',
      source: 'crm',
    });
  });

  it('namespaces salesforce distinctly + nulls optional fields', () => {
    expect(
      mapContactToPersonRow('org-2', 'salesforce', { externalId: '003xx', email: 'x@y.com' }),
    ).toMatchObject({
      provider: 'crm:salesforce',
      external_id: '003xx',
      email: 'x@y.com',
      full_name: null,
      title: null,
      source: 'crm',
    });
  });
});
