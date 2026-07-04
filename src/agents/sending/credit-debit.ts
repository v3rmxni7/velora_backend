import type { SupabaseClient } from '@supabase/supabase-js';

export interface SendDebitParams {
  organizationId: string;
  // 'enrichment' reuses the same best-effort discipline: the provider's export credit is already
  // consumed by the time we debit, so a debit failure must be logged for reconciliation, never
  // thrown (throwing would fail an enrollment whose paid work already succeeded).
  reason: 'send' | 'reply' | 'enrichment';
  delta: number; // signed, negative for a debit
  reference: Record<string, unknown>;
  idempotencyKey: string;
}

/**
 * Record a per-send / per-reply credit debit AFTER the (already-irreversible) Smartlead push.
 * BEST-EFFORT BY CONSTRUCTION: the email is out and cannot be un-sent, so this NEVER throws and never
 * fails the send. The idempotency_key makes it at-most-once — a 23505 is "already charged" (a no-op on
 * retry). Any OTHER DB error is LOGGED with a reconcile marker (an under-charge to reconcile later),
 * never surfaced as a send failure: throwing here would falsely mark the enrollment failed and, via
 * the caller's claim-before-push row, leave the send both un-metered AND un-retried. It can never
 * double-charge (the key) nor double-send (the caller's claim row). Audit fix N2 (Fix-slice A).
 */
export async function bestEffortSendDebit(
  admin: SupabaseClient,
  params: SendDebitParams,
): Promise<void> {
  const { error } = await admin.from('credit_ledger').insert({
    organization_id: params.organizationId,
    delta: params.delta,
    reason: params.reason,
    reference: params.reference,
    idempotency_key: params.idempotencyKey,
  });
  if (error && error.code !== '23505') {
    console.error(
      `[credit-debit] reconcile: ${params.reason} debit failed AFTER a successful push (the send succeeded; this org is under-charged) — idempotency_key=${params.idempotencyKey}`,
      error,
    );
  }
}
