import type { SupabaseClient } from '@supabase/supabase-js';

// The org-wide autonomy switches (organizations.autonomy_enabled / auto_send_min_confidence /
// auto_reply_mode). Phase 3 Slice 3.0: the SAFE FOUNDATION only — flags + a fail-closed reader +
// the pure send-side decision core. NOTHING is wired into the live flow yet (3.1+). Mirrors
// src/lib/sending-mode.ts: the master switch defaults OFF and uncertainty always resolves to OFF.
export interface AutonomyMode {
  /** Master kill switch. Default false — autonomy is structurally impossible until flipped. */
  autonomyEnabled: boolean;
  /** Auto-send confidence floor (default 0.80). Drafts below it escalate to a human. */
  minConfidence: number;
  /** Reply relaxation: 'off' = today's human-in-the-loop; 'draft'/'send' = opt-in (3.1+). */
  autoReply: 'off' | 'draft' | 'send';
}

/** The fully-off mode — the safe default returned whenever the org's flags can't be trusted. */
const OFF: AutonomyMode = { autonomyEnabled: false, minConfidence: 0.8, autoReply: 'off' };

/**
 * Read the caller-org's autonomy flags. FAIL-CLOSED: a missing row OR a read error resolves to the
 * fully-off mode (never throws), so no failure mode is ever interpretable as "autonomy on". This is
 * a deliberate divergence from getSendingMode (which throws on a DB error) — in this highest-harm
 * domain all-off is the strictly-safe state, so a degraded read must collapse to it. Defensive
 * parsing mirrors getSendingMode's `=== true` / clamp style: anything unexpected → the safe value.
 */
export async function getAutonomyMode(
  db: SupabaseClient,
  organizationId: string,
): Promise<AutonomyMode> {
  const { data, error } = await db
    .from('organizations')
    .select('autonomy_enabled, auto_send_min_confidence, auto_reply_mode')
    .eq('id', organizationId)
    .maybeSingle();
  if (error || !data) return { ...OFF };
  const conf = data.auto_send_min_confidence;
  return {
    autonomyEnabled: data.autonomy_enabled === true, // anything but an explicit true → off
    minConfidence: typeof conf === 'number' && conf >= 0 && conf <= 1 ? conf : 0.8, // clamp/default-safe
    autoReply:
      data.auto_reply_mode === 'draft' || data.auto_reply_mode === 'send'
        ? data.auto_reply_mode
        : 'off', // anything but draft/send → off
  };
}

// ---- decideAutoApproval (pure) — the send-side autonomy decision ----

/**
 * The minimal draft shape the decision needs. A structural subset of DraftPayload
 * (src/agents/draft/generate.ts) — a real DraftPayload (or a mapped tasks row) is assignable, so
 * this lib stays decoupled from src/agents.
 */
export interface AutoApprovalDraft {
  draftMode: 'personalized' | 'template';
  confidence: number;
  grounding: { verification: { ok: boolean } };
}

export interface AutoApprovalDecision {
  action: 'auto_send' | 'escalate';
  reason: string;
}

/**
 * Decide whether a generated draft may be auto-sent. auto_send IFF autonomy is on AND the draft is
 * personalized AND it passed verification AND its confidence clears the org's floor. EVERYTHING else
 * escalates to a human. A template ALWAYS escalates — it is the pipeline's "I don't know this lead"
 * signal (templates carry verification.ok:true in generate.ts, so draftMode is the discriminator,
 * not verification). The master autonomyEnabled check is the kill switch / two-flag-invariant analog.
 * PURE: nothing here sends or writes; wiring into the live send path is 3.1.
 */
export function decideAutoApproval(
  draft: AutoApprovalDraft,
  mode: AutonomyMode,
): AutoApprovalDecision {
  if (!mode.autonomyEnabled) return { action: 'escalate', reason: 'autonomy_disabled' };
  if (draft.draftMode !== 'personalized') return { action: 'escalate', reason: 'not_personalized' };
  if (!draft.grounding.verification.ok) return { action: 'escalate', reason: 'unverified' };
  if (draft.confidence < mode.minConfidence)
    return { action: 'escalate', reason: 'below_confidence_threshold' };
  return { action: 'auto_send', reason: 'personalized_verified_high_confidence' };
}

// ---- autonomy_events audit (Slice 3.1) — append-only record of every autonomous decision ----

/** One audit row. `decision` spans cold-send (auto_send|escalate) and reply (suppress|engage|escalate|snooze). */
export interface AutonomyEvent {
  organizationId: string;
  kind: 'cold_send' | 'reply';
  enrollmentId?: string | null;
  taskId?: string | null;
  decision: 'auto_send' | 'escalate' | 'suppress' | 'engage' | 'snooze';
  reason: string;
  confidence?: number | null;
}

/**
 * Append one autonomy_events row. Throws on a DB error — callers decide whether the audit is a
 * precondition (cold send: no autonomous send without an audit) or best-effort (reply shadow).
 */
export async function recordAutonomyEvent(db: SupabaseClient, e: AutonomyEvent): Promise<void> {
  const { error } = await db.from('autonomy_events').insert({
    organization_id: e.organizationId,
    kind: e.kind,
    enrollment_id: e.enrollmentId ?? null,
    task_id: e.taskId ?? null,
    decision: e.decision,
    reason: e.reason,
    confidence: e.confidence ?? null,
  });
  if (error) throw error;
}
