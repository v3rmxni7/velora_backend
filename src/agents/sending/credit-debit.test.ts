import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { bestEffortSendDebit, type SendDebitParams } from './credit-debit.js';

// Guard test (audit N2): a credit debit runs AFTER the irreversible push, so it must NEVER throw —
// the email is already out. A throw would (via the caller's claim row) leave the send un-metered AND
// un-retried. This encodes "debit-after-push never throws; 23505 is a silent no-op; other errors are
// logged for reconciliation, not surfaced."
function stubAdmin(error: { code: string } | null): SupabaseClient {
  return { from: () => ({ insert: async () => ({ error }) }) } as unknown as SupabaseClient;
}
const params: SendDebitParams = {
  organizationId: 'org',
  reason: 'send',
  delta: -1,
  reference: { type: 'message', id: 'm1' },
  idempotencyKey: 'send:org:enr:0',
};

describe('bestEffortSendDebit', () => {
  it('never throws on a non-23505 error and logs a reconcile marker', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(bestEffortSendDebit(stubAdmin({ code: '500' }), params)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('is a silent no-op on 23505 (already charged on a retry)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      bestEffortSendDebit(stubAdmin({ code: '23505' }), params),
    ).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('resolves on a successful insert', async () => {
    await expect(bestEffortSendDebit(stubAdmin(null), params)).resolves.toBeUndefined();
  });
});
