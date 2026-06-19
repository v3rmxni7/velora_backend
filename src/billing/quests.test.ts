import { describe, expect, it } from 'vitest';
import { isLowBalance, LOW_BALANCE_THRESHOLD, PLAN_TIERS } from './plans.js';
import { evaluateQuests, QUEST_CATALOG, QUEST_TOTAL, type QuestState } from './quests.js';

const ZERO: QuestState = {
  primaryMailboxes: 0,
  totalMailboxes: 0,
  sendersWithSignature: 0,
  domains: 0,
  signalCampaigns: 0,
  autopilot: false,
  coachingPoints: 0,
  proofItems: 0,
  kbDocuments: 0,
  icpProfiles: 0,
  people: 0,
  lists: 0,
  campaignSteps: 0,
  connectedIntegrations: 0,
  activeSignalSubs: 0,
  trackedDomains: 0,
};

const FULL: QuestState = {
  primaryMailboxes: 1,
  totalMailboxes: 2,
  sendersWithSignature: 1,
  domains: 1,
  signalCampaigns: 1,
  autopilot: true,
  coachingPoints: 1,
  proofItems: 1,
  kbDocuments: 1,
  icpProfiles: 1,
  people: 1,
  lists: 1,
  campaignSteps: 1,
  connectedIntegrations: 1,
  activeSignalSubs: 1,
  trackedDomains: 1,
};

describe('QUEST_CATALOG', () => {
  it('has exactly 14 quests with unique keys', () => {
    expect(QUEST_TOTAL).toBe(14);
    expect(QUEST_CATALOG).toHaveLength(14);
    expect(new Set(QUEST_CATALOG.map((q) => q.key)).size).toBe(14);
  });

  it('every quest has a positive reward and a real href', () => {
    for (const q of QUEST_CATALOG) {
      expect(q.reward).toBeGreaterThan(0);
      expect(q.href.startsWith('/')).toBe(true);
    }
  });
});

describe('evaluateQuests', () => {
  it('a fresh org completes nothing', () => {
    const done = evaluateQuests(ZERO);
    expect(Object.values(done).every((v) => v === false)).toBe(true);
    // Every catalog quest is represented in the result.
    for (const q of QUEST_CATALOG) expect(q.key in done).toBe(true);
  });

  it('a fully set-up org completes all 14', () => {
    const done = evaluateQuests(FULL);
    expect(Object.values(done).every((v) => v === true)).toBe(true);
  });

  it('secondary-mailboxes needs ≥2 mailboxes (1 is not enough)', () => {
    expect(evaluateQuests({ ...ZERO, totalMailboxes: 1 })['secondary-mailboxes']).toBe(false);
    expect(evaluateQuests({ ...ZERO, totalMailboxes: 2 })['secondary-mailboxes']).toBe(true);
  });

  it('connect-a-source completes via ANY of CRM / signals / pixel', () => {
    expect(evaluateQuests({ ...ZERO, connectedIntegrations: 1 })['connect-a-source']).toBe(true);
    expect(evaluateQuests({ ...ZERO, activeSignalSubs: 1 })['connect-a-source']).toBe(true);
    expect(evaluateQuests({ ...ZERO, trackedDomains: 1 })['connect-a-source']).toBe(true);
    expect(evaluateQuests(ZERO)['connect-a-source']).toBe(false);
  });

  it('signature requires a real signature signal (derived, not claimable)', () => {
    expect(evaluateQuests({ ...ZERO, sendersWithSignature: 1 })['email-signature']).toBe(true);
    expect(evaluateQuests(ZERO)['email-signature']).toBe(false);
  });
});

describe('plan tiers + low-balance', () => {
  it('exposes the three SPEC §10 tiers with prices', () => {
    expect(PLAN_TIERS.map((p) => p.tier)).toEqual(['starter', 'growth', 'scale']);
    expect(PLAN_TIERS.map((p) => p.priceUsdMonthly)).toEqual([249, 699, 1999]);
  });

  it('lowBalance is a strict-below-threshold warn signal', () => {
    expect(isLowBalance(LOW_BALANCE_THRESHOLD - 1)).toBe(true);
    expect(isLowBalance(LOW_BALANCE_THRESHOLD)).toBe(false);
    expect(isLowBalance(LOW_BALANCE_THRESHOLD + 1)).toBe(false);
  });
});
