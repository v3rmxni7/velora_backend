import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from '../../config/env.js';
import type {
  SmartleadClient,
  SmartleadEmailAccount,
  SmartleadWarmupStats,
} from '../../integrations/smartlead/types.js';

// Shared mailbox-sync core: pulls Smartlead email accounts into the org's mailboxes, and
// refreshes per-mailbox warmup reputation. Read-only against Smartlead. The SmartleadClient is
// injected (default created by callers) so this is unit/integration-testable with a fake.

type Provider = 'gmail' | 'microsoft' | 'smtp' | 'unknown';

/** Map Smartlead's account `type` to our provider enum. */
export function mapProvider(type?: string): Provider {
  const t = (type ?? '').toUpperCase();
  if (t.includes('GMAIL') || t.includes('GOOGLE')) return 'gmail';
  if (
    t.includes('OUTLOOK') ||
    t.includes('MICROSOFT') ||
    t.includes('OFFICE') ||
    t.includes('O365')
  )
    return 'microsoft';
  if (t.includes('SMTP')) return 'smtp';
  return 'unknown';
}

/** Derive our mailbox status from Smartlead's warmup status. */
export function mapWarmupStatus(warmup?: SmartleadEmailAccount['warmup_details']): string {
  const s = String(warmup?.status ?? '').toUpperCase();
  if (s.includes('ACTIVE') || s.includes('RUNNING') || s.includes('WARM')) return 'warming';
  return 'connected';
}

export interface MailboxUpsertRow {
  organization_id: string;
  smartlead_email_account_id: string;
  email: string;
  provider: Provider;
  daily_cap: number | null;
  warmup_state: Record<string, unknown> | null;
  status: string;
}

/** Pure: one Smartlead account → a mailbox upsert row. */
export function mapAccountToMailboxRow(
  account: SmartleadEmailAccount,
  organizationId: string,
): MailboxUpsertRow {
  const warmup = account.warmup_details ?? null;
  return {
    organization_id: organizationId,
    smartlead_email_account_id: String(account.id),
    email: account.from_email,
    provider: mapProvider(account.type),
    daily_cap: typeof account.max_email_per_day === 'number' ? account.max_email_per_day : null,
    warmup_state: warmup ? (warmup as Record<string, unknown>) : null,
    status: mapWarmupStatus(warmup),
  };
}

/** Pure: warmup-stats → the reputation blob we store (best-effort totals + raw for the UI). */
export function mapWarmupStatsToReputation(stats: SmartleadWarmupStats): Record<string, unknown> {
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  return {
    sent: num(stats.sent_count),
    inbox: num(stats.inbox_count),
    spam: num(stats.spam_count),
    raw: stats,
  };
}

// Warmth thresholds — a mailbox is only "warm" (safe to send real cold outreach from) once warmup
// has been running AND it has a healthy track record. Sending from a cold/just-synced mailbox burns
// sender reputation, so the send path (ensureSmartleadCampaign) filters to 'warm' only. Tunable.
export const MIN_WARMUP_SENT = 100;
export const MAX_SPAM_RATE = 0.05;

/**
 * Pure: a mailbox is 'warm' only when warmup is active AND its reputation clears the thresholds;
 * 'warming' while active but still proving itself; 'connected' when warmup isn't running. This is
 * what makes the 'warm' status reachable — mapWarmupStatus (initial sync, no stats yet) only ever
 * yields 'warming'/'connected'; the promotion to 'warm' happens here, on a stats refresh.
 */
export function classifyWarmth(
  reputation: { sent?: number; spam?: number } | null | undefined,
  warmupActive: boolean,
  override = false,
): 'warm' | 'warming' | 'connected' {
  const sent = reputation?.sent ?? 0;
  const spam = reputation?.spam ?? 0;
  const spamRate = sent > 0 ? spam / sent : 0; // no sends yet → no evidence of spam (0, not 1)
  // Established-mailbox override: an operator has attested this is a real, in-use mailbox, so skip
  // the warm-up SEND threshold — but still honor the spam-rate ceiling as a live safety (if a warm-up
  // read ever shows a bad spam rate, it will NOT be forced warm). Independent of warmupActive: an
  // established mailbox is warm whether or not the warm-up tool is currently running.
  if (override) return spamRate <= MAX_SPAM_RATE ? 'warm' : 'warming';
  if (!warmupActive) return 'connected';
  if (sent >= MIN_WARMUP_SENT && spamRate <= MAX_SPAM_RATE) return 'warm';
  return 'warming';
}

/**
 * Pure: the tenant-isolation gate — keep only accounts whose Smartlead id is in the owned set (this
 * org's existing mailbox ids ∪ the connect-lane adopt-allowlist). Everything else belongs to another
 * tenant under the shared master key and is dropped. Extracted + unit-tested so a regression is caught
 * in ordinary CI, not only under the RUN_DB_IT integration pass.
 */
export function filterToOwnedAccounts(
  accounts: SmartleadEmailAccount[],
  ownedIds: ReadonlySet<string>,
): SmartleadEmailAccount[] {
  return accounts.filter((a) => ownedIds.has(String(a.id)));
}

