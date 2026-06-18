// Analytics aggregation (Phase 4 Slice 4.2a) — PURE builders + range helpers, unit-testable with no
// DB. The route fetches the window's rows under RLS (org-scoped) and hands them here. HONEST BY
// CONSTRUCTION: these return only COUNTS that genuinely exist, plus a `realSends` measurability
// switch. They NEVER compute a rate or synthesize a series — the UI derives rates only when
// realSends > 0, and renders honest-empty otherwise.

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 366;

/** Outbound message statuses (the messages.status CHECK), in lifecycle order. */
export const OUTBOUND_STATUSES = [
  'dry_run',
  'queued',
  'sent',
  'delivered',
  'opened',
  'clicked',
  'replied',
  'bounced',
  'complained',
  'failed',
] as const;

/** credit_ledger reasons (the reason CHECK). */
export const LEDGER_REASONS = [
  'signup_grant',
  'enrichment',
  'send',
  'reply',
  'adjustment',
] as const;

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export interface DateRange {
  fromIso: string;
  toIso: string;
}

function isValidIso(s: string | undefined): s is string {
  return !!s && Number.isFinite(Date.parse(s));
}

/**
 * Resolve the [from,to] window from optional ISO inputs. Defaults to the last 30 days; an
 * inverted range is normalized (min/max) and the length is clamped to a year (a guard against an
 * unbounded fetch). nowMs is injected so the resolver is deterministic in tests.
 */
export function resolveRange(
  from: string | undefined,
  to: string | undefined,
  nowMs: number,
): DateRange {
  const toMs = isValidIso(to) ? Date.parse(to) : nowMs;
  const fromMs = isValidIso(from) ? Date.parse(from) : toMs - DEFAULT_WINDOW_DAYS * DAY_MS;
  const hi = Math.max(fromMs, toMs);
  const lo = Math.max(Math.min(fromMs, toMs), hi - MAX_WINDOW_DAYS * DAY_MS);
  return { fromIso: new Date(lo).toISOString(), toIso: new Date(hi).toISOString() };
}

