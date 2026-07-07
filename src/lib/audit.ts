import type { SupabaseClient } from '@supabase/supabase-js';

// 4.12 — the immutable audit trail. audit_logs is service-role-write only (no authenticated insert
// policy), so writes MUST use the service-role client. Mirrors recordAutonomyEvent. Append-only.

export type AuditKind =
  | 'team_role_changed'
  | 'team_member_removed'
  | 'sender_status_changed'
  | 'suppression_added'
  | 'copilot_action_confirmed'
  | 'domain_verified'
  | 'postal_address_updated'
  | 'retention_reported'
  | 'retention_purged';

export type AuditSource = 'user' | 'system' | 'webhook' | 'cron';

export interface AuditEntry {
  organizationId: string;
  kind: AuditKind;
  userId?: string | null;
  args?: Record<string, unknown> | null;
  reason?: string | null;
  source?: AuditSource;
}

/** Append one audit_logs row. Throws on a DB error — wrap in recordAuditSafe for best-effort sites. */
export async function recordAuditLog(admin: SupabaseClient, e: AuditEntry): Promise<void> {
  const { error } = await admin.from('audit_logs').insert({
    organization_id: e.organizationId,
    kind: e.kind,
    user_id: e.userId ?? null,
    args: e.args ?? {},
    reason: e.reason ?? null,
    source: e.source ?? null,
  });
  if (error) throw error;
}

/**
 * Best-effort audit write for a route handler: never fails the user action if the audit insert (or a
 * missing service-role client) errors. The mutation already succeeded; a dropped audit row is logged,
 * not fatal. `admin` may be null when the service-role key is absent (dev) → a no-op.
 */
export async function recordAuditSafe(admin: SupabaseClient | null, e: AuditEntry): Promise<void> {
  if (!admin) return;
  try {
    await recordAuditLog(admin, e);
  } catch (err) {
    console.error('audit_log write failed', { kind: e.kind, org: e.organizationId, err });
  }
}
