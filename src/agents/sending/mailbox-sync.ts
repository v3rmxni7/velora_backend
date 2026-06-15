import type { SupabaseClient } from '@supabase/supabase-js';
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

/** Pull Smartlead accounts into mailboxes (upsert by org+email). Returns synced mailbox ids. */
export async function syncMailboxes(
  db: SupabaseClient,
  organizationId: string,
  client: SmartleadClient,
): Promise<{ synced: number; mailboxIds: string[] }> {
  const accounts = await client.listEmailAccounts();
  const rows = accounts
    .filter((a) => typeof a.from_email === 'string' && a.from_email.length > 0)
    .map((a) => mapAccountToMailboxRow(a, organizationId));
  if (rows.length === 0) return { synced: 0, mailboxIds: [] };
  const up = await db
    .from('mailboxes')
    .upsert(rows, { onConflict: 'organization_id,email' })
    .select('id');
  if (up.error) throw up.error;
  const ids = (up.data ?? []).map((r) => r.id as string);
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
    .select('id, smartlead_email_account_id')
    .eq('id', mailboxId)
    .maybeSingle();
  if (mb.error) throw mb.error;
  const smartleadId = mb.data?.smartlead_email_account_id as string | null | undefined;
  if (!smartleadId) return { ok: false };
  const stats = await client.getWarmupStats(smartleadId);
  const upd = await db
    .from('mailboxes')
    .update({
      reputation: mapWarmupStatsToReputation(stats),
      last_synced_at: new Date().toISOString(),
    })
    .eq('id', mailboxId);
  if (upd.error) throw upd.error;
  return { ok: true };
}
