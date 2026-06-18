import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors.js';
import { assertSupportedCampaignType, mapMembersToEnrollments } from './enroll.js';

describe('assertSupportedCampaignType', () => {
  it('allows all 5 product types (4.3 — audience resolution is the real gate, not the type)', () => {
    for (const t of [
      'cold_outbound',
      'warm_outbound',
      'cross_sell',
      'website_visitor',
      'intent_signals',
    ]) {
      expect(() => assertSupportedCampaignType(t)).not.toThrow();
    }
  });
  it('still rejects a bogus type (422)', () => {
    expect(() => assertSupportedCampaignType('bogus')).toThrow(AppError);
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

  it('4.4 — stamps a deterministic variant_id when the campaign has variants (re-launch-safe)', () => {
    const variants = [{ id: 'v-a' }, { id: 'v-b' }];
    const members = [
      { entity_type: 'person', entity_id: 'lead-1' },
      { entity_type: 'person', entity_id: 'lead-2' },
      { entity_type: 'person', entity_id: 'lead-3' },
    ];
    const campaign = { id: 'camp-1', organization_id: 'org-1' };
    const r1 = mapMembersToEnrollments(members, campaign, variants);
    const r2 = mapMembersToEnrollments(members, campaign, variants);
    for (const row of r1) expect(['v-a', 'v-b']).toContain(row.variant_id);
    // Deterministic: a re-run (re-launch) assigns the identical cohorts — never reshuffles.
    expect(r1.map((x) => x.variant_id)).toEqual(r2.map((x) => x.variant_id));
  });

  it('4.4 — omits variant_id entirely when there are no variants (byte-identical cold path)', () => {
    const rows = mapMembersToEnrollments([{ entity_type: 'person', entity_id: 'l' }], {
      id: 'c',
      organization_id: 'o',
    });
    expect(rows[0]).not.toHaveProperty('variant_id');
  });
});