/**
 * Pull Smartlead accounts into mailboxes (upsert by org+email). Returns synced mailbox ids.
 *
 * TENANT ISOLATION (Phase 2): Smartlead's list-email-accounts is account-GLOBAL — all orgs share one
 * master key, so the raw list contains EVERY tenant's mailboxes. Adopting it wholesale would let one
 * org pull another org's mailboxes (a cross-tenant leak RLS can't stop, since the written row is
 * legitimately this org's). So we adopt ONLY accounts this org already owns (its existing mailbox rows)
 * plus any explicitly just-connected id (`opts.adoptAccountIds`, from the S3 connect lane — that
 * account has no mailbox row yet). Anything else is NEVER adopted. Fail-closed. The filter is gated by
 * `env.SMARTLEAD_SYNC_OWNED_ONLY` (default on; `opts.ownedOnly` overrides for tests).
 */
export async function syncMailboxes(
  db: SupabaseClient,
  organizationId: string,
  client: SmartleadClient,
  opts: { adoptAccountIds?: string[]; ownedOnly?: boolean } = {},
): Promise<{ synced: number; mailboxIds: string[] }> {
  const ownedOnly = opts.ownedOnly ?? env.SMARTLEAD_SYNC_OWNED_ONLY;
  const accounts = await client.listEmailAccounts();
  let candidate = accounts.filter(
    (a) => typeof a.from_email === 'string' && a.from_email.length > 0,
  );
  if (ownedOnly) {
    const owned = new Set<string>((opts.adoptAccountIds ?? []).map(String));
    const existing = await db
      .from('mailboxes')
      .select('smartlead_email_account_id')
      .eq('organization_id', organizationId)
      .not('smartlead_email_account_id', 'is', null);
    if (existing.error) throw existing.error;
    for (const r of existing.data ?? []) {
      if (r.smartlead_email_account_id != null) owned.add(String(r.smartlead_email_account_id));
    }
    candidate = filterToOwnedAccounts(candidate, owned);
  }
  const rows = candidate.map((a) => mapAccountToMailboxRow(a, organizationId));
  if (rows.length === 0) return { synced: 0, mailboxIds: [] };
  const up = await db
    .from('mailboxes')
    .upsert(rows, { onConflict: 'organization_id,email' })
    .select('id');
  if (up.error) throw up.error;
  const ids = (up.data ?? []).map((r) => r.id as string);
  // The upsert recomputes status from Smartlead's warmup_details ('warming'/'connected'), which would
  // otherwise DOWNGRADE an operator-attested established mailbox on every re-sync. Re-assert 'warm'
  // for any overridden mailbox so the attestation sticks. (A per-mailbox refresh then keeps it warm.)
  const reWarm = await db
    .from('mailboxes')
    .update({ status: 'warm' })
    .eq('organization_id', organizationId)
    .eq('warmup_override', true)
    .neq('status', 'warm')
    .select('id');
  if (reWarm.error) throw reWarm.error;
  return { synced: ids.length, mailboxIds: ids };
}

/** Refresh one mailbox's warmup reputation from Smartlead. No-op if it has no Smartlead link. */
export async function refreshMailboxWarmup(
  db: SupabaseClient,
  client: SmartleadClient,
  mailboxId: string,
): Promise<{ ok: boolean }> {
  const mb = await db
    .from('mailboxes')
    .select('id, smartlead_email_account_id, status, warmup_override')
    .eq('id', mailboxId)
    .maybeSingle();
  if (mb.error) throw mb.error;
  const smartleadId = mb.data?.smartlead_email_account_id as string | null | undefined;
  if (!smartleadId) return { ok: false };
  const stats = await client.getWarmupStats(smartleadId);
  const reputation = mapWarmupStatsToReputation(stats);
  // Warmup was active iff the mailbox was previously 'warming'/'warm' (set from the account's
  // warmup_details at sync time). Promote to 'warm' / demote on this fresh reputation read. The
  // established-mailbox override forces 'warm' (still spam-ceiling-checked) so a refresh never
  // demotes an operator-attested mailbox below the send threshold.
  const status = String(mb.data?.status ?? '');
  const warmupActive = status === 'warming' || status === 'warm';
  const override = mb.data?.warmup_override === true;
  const newStatus = classifyWarmth(
    reputation as { sent?: number; spam?: number },
    warmupActive,
    override,
  );
  // The established-mailbox override skips the warm-up VOLUME threshold, but must NEVER override the
  // spam-rate SAFETY. The ONLY way an override'd mailbox is not 'warm' here is a tripped spam ceiling
  // (classifyWarmth: override → 'warm' iff spamRate ≤ MAX_SPAM_RATE). When that happens, CLEAR the
  // override so the demotion is DURABLE — otherwise syncMailboxes' re-warm + the owner-gate exemption
  // would silently re-warm a spam-flagged mailbox. The owner must deliberately re-attest (owner-gated)
  // after fixing deliverability. This runs service-role (warmup monitor), so the owner trigger bypasses.
  const clearOverride = override && newStatus !== 'warm';
  const upd = await db
    .from('mailboxes')
    .update({
      reputation,
      status: newStatus,
      ...(clearOverride ? { warmup_override: false } : {}),
      last_synced_at: new Date().toISOString(),
    })
    .eq('id', mailboxId);
  if (upd.error) throw upd.error;
  return { ok: true };
}
