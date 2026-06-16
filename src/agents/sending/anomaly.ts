import type { SupabaseClient } from '@supabase/supabase-js';
import { recordAutonomyEvent } from '../../lib/autonomy-mode.js';

// Phase 3 Slice 3.5 — the self-protection circuit-breaker. A scheduled sweep computes each
// autonomy-on org's recent sending health and, on a DETERMINISTIC breach, flips
// autonomy_enabled=false — the broadest, instant, org-wide halt (every autonomy worker re-reads the
// flag). It only ever makes autonomy MORE conservative: the sole write is true→false. Every pause is
// audited (kind='auto_pause'). Fail-safe: a per-org compute error logs + continues (never a spurious
// pause, never aborts the sweep). The demo org (autonomy off) is excluded from the sweep entirely.

export interface HealthMetrics {
  sends: number;
  bounces: number;
  complaints: number;
}
export interface HealthThresholds {
  maxBounceRate: number;
  minSends: number;
  maxComplaints: number;
}
export interface HealthVerdict {
  breach: boolean;
  reason: string | null;
  bounceRate: number;
}

/**
 * PURE, deterministic breach test. Any complaint over the max breaches (regardless of volume). The
 * bounce rate breaches only once there are enough sends to judge it (minSends), and only when it
 * exceeds the threshold (strict `>` — at the threshold is NOT a breach).
 */
export function assessHealth(m: HealthMetrics, t: HealthThresholds): HealthVerdict {
  const bounceRate = m.sends > 0 ? m.bounces / m.sends : 0;
  if (m.complaints > t.maxComplaints) {
    return { breach: true, reason: `complaints:${m.complaints}>${t.maxComplaints}`, bounceRate };
  }
  if (m.sends >= t.minSends && bounceRate > t.maxBounceRate) {
    return {
      breach: true,
      reason: `bounce_rate:${bounceRate.toFixed(3)}>${t.maxBounceRate} (sends=${m.sends},bounces=${m.bounces})`,
      bounceRate,
    };
  }
  return { breach: false, reason: null, bounceRate };
}

/** Recent sending health for ONE org (windowed). Service-role bypasses RLS, so every query is
 * explicitly `.eq('organization_id', orgId)` — that filter IS the tenant-isolation guarantee. */
export async function computeOrgHealth(
  db: SupabaseClient,
  orgId: string,
  sinceIso: string,
): Promise<HealthMetrics> {
  const base = () =>
    db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('direction', 'outbound')
      .gte('created_at', sinceIso);
  const [sends, bounces, complaints] = await Promise.all([
    base().neq('status', 'dry_run'), // real sends (the governor's own definition)
    base().eq('status', 'bounced'),
    base().eq('status', 'complained'),
  ]);
  if (sends.error) throw sends.error;
  if (bounces.error) throw bounces.error;
  if (complaints.error) throw complaints.error;
  return {
    sends: sends.count ?? 0,
    bounces: bounces.count ?? 0,
    complaints: complaints.count ?? 0,
  };
}

export interface SweepResult {
  swept: number;
  paused: number;
  errors: number;
}

/**
 * Sweep every autonomy-ON org; auto-pause (autonomy_enabled=true→false) any that breach. Per-org
 * isolated: a compute error logs + continues (no spurious pause, no aborted sweep). The CAS flip is
 * idempotent and, once flipped, the org drops out of the next sweep → exactly one pause + audit.
 */
export async function runAnomalySweep(
  db: SupabaseClient,
  thresholds: HealthThresholds,
  windowHours: number,
): Promise<SweepResult> {
  const sinceIso = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  const orgs = await db.from('organizations').select('id').eq('autonomy_enabled', true);
  if (orgs.error) throw orgs.error;

  let paused = 0;
  let errors = 0;
  const rows = orgs.data ?? [];
  for (const row of rows) {
    const orgId = row.id as string;
    try {
      const metrics = await computeOrgHealth(db, orgId, sinceIso);
      const verdict = assessHealth(metrics, thresholds);
      if (!verdict.breach) continue;
      // CAS: only flip an org that is still enabled (idempotent against a concurrent human change).
      const flip = await db
        .from('organizations')
        .update({ autonomy_enabled: false })
        .eq('id', orgId)
        .eq('autonomy_enabled', true)
        .select('id');
      if (flip.error) throw flip.error;
      if ((flip.data ?? []).length === 0) continue; // already off — nothing to audit
      await recordAutonomyEvent(db, {
        organizationId: orgId,
        kind: 'auto_pause',
        decision: 'auto_pause',
        reason: verdict.reason ?? 'breach',
        confidence: verdict.bounceRate,
      });
      paused += 1;
    } catch (err) {
      // Fail-safe: never auto-pause on a compute error (a transient blip must not disable a
      // customer's autonomy); log loudly + continue so one org can't abort the sweep.
      errors += 1;
      console.error('[anomaly-monitor] org health check failed', { orgId, err });
    }
  }
  return { swept: rows.length, paused, errors };
}
