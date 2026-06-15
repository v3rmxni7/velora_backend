import type { AutonomyMode } from '../../lib/autonomy-mode.js';
import type { ReplyCategory } from './classify.js';

// Reply-side autonomy decision (Phase 3 Slice 3.0). PURE + deterministic. NOTHING is wired into
// applySmartleadEvent (inbound.ts) yet — that is 3.1. Lives beside the classifier so src/lib never
// has to import from src/agents (the AutonomyMode type flows the other way: agents → lib).

/**
 * The outcome of a reply, consumed by the inbound handler in 3.1 (not now):
 *  - suppress: add to the suppression list / stop contacting (a stop signal, or the safe default)
 *  - engage:   eligible for an autonomous reply (draft-first per mode.autoReply) — opt-in only
 *  - escalate: route to a human (the inbox needs_action lane)
 *  - snooze:   transient defer (out-of-office) — no suppression, no human action needed
 */
export type ReplyAction = 'suppress' | 'engage' | 'escalate' | 'snooze';

// Deterministic stop phrases. This is the BACKSTOP that does not trust the LLM classifier: if the
// recipient literally asked to be left alone, we suppress no matter what the model returned.
const STOP_RE = /unsubscribe|opt[- ]?out|remove me|stop emailing|take me off/i;

/** True if the reply body literally asks to stop being contacted. Independent of the classifier. */
export function isExplicitStop(body: string): boolean {
  return STOP_RE.test(body ?? '');
}

/**
 * Decide what to do with an inbound reply. Precedence (top wins):
 *  1. isExplicitStop — OVERRIDES the LLM classifier AND the mode. The fail-safe that prevents
 *     re-contacting someone who said stop even if the classifier mislabeled them 'interested'.
 *  2. an 'unsubscribe' classification — a hard stop regardless of mode.
 *  3. autonomy off (kill switch or the default auto_reply='off') — collapse to today's blanket
 *     suppress (Phase-2 H1 suppresses every reply; the inbox needs_action escalation stays an
 *     unconditional handler step in 3.1, so net off-mode behavior is unchanged).
 *  4. reply autonomy relaxed (draft/send) — route by category; downstream stays gated/draft-first.
 * PURE: nothing here suppresses, replies, or writes.
 */
export function decideReplyAction(
  category: ReplyCategory,
  body: string,
  mode: AutonomyMode,
): ReplyAction {
  if (isExplicitStop(body)) return 'suppress';
  if (category === 'unsubscribe') return 'suppress';
  if (!mode.autonomyEnabled || mode.autoReply === 'off') return 'suppress';
  switch (category) {
    case 'interested':
    case 'objection':
      return 'engage';
    case 'out_of_office':
      return 'snooze';
    case 'not_interested':
      return 'suppress';
    default:
      return 'escalate'; // 'other' / ambiguous → a human decides
  }
}
