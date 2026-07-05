import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import type { SmartleadEvent } from '../../lib/smartlead-webhook.js';
import { applySmartleadEvent } from './inbound.js';

// Guards the two webhook-safety fixes:
//  (1) an EMAIL_SENT confirmation may only promote a 'queued' enrollment to 'sent' — a late/dup
//      EMAIL_SENT must NOT resurrect a terminal status (replied/bounced/unsubscribed).
//  (2) resolveTarget takes the MOST RECENT enrollment (order+limit) so a re-enrolled (campaign,email)
//      pair never 500s the webhook via .maybeSingle() on multiple rows.

interface Rec {
  enrollmentUpdate?: { patch: Record<string, unknown>; statusIn?: string[] };
  enrollmentOrderLimit?: boolean;
}

function stubDb(enrollmentStatusRow: { id: string; thread_id: string | null }, rec: Rec): SupabaseClient {
  return {
    from(table: string) {
      if (table === 'campaigns') {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { id: 'camp1', organization_id: 'org1' }, error: null }) }),
          }),
        };
      }
      if (table === 'messages') {
        // update(...).eq().eq().eq() → resolves ok
        const chain: any = { eq: () => chain, then: (r: any) => r({ error: null }) };
        return { update: () => chain };
      }
      if (table === 'enrollments') {
        return {
          // resolveTarget read: select().eq().eq().eq().order().limit().maybeSingle()
          select: () => {
            const q: any = {
              eq: () => q,
              order: () => {
                rec.enrollmentOrderLimit = true;
                return q;
              },
              limit: () => q,
              maybeSingle: async () => ({ data: enrollmentStatusRow, error: null }),
            };
            return q;
          },
          // enrollment status update: update({status}).eq('id').in('status',[...])
          update: (patch: Record<string, unknown>) => {
            rec.enrollmentUpdate = { patch };
            const chain: any = {
              eq: () => chain,
              in: (_col: string, vals: string[]) => {
                rec.enrollmentUpdate!.statusIn = vals;
                return { then: (r: any) => r({ error: null }) };
              },
              then: (r: any) => r({ error: null }),
            };
            return chain;
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
}

const sentEvent: SmartleadEvent = {
  event_type: 'EMAIL_SENT',
  campaign_id: 'sl-1',
  to_email: 'lead@acme.com',
} as unknown as SmartleadEvent;

describe('applySmartleadEvent — EMAIL_SENT un-halt guard', () => {
  it('guards the enrollment promotion with status IN [queued] (never resurrects a terminal status)', async () => {
    const rec: Rec = {};
    const db = stubDb({ id: 'enr1', thread_id: null }, rec);
    const res = await applySmartleadEvent(db, sentEvent);
    expect(res.handled).toBe(true);
    expect(rec.enrollmentUpdate?.patch).toEqual({ status: 'sent' });
    // the critical assertion: the promotion is gated to pre-terminal 'queued' only
    expect(rec.enrollmentUpdate?.statusIn).toEqual(['queued']);
  });

  it('resolveTarget reads the most-recent enrollment (order+limit, not a throwing maybeSingle)', async () => {
    const rec: Rec = {};
    const db = stubDb({ id: 'enr1', thread_id: null }, rec);
    await applySmartleadEvent(db, sentEvent);
    expect(rec.enrollmentOrderLimit).toBe(true);
  });
});
