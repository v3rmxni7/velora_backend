import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { runSendRedrive } from './redrive.js';

// The send-redrive sweep: re-drive ONLY awaiting_approval enrollments whose task is 'approved'
// (deferred sends), through the idempotent executeSend; leave human-pending ones alone; isolate
// per-enrollment failures.

function stubDb(enrollments: any[], tasks: { id: string; status: string }[]): SupabaseClient {
  return {
    from(table: string) {
      if (table === 'enrollments') {
        const q: any = {
          select: () => q,
          eq: () => q,
          not: () => q,
          order: () => q,
          limit: async () => ({ data: enrollments, error: null }),
        };
        return q;
      }
      if (table === 'tasks') {
        return {
          select: () => ({ in: async () => ({ data: tasks, error: null }) }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
}

const enr = (id: string, taskId: string) => ({
  id,
  organization_id: 'org1',
  campaign_id: 'c1',
  lead_type: 'person',
  lead_id: `lead-${id}`,
  status: 'awaiting_approval',
  current_step: 0,
  task_id: taskId,
  variant_id: null,
  verified_email: `${id}@x.com`,
  verification: 'deliverable',
});

describe('runSendRedrive', () => {
  it('re-drives only enrollments whose task is approved (skips pending-task ones)', async () => {
    const db = stubDb(
      [enr('a', 't1'), enr('b', 't2'), enr('c', 't3')],
      [
        { id: 't1', status: 'approved' },
        { id: 't2', status: 'pending' }, // waiting on a human — NOT deferred, leave alone
        { id: 't3', status: 'approved' },
      ],
    );
    const send = vi.fn(async () => ({ outcome: 'queued' as const, messageId: 'm' }));
    const res = await runSendRedrive(db, { send });
    expect(res.considered).toBe(3);
    expect(res.redriven).toBe(2); // t1 + t3 only
    expect(send).toHaveBeenCalledTimes(2);
    expect(res.outcomes.queued).toBe(2);
  });

  it('tallies deferred outcomes (still-blocked enrollments just defer again — no throw)', async () => {
    const db = stubDb([enr('a', 't1'), enr('b', 't2')], [
      { id: 't1', status: 'approved' },
      { id: 't2', status: 'approved' },
    ]);
    const send = vi
      .fn()
      .mockResolvedValueOnce({ outcome: 'rate_limited' })
      .mockResolvedValueOnce({ outcome: 'campaign_paused' });
    const res = await runSendRedrive(db, { send });
    expect(res.outcomes).toEqual({ rate_limited: 1, campaign_paused: 1 });
  });

  it('isolates a per-enrollment failure (one throw does not abort the sweep)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = stubDb([enr('a', 't1'), enr('b', 't2')], [
      { id: 't1', status: 'approved' },
      { id: 't2', status: 'approved' },
    ]);
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ outcome: 'queued' });
    const res = await runSendRedrive(db, { send });
    expect(res.outcomes.error).toBe(1);
    expect(res.outcomes.queued).toBe(1);
    spy.mockRestore();
  });

  it('no candidates → no task lookup, empty result', async () => {
    const db = stubDb([], []);
    const send = vi.fn();
    const res = await runSendRedrive(db, { send });
    expect(res).toEqual({ considered: 0, redriven: 0, outcomes: {} });
    expect(send).not.toHaveBeenCalled();
  });
});
