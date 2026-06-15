import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors.js';
import { assertSupportedCampaignType, mapMembersToEnrollments } from './enroll.js';

describe('assertSupportedCampaignType', () => {
  it('allows cold_outbound', () => {
    expect(() => assertSupportedCampaignType('cold_outbound')).not.toThrow();
  });
  it('rejects the not-yet-supported types (422)', () => {
    for (const t of ['warm_outbound', 'cross_sell', 'website_visitor', 'intent_signals', 'bogus']) {
      expect(() => assertSupportedCampaignType(t)).toThrow(AppError);
    }
  });
});

describe('mapMembersToEnrollments', () => {
  it('maps each list member to a pending step-1 enrollment row', () => {
    const rows = mapMembersToEnrollments(
      [
        { entity_type: 'person', entity_id: 'lead-1' },
        { entity_type: 'person', entity_id: 'lead-2' },
      ],
      { id: 'camp-1', organization_id: 'org-1', list_id: 'list-1' },
    );
    expect(rows).toEqual([
      {
        organization_id: 'org-1',
        campaign_id: 'camp-1',
        lead_type: 'person',
        lead_id: 'lead-1',
        status: 'pending',
        current_step: 1,
      },
      {
        organization_id: 'org-1',
        campaign_id: 'camp-1',
        lead_type: 'person',
        lead_id: 'lead-2',
        status: 'pending',
        current_step: 1,
      },
    ]);
  });
  it('returns [] for an empty list', () => {
    expect(mapMembersToEnrollments([], { id: 'c', organization_id: 'o' })).toEqual([]);
  });
});
