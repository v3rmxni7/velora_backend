import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';
import { orgCreditBalance } from './credit-balance.js';

// S1 — go-live readiness. The prereqs that must be green before an org may flip to live sending.
// evaluateReadiness is PURE (takes gathered facts) so it is exhaustively unit-testable; gatherReadiness
// reads the real per-org state + env. The go-live route re-runs gatherReadiness SERVER-SIDE at flip
// time (never trusts the client), so a stale/edited client view cannot get past a red prereq.

export interface ReadinessItem {
  key: string;
  label: string;
  ok: boolean;
  /** Blocking items must all be `ok` for `ready`. Non-blocking are advisory (shown, not gating). */
  blocking: boolean;
  detail: string;
}

export interface ReadinessResult {
  ready: boolean;
  items: ReadinessItem[];
}

/** Facts gathered from DB + env — passed explicitly so evaluateReadiness stays pure/testable. */
export interface ReadinessFacts {
  warmMailboxes: number;
  activeSenders: number;
  creditBalance: number;
  postalAddressSet: boolean; // L1 — CAN-SPAM physical address
  goLiveReviewed: boolean; // anti-abuse staff-review gate
  smartleadConfigured: boolean; // SMARTLEAD_API_KEY
  verifierConfigured: boolean; // MILLIONVERIFIER_API_KEY (H3 fails closed without it)
  unsubscribeConfigured: boolean; // L1 — PUBLIC_BASE_URL && UNSUBSCRIBE_SECRET (guard blocks without)
  webhookSecretSet: boolean; // SMARTLEAD_WEBHOOK_SECRET
}

/**
 * PURE. Every listed item is BLOCKING — a live send genuinely depends on each (warm mailbox to send
 * from, an active sender, credits, the L1 compliance footer inputs, the sending substrate + verifier,
 * the inbound-webhook secret so replies/bounces/unsubscribes are processed, and the staff-review gate).
 * `ready` is true only when all blocking items are ok. There is deliberately no "advisory" item that
 * could be mistaken for a pass; domain-auth (deliverability, not a send-blocker) is surfaced in the UI
 * from the existing compliance data, not gated here.
 */
export function evaluateReadiness(f: ReadinessFacts): ReadinessResult {
  const items: ReadinessItem[] = [
    {
      key: 'warm_mailbox',
      label: 'At least one warm mailbox',
      ok: f.warmMailboxes > 0,
      blocking: true,
      detail: f.warmMailboxes > 0 ? `${f.warmMailboxes} warm` : 'no warm mailbox to send from',
    },
    {
      key: 'active_sender',
      label: 'An active sender',
      ok: f.activeSenders > 0,
      blocking: true,
      detail: f.activeSenders > 0 ? `${f.activeSenders} active` : 'no active sender',
    },
    {
      key: 'credits',
      label: 'Credit balance available',
      ok: f.creditBalance > 0,
      blocking: true,
      detail: `${f.creditBalance} credits`,
    },
    {
      key: 'postal_address',
      label: 'Physical postal address (CAN-SPAM)',
      ok: f.postalAddressSet,
      blocking: true,
      detail: f.postalAddressSet ? 'set' : 'required — set it in Compliance',
    },
    {
      key: 'unsubscribe_config',
      label: 'Unsubscribe link configured',
      ok: f.unsubscribeConfigured,
      blocking: true,
      detail: f.unsubscribeConfigured
        ? 'configured'
        : 'PUBLIC_BASE_URL / UNSUBSCRIBE_SECRET not set',
    },
    {
      key: 'smartlead',
      label: 'Sending substrate configured',
      ok: f.smartleadConfigured,
      blocking: true,
      detail: f.smartleadConfigured ? 'configured' : 'SMARTLEAD_API_KEY not set',
    },
    {
      key: 'verifier',
      label: 'Email verifier configured',
      ok: f.verifierConfigured,
      blocking: true,
      detail: f.verifierConfigured ? 'configured' : 'MILLIONVERIFIER_API_KEY not set',
    },
    {
      key: 'webhook_secret',
      label: 'Inbound webhook secret set',
      ok: f.webhookSecretSet,
      blocking: true,
      detail: f.webhookSecretSet ? 'set' : 'SMARTLEAD_WEBHOOK_SECRET not set',
    },
    {
      key: 'staff_review',
      label: 'Go-live reviewed',
      ok: f.goLiveReviewed,
      blocking: true,
      detail: f.goLiveReviewed ? 'reviewed' : 'pending review',
    },
  ];
  const ready = items.every((i) => !i.blocking || i.ok);
  return { ready, items };
}

/** The env-derived subset of the facts (global switches, not per-org). Read from env by default;
 *  injectable so tests can drive readiness deterministically without mutating the frozen env. */
export type EnvReadinessFacts = Pick<
  ReadinessFacts,
  'smartleadConfigured' | 'verifierConfigured' | 'unsubscribeConfigured' | 'webhookSecretSet'
>;

export function envReadinessFacts(): EnvReadinessFacts {
  return {
    smartleadConfigured: !!env.SMARTLEAD_API_KEY,
    verifierConfigured: !!env.MILLIONVERIFIER_API_KEY,
    unsubscribeConfigured: !!env.PUBLIC_BASE_URL && !!env.UNSUBSCRIBE_SECRET,
    webhookSecretSet: !!env.SMARTLEAD_WEBHOOK_SECRET,
  };
}

/** Gather the real per-org facts (RLS-scoped `db`) + env, then evaluate. Used by GET /sending/readiness
 *  AND re-run server-side inside POST /sending/go-live. `envFacts` defaults to the real env. */
export async function gatherReadiness(
  db: SupabaseClient,
  organizationId: string,
  envFacts: EnvReadinessFacts = envReadinessFacts(),
): Promise<ReadinessResult> {
  const [warm, senders, org, credits] = await Promise.all([
    db.from('mailboxes').select('id', { count: 'exact', head: true }).eq('status', 'warm'),
    db.from('senders').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    db
      .from('organizations')
      .select('postal_address, go_live_reviewed')
      .eq('id', organizationId)
      .maybeSingle(),
    orgCreditBalance(db, organizationId),
  ]);
  if (warm.error) throw warm.error;
  if (senders.error) throw senders.error;
  if (org.error) throw org.error;

  return evaluateReadiness({
    warmMailboxes: warm.count ?? 0,
    activeSenders: senders.count ?? 0,
    creditBalance: credits,
    postalAddressSet: !!(org.data?.postal_address as string | null)?.trim(),
    goLiveReviewed: org.data?.go_live_reviewed === true,
    ...envFacts,
  });
}
