// 4.10 — plan tiers (SPEC §10) + the low-balance warn threshold.
//
// Plan tiers are REAL stored data (organizations.plan) shown in /billing; nothing here charges a card
// or implies a payment occurred. `includedCredits` is the monthly credit allowance a tier represents
// (1 credit ≈ 1 processed lead / send at the current placeholder SEND_COST=1) — a DISPLAY figure: the
// recurring per-cycle grant needs a billing cycle + a payment provider and is deferred to go-live.

export type PlanTier = 'starter' | 'growth' | 'scale';

export interface PlanInfo {
  tier: PlanTier;
  name: string;
  priceUsdMonthly: number;
  includedCredits: number;
  leadsPerMonth: number;
  blurb: string;
}

const STARTER: PlanInfo = {
  tier: 'starter',
  name: 'Starter',
  priceUsdMonthly: 249,
  includedCredits: 2_000,
  leadsPerMonth: 2_000,
  blurb: 'Solo or small team. ~2K leads/mo. The wedge.',
};

export const PLAN_TIERS: PlanInfo[] = [
  STARTER,
  {
    tier: 'growth',
    name: 'Growth',
    priceUsdMonthly: 699,
    includedCredits: 10_000,
    leadsPerMonth: 10_000,
    blurb: 'Active team. ~10K leads/mo.',
  },
  {
    tier: 'scale',
    name: 'Scale',
    priceUsdMonthly: 1_999,
    includedCredits: 50_000,
    leadsPerMonth: 50_000,
    blurb: 'Heavy / multi-ICP. ~50K leads/mo, metered.',
  },
];

export function planInfo(tier: PlanTier): PlanInfo {
  return PLAN_TIERS.find((p) => p.tier === tier) ?? STARTER;
}

// Warn-only. The HARD cold-send gate already lives in executeSend (pipeline.ts: assessCredits →
// 'insufficient_credit', live-branch only). This threshold drives the footer + /billing warning so a
// customer sees a low balance before real sends start failing. It never blocks anything.
export const LOW_BALANCE_THRESHOLD = 100;

export function isLowBalance(balance: number): boolean {
  return balance < LOW_BALANCE_THRESHOLD;
}
