import { describe, expect, it } from 'vitest';
import type { AutonomyMode } from '../../lib/autonomy-mode.js';
import { decideReplyAction, isExplicitStop } from './auto-reply.js';
import { REPLY_CATEGORIES } from './classify.js';

const mode = (over: Partial<AutonomyMode> = {}): AutonomyMode => ({
  autonomyEnabled: true,
  minConfidence: 0.8,
  autoReply: 'off',
  ...over,
});
const OFF = mode({ autonomyEnabled: false, autoReply: 'off' });
const RELAXED = mode({ autonomyEnabled: true, autoReply: 'draft' });

describe('isExplicitStop (deterministic backstop — does not trust the LLM)', () => {
  it('matches the stop phrases', () => {
    for (const b of [
      'please unsubscribe me',
      'opt out',
      'opt-out now',
      'please remove me from your list',
      'stop emailing me',
      'take me off this',
    ]) {
      expect(isExplicitStop(b)).toBe(true);
    }
  });
  it('does not match an ordinary positive reply, or empty', () => {
    expect(isExplicitStop("sounds great, let's talk next week")).toBe(false);
    expect(isExplicitStop('')).toBe(false);
  });
});

describe('decideReplyAction', () => {
  it('THE FAIL-SAFE: an explicit stop in the body OVERRIDES a wrong "interested" classification, even when reply autonomy is fully relaxed', () => {
    // Classifier got it wrong (returned 'interested') AND mode is the most permissive ('send').
    // The deterministic backstop must still force suppress — never re-contact someone who said stop.
    const decision = decideReplyAction(
      'interested',
      'actually, please remove me from your list',
      mode({ autonomyEnabled: true, autoReply: 'send' }),
    );
    expect(decision).toBe('suppress');
  });

  it('an unsubscribe classification suppresses regardless of mode', () => {
    expect(decideReplyAction('unsubscribe', 'no thanks', RELAXED)).toBe('suppress');
    expect(decideReplyAction('unsubscribe', 'no thanks', OFF)).toBe('suppress');
  });

  it('mode OFF preserves Phase-2 blanket-suppress exactly — every category → suppress', () => {
    for (const category of REPLY_CATEGORIES) {
      expect(decideReplyAction(category, 'a perfectly normal reply', OFF)).toBe('suppress');
      // and via the master kill switch (autonomy disabled, autoReply left at a relaxed value)
      expect(
        decideReplyAction(
          category,
          'a perfectly normal reply',
          mode({ autonomyEnabled: false, autoReply: 'send' }),
        ),
      ).toBe('suppress');
    }
  });

  it('KILL SWITCH: autonomy disabled collapses a relaxed autoReply back to off (suppress)', () => {
    expect(
      decideReplyAction(
        'interested',
        'tell me more',
        mode({ autonomyEnabled: false, autoReply: 'send' }),
      ),
    ).toBe('suppress');
  });

  describe('reply autonomy relaxed (draft/send) — routing by category', () => {
    it('interested / objection → engage', () => {
      expect(decideReplyAction('interested', 'tell me more', RELAXED)).toBe('engage');
      expect(decideReplyAction('objection', 'we already use a competitor', RELAXED)).toBe('engage');
    });
    it('out_of_office → snooze', () => {
      expect(decideReplyAction('out_of_office', 'on vacation until Monday', RELAXED)).toBe(
        'snooze',
      );
    });
    it('not_interested → suppress', () => {
      expect(decideReplyAction('not_interested', 'not for us', RELAXED)).toBe('suppress');
    });
    it('other / ambiguous → escalate to a human', () => {
      expect(decideReplyAction('other', 'who is this?', RELAXED)).toBe('escalate');
    });
  });
});
