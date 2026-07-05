import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { runFollowupStep } from './followup.js';

// Bug-A fix: when the advance CAS misses, distinguish a not-yet-DELIVERED prior step (live
// enrollment still 'queued' → DEFER + reschedule) from a genuinely terminal one (replied/bounced →
// halt). Previously any CAS miss halted → a follow-up whose step-1 hadn't been delivered yet (live
// 'queued' awaiting the EMAIL_SENT webhook) permanently killed the whole chain.

function stubDb(opts: {
  enrollmentStatus: string; // status on the FIRST full read AND the fresh re-read
  currentStep?: number;
}): SupabaseClient {
  const currentStep = opts.currentStep ?? 1;
  let enrollmentReads = 0;
  return {
    from(table: string) {
      if (table === 'enrollments') {
        return {
          select: (cols: string) => {
            // full read (select '*') is first; the fresh re-read selects 'status, current_step'
            const q: any = {
              eq: () => q,
              maybeSingle: async () => {
                enrollmentReads += 1;
                if (cols === '*') {
                  return {
                    data: {
                      id: 'enr1',
                      organization_id: 'org1',
                      campaign_id: 'c1',
                      lead_type: 'person',
                      lead_id: 'l1',
                      status: opts.enrollmentStatus,
                      current_step: currentStep,
                      task_id: 'prev-task',
                      variant_id: null,
                      verified_email: 'lead@x.com',
                    },
                    error: null,
                  };
                }
                return { data: { status: opts.enrollmentStatus, current_step: currentStep }, error: null };
              },
            };
            return q;
          },
          update: () => {
            const q: any = { eq: () => q, select: async () => ({ data: [], error: null }) };
            return q; // CAS always misses (0 rows) in these tests
          },
        };
      }
      if (table === 'campaigns') {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { status: 'active' }, error: null }) }),
          }),
        };
      }
      if (table === 'suppression_list') {
        return { select: () => ({ eq: async () => ({ data: [], error: null }) }) };
      }
      if (table === 'campaign_steps') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: { step_number: 2 }, error: null }) }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
}

describe('runFollowupStep — CAS-miss delivery-aware defer (Bug A)', () => {
  it("DEFERS (reschedule) when the prior step is still 'queued' (not delivered yet)", async () => {
    const res = await runFollowupStep(stubDb({ enrollmentStatus: 'queued' }), 'enr1');
    expect(res?.status).toBe('deferred');
    expect(res?.step).toBe(2);
    expect(res?.reason).toBe('awaiting_delivery');
  });

  it("HALTS when the enrollment reached a terminal status (e.g. 'replied') — correct stop", async () => {
    const res = await runFollowupStep(stubDb({ enrollmentStatus: 'replied' }), 'enr1');
    expect(res?.status).toBe('halted');
    expect(res?.reason).toBe('not_sendable');
  });
});
