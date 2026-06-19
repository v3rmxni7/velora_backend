import type { SupabaseClient } from '@supabase/supabase-js';
import { recordAuditSafe } from '../../lib/audit.js';

// 4.12 — data-retention purge, DRY-RUN-FIRST (the two-flag sending invariant, applied to deletion).
// Per org: if retention_dry_run (default true) → REPORT + audit the would-purge counts, delete NOTHING.
// Only when an org's flag is deliberately flipped does it really DELETE + audit. Scope is ONLY
// anonymous/transient telemetry that's safe to drop: website_visits (no IP, terminal status) +
// processed/failed signal_events. Message/conversation history is NEVER purged here. Runs under the
// service-role client (the cron has no user); per-org organization_id scoping is explicit.

// Terminal (processing-done) statuses — rows that are safe to age out. 'failed' is a valid
// website_visits status from the 20260626000001 fix-forward.
const WEBSITE_VISIT_TERMINAL = ['identified', 'unresolved', 'failed'];
const SIGNAL_EVENT_TERMINAL = ['processed', 'failed'];
const DAY_MS = 86_400_000;

export interface RetentionResult {
  orgsProcessed: number;
  reportedOrgs: number; // orgs in dry-run with something to report
  purgedOrgs: number; // orgs where rows were really deleted
  websiteVisits: number;
  signalEvents: number;
}

async function countOrDelete(
  admin: SupabaseClient,
  table: string,
  orgId: string,
  cutoffIso: string,
  terminalStatuses: string[],
  dryRun: boolean,
): Promise<number> {
  if (dryRun) {
    const { count, error } = await admin
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .lt('created_at', cutoffIso)
      .in('status', terminalStatuses);
    if (error) throw error;
    return count ?? 0;
  }
  const { count, error } = await admin
    .from(table)
    .delete({ count: 'exact' })
    .eq('organization_id', orgId)
    .lt('created_at', cutoffIso)
    .in('status', terminalStatuses);
  if (error) throw error;
  return count ?? 0;
}

export async function runRetentionPurge(
  admin: SupabaseClient,
  now: Date = new Date(),
): Promise<RetentionResult> {
  const orgs = await admin
    .from('organizations')
    .select('id, retention_days_website_visits, retention_days_signal_events, retention_dry_run');
  if (orgs.error) throw orgs.error;

  const result: RetentionResult = {
    orgsProcessed: 0,
    reportedOrgs: 0,
    purgedOrgs: 0,
    websiteVisits: 0,
    signalEvents: 0,
  };

  for (const org of orgs.data ?? []) {
    result.orgsProcessed++;
    const dryRun = org.retention_dry_run !== false; // default-safe: anything but explicit false = dry-run
    const orgId = org.id as string;
    const wvCut = new Date(
      now.getTime() - Number(org.retention_days_website_visits) * DAY_MS,
    ).toISOString();
    const seCut = new Date(
      now.getTime() - Number(org.retention_days_signal_events) * DAY_MS,
    ).toISOString();

    const wv = await countOrDelete(
      admin,
      'website_visits',
      orgId,
      wvCut,
      WEBSITE_VISIT_TERMINAL,
      dryRun,
    );
    const se = await countOrDelete(
      admin,
      'signal_events',
      orgId,
      seCut,
      SIGNAL_EVENT_TERMINAL,
      dryRun,
    );
    result.websiteVisits += wv;
    result.signalEvents += se;

    // Audit only when there's something — keeps the trail signal-rich (no daily zero-noise rows).
    if (wv > 0 || se > 0) {
      await recordAuditSafe(admin, {
        organizationId: orgId,
        kind: dryRun ? 'retention_reported' : 'retention_purged',
        args: { websiteVisits: wv, signalEvents: se },
        reason: dryRun ? 'dry_run' : 'purged',
        source: 'cron',
      });
      if (dryRun) result.reportedOrgs++;
      else result.purgedOrgs++;
    }
  }

  return result;
}