/** UTC 'YYYY-MM-DD' day key for any ISO timestamp (tolerates +00:00 or Z). */
export function dayKey(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/** Inclusive list of UTC day keys spanning [fromIso, toIso] — so a series has continuous days. */
export function eachUtcDay(range: DateRange): string[] {
  const start = Date.parse(`${dayKey(range.fromIso)}T00:00:00.000Z`);
  const end = Date.parse(`${dayKey(range.toIso)}T00:00:00.000Z`);
  const days: string[] = [];
  for (let t = start; t <= end; t += DAY_MS) days.push(new Date(t).toISOString().slice(0, 10));
  return days;
}

// ---- raw row shapes (what the route fetches) ----
export interface MsgRow {
  created_at: string;
  direction: string;
  status: string;
  category: string | null;
  enrollment_id?: string | null;
}
export interface EnrRow {
  created_at: string;
}
export interface LedgerRow {
  created_at: string;
  delta: number;
  reason: string;
}

interface RangeOut {
  from: string;
  to: string;
  days: number;
}
const rangeOut = (range: DateRange, days: string[]): RangeOut => ({
  from: range.fromIso,
  to: range.toIso,
  days: days.length,
});

// ---- /analytics/overview ----
export interface OverviewData {
  range: RangeOut;
  realSends: number;
  kpis: {
    leadsEnrolled: number;
    draftsGenerated: number;
    realSends: number;
    replies: number;
    positiveReplies: number;
  };
  series: { date: string; enrolled: number; drafts: number; sent: number }[];
}

export function buildOverview(
  range: DateRange,
  enrollments: EnrRow[],
  messages: MsgRow[],
): OverviewData {
  const days = eachUtcDay(range);
  const outbound = messages.filter((m) => m.direction === 'outbound');
  const inbound = messages.filter((m) => m.direction === 'inbound');
  const realSends = outbound.filter((m) => m.status !== 'dry_run').length;

  const idx = new Map(days.map((d) => [d, { date: d, enrolled: 0, drafts: 0, sent: 0 }]));
  for (const e of enrollments) {
    const b = idx.get(dayKey(e.created_at));
    if (b) b.enrolled += 1;
  }
  for (const m of outbound) {
    const b = idx.get(dayKey(m.created_at));
    if (!b) continue;
    b.drafts += 1;
    if (m.status !== 'dry_run') b.sent += 1;
  }

  return {
    range: rangeOut(range, days),
    realSends,
    kpis: {
      leadsEnrolled: enrollments.length,
      draftsGenerated: outbound.length,
      realSends,
      replies: inbound.length,
      positiveReplies: inbound.filter((m) => m.category === 'interested').length,
    },
    series: days.map(
      (d) => idx.get(d) as { date: string; enrolled: number; drafts: number; sent: number },
    ),
  };
}

// ---- /analytics/messaging ----
export interface CampaignRollup {
  campaignId: string;
  name: string;
  drafts: number;
  sent: number;
  replies: number;
  positive: number;
}
// A/Z variant rollup (4.4) — DERIVED from messages via message→enrollment→variant. A variant row
// counts only messages still linked to an enrollment (an enrollment-detached message is honestly
// excluded). realSends===0 → all-zero rows (the comparison is honest-empty, never a fabricated winner).
export interface VariantRollup {
  variantId: string;
  label: string;
  campaignId: string;
  campaignName: string;
  drafts: number;
  sent: number;
  replies: number;
  positive: number;
}
export interface MessagingData {
  range: RangeOut;
  realSends: number;
  byStatus: Record<string, number>;
  byCampaign: CampaignRollup[];
  byVariant: VariantRollup[];
}

export function buildMessaging(
  range: DateRange,
  messages: MsgRow[],
  enrToCampaign: Map<string, string>,
  campaignName: Map<string, string>,
  enrToVariant: Map<string, string> = new Map(),
  variantLabel: Map<string, string> = new Map(),
): MessagingData {
  const days = eachUtcDay(range);
  const outbound = messages.filter((m) => m.direction === 'outbound');
  const realSends = outbound.filter((m) => m.status !== 'dry_run').length;

  const byStatus: Record<string, number> = Object.fromEntries(OUTBOUND_STATUSES.map((s) => [s, 0]));
  for (const m of outbound)
    if (m.status in byStatus) byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;

  const camp = new Map<string, CampaignRollup>();
  const ensureCampaign = (id: string): CampaignRollup => {
    let row = camp.get(id);
    if (!row) {
      row = {
        campaignId: id,
        name: campaignName.get(id) ?? 'Untitled',
        drafts: 0,
        sent: 0,
        replies: 0,
        positive: 0,
      };
      camp.set(id, row);
    }
    return row;
  };
  const variant = new Map<string, VariantRollup>();
  const ensureVariant = (variantId: string, campaignId: string): VariantRollup => {
    let row = variant.get(variantId);
    if (!row) {
      row = {
        variantId,
        label: variantLabel.get(variantId) ?? '—',
        campaignId,
        campaignName: campaignName.get(campaignId) ?? 'Untitled',
        drafts: 0,
        sent: 0,
        replies: 0,
        positive: 0,
      };
      variant.set(variantId, row);
    }
    return row;
  };

  // One pass: every message attributes to its campaign rollup, and (if its enrollment carries a
  // variant) its variant rollup. Same counting rule for both, so the two tables stay consistent.
  const tally = (row: CampaignRollup | VariantRollup, m: MsgRow) => {
    if (m.direction === 'outbound') {
      row.drafts += 1;
      if (m.status !== 'dry_run') row.sent += 1;
    } else if (m.direction === 'inbound') {
      row.replies += 1;
      if (m.category === 'interested') row.positive += 1;
    }
  };
  for (const m of messages) {
    if (!m.enrollment_id) continue; // enrollment-detached → honestly excluded from both rollups
    const cid = enrToCampaign.get(m.enrollment_id);
    if (cid) tally(ensureCampaign(cid), m);
    const vid = enrToVariant.get(m.enrollment_id);
    if (vid && cid) tally(ensureVariant(vid, cid), m);
  }

  return {
    range: rangeOut(range, days),
    realSends,
    byStatus,
    byCampaign: [...camp.values()].sort((a, b) => b.drafts - a.drafts),
    byVariant: [...variant.values()].sort((a, b) => b.drafts - a.drafts),
  };
}

// ---- /analytics/credits ----
export interface CreditsAnalyticsData {
  range: RangeOut;
  balance: number;
  granted: number;
  used: number;
  byReason: Record<string, number>;
  series: { date: string; granted: number; used: number }[];
}

export function buildCredits(range: DateRange, ledger: LedgerRow[]): CreditsAnalyticsData {
  const days = eachUtcDay(range);
  // Balance is all-time (the running ledger). byReason + series are windowed (burn in range).
  let granted = 0;
  let used = 0;
  for (const r of ledger) {
    if (r.delta >= 0) granted += r.delta;
    else used += -r.delta;
  }
  const fromMs = Date.parse(range.fromIso);
  const toMs = Date.parse(range.toIso);
  const windowed = ledger.filter((r) => {
    const t = Date.parse(r.created_at);
    return t >= fromMs && t <= toMs;
  });

  const byReason: Record<string, number> = Object.fromEntries(LEDGER_REASONS.map((x) => [x, 0]));
  for (const r of windowed)
    if (r.reason in byReason) byReason[r.reason] = round6((byReason[r.reason] ?? 0) + r.delta);

  const idx = new Map(days.map((d) => [d, { date: d, granted: 0, used: 0 }]));
  for (const r of windowed) {
    const b = idx.get(dayKey(r.created_at));
    if (!b) continue;
    if (r.delta >= 0) b.granted = round6(b.granted + r.delta);
    else b.used = round6(b.used + -r.delta);
  }

  return {
    range: rangeOut(range, days),
    balance: round6(granted - used),
    granted: round6(granted),
    used: round6(used),
    byReason,
    series: days.map((d) => idx.get(d) as { date: string; granted: number; used: number }),
  };
}
