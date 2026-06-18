import { describe, expect, it } from 'vitest';
import {
  buildCredits,
  buildMessaging,
  buildOverview,
  dayKey,
  eachUtcDay,
  type MsgRow,
  resolveRange,
} from './analytics.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-06-16T12:00:00.000Z');

describe('resolveRange', () => {
  it('defaults to the last 30 days', () => {
    const r = resolveRange(undefined, undefined, NOW);
    expect(r.toIso).toBe(new Date(NOW).toISOString());
    expect(Date.parse(r.toIso) - Date.parse(r.fromIso)).toBe(30 * DAY);
  });
  it('honors explicit from/to', () => {
    const r = resolveRange('2026-06-01T00:00:00.000Z', '2026-06-10T00:00:00.000Z', NOW);
    expect(r.fromIso).toBe('2026-06-01T00:00:00.000Z');
    expect(r.toIso).toBe('2026-06-10T00:00:00.000Z');
  });
  it('normalizes an inverted range', () => {
    const r = resolveRange('2026-06-10T00:00:00.000Z', '2026-06-01T00:00:00.000Z', NOW);
    expect(r.fromIso).toBe('2026-06-01T00:00:00.000Z');
    expect(r.toIso).toBe('2026-06-10T00:00:00.000Z');
  });
  it('falls back to the default window on invalid input', () => {
    const r = resolveRange('not-a-date', undefined, NOW);
    expect(Date.parse(r.toIso) - Date.parse(r.fromIso)).toBe(30 * DAY);
  });
});

describe('eachUtcDay / dayKey', () => {
  it('spans inclusive UTC days', () => {
    const days = eachUtcDay({ fromIso: '2026-06-14T10:00:00Z', toIso: '2026-06-16T02:00:00Z' });
    expect(days).toEqual(['2026-06-14', '2026-06-15', '2026-06-16']);
  });
  it('dayKey tolerates a +00:00 offset', () => {
    expect(dayKey('2026-06-16T23:30:00+00:00')).toBe('2026-06-16');
  });
});

describe('buildOverview', () => {
  const range = { fromIso: '2026-06-15T00:00:00.000Z', toIso: '2026-06-16T00:00:00.000Z' };
  it('counts real-vs-dry sends, replies, positive replies; buckets by day', () => {
    const enr = [{ created_at: '2026-06-15T01:00:00Z' }, { created_at: '2026-06-16T01:00:00Z' }];
    const msgs: MsgRow[] = [
      {
        created_at: '2026-06-15T02:00:00Z',
        direction: 'outbound',
        status: 'dry_run',
        category: null,
      },
      { created_at: '2026-06-15T03:00:00Z', direction: 'outbound', status: 'sent', category: null },
      {
        created_at: '2026-06-16T03:00:00Z',
        direction: 'inbound',
        status: 'replied',
        category: 'interested',
      },
      {
        created_at: '2026-06-16T04:00:00Z',
        direction: 'inbound',
        status: 'replied',
        category: 'not_interested',
      },
    ];
    const o = buildOverview(range, enr, msgs);
    expect(o.kpis.leadsEnrolled).toBe(2);
    expect(o.kpis.draftsGenerated).toBe(2); // both outbound (dry_run + sent)
    expect(o.kpis.realSends).toBe(1); // only the non-dry_run
    expect(o.realSends).toBe(1);
    expect(o.kpis.replies).toBe(2);
    expect(o.kpis.positiveReplies).toBe(1); // category === 'interested'
    expect(o.series).toEqual([
      { date: '2026-06-15', enrolled: 1, drafts: 2, sent: 1 },
      { date: '2026-06-16', enrolled: 1, drafts: 0, sent: 0 },
    ]);
  });
});

describe('buildMessaging', () => {
  const range = { fromIso: '2026-06-16T00:00:00.000Z', toIso: '2026-06-16T23:59:59.000Z' };
  it('zeros every status + counts; rolls up by campaign via enrollment→campaign', () => {
    const msgs: MsgRow[] = [
      {
        created_at: '2026-06-16T01:00:00Z',
        direction: 'outbound',
        status: 'dry_run',
        category: null,
        enrollment_id: 'e1',
      },
      {
        created_at: '2026-06-16T02:00:00Z',
        direction: 'outbound',
        status: 'sent',
        category: null,
        enrollment_id: 'e1',
      },
      {
        created_at: '2026-06-16T03:00:00Z',
        direction: 'inbound',
        status: 'replied',
        category: 'interested',
        enrollment_id: 'e1',
      },
    ];
    const m = buildMessaging(
      range,
      msgs,
      new Map([['e1', 'c1']]),
      new Map([['c1', 'Demo']]),
      new Map([['e1', 'v1']]),
      new Map([['v1', 'A']]),
    );
    expect(m.byStatus.dry_run).toBe(1);
    expect(m.byStatus.sent).toBe(1);
    expect(m.byStatus.queued).toBe(0); // zeroed but present
    expect(m.realSends).toBe(1);
    expect(m.byCampaign).toEqual([
      { campaignId: 'c1', name: 'Demo', drafts: 2, sent: 1, replies: 1, positive: 1 },
    ]);
    // 4.4 — the same data rolled up by variant (the 'interested' inbound counts as positive).
    expect(m.byVariant).toEqual([
      {
        variantId: 'v1',
        label: 'A',
        campaignId: 'c1',
        campaignName: 'Demo',
        drafts: 2,
        sent: 1,
        replies: 1,
        positive: 1,
      },
    ]);
  });

  it('byVariant excludes enrollment-detached messages + stays empty when no variants are mapped', () => {
    const msgs: MsgRow[] = [
      {
        created_at: '2026-06-16T01:00:00Z',
        direction: 'outbound',
        status: 'sent',
        category: null,
        enrollment_id: 'e1',
      },
      {
        created_at: '2026-06-16T02:00:00Z',
        direction: 'outbound',
        status: 'sent',
        category: null,
        enrollment_id: null,
      }, // detached → excluded
    ];
    const m = buildMessaging(range, msgs, new Map([['e1', 'c1']]), new Map([['c1', 'Demo']]));
    expect(m.byVariant).toEqual([]); // no variant map → no rollup
    expect(m.byCampaign[0]?.drafts).toBe(1); // only the attached message counts
  });
});

describe('buildCredits', () => {
  it('balance is all-time; byReason + series are windowed', () => {
    const range = { fromIso: '2026-06-16T00:00:00.000Z', toIso: '2026-06-16T23:59:59.999Z' };
    const ledger = [
      { created_at: '2026-06-01T00:00:00Z', delta: 100, reason: 'signup_grant' }, // outside window
      { created_at: '2026-06-16T01:00:00Z', delta: -1, reason: 'send' },
      { created_at: '2026-06-16T02:00:00Z', delta: -2, reason: 'reply' },
    ];
    const c = buildCredits(range, ledger);
    expect(c.balance).toBe(97); // all-time 100 - 1 - 2
    expect(c.granted).toBe(100);
    expect(c.used).toBe(3);
    expect(c.byReason.send).toBe(-1); // windowed net per reason
    expect(c.byReason.reply).toBe(-2);
    expect(c.byReason.signup_grant).toBe(0); // grant is outside the window
    expect(c.series).toEqual([{ date: '2026-06-16', granted: 0, used: 3 }]);
  });
});
