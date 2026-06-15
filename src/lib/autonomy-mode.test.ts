import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import {
  type AutoApprovalDraft,
  type AutonomyMode,
  decideAutoApproval,
  getAutonomyMode,
} from './autonomy-mode.js';

// Minimal Supabase stub: supports the exact chain getAutonomyMode uses
// (.from().select().eq().maybeSingle()) and returns a canned { data, error }.
function stubDb(result: { data: unknown; error: unknown }): SupabaseClient {
  const chain = {
    select() {
      return chain;
    },
    eq() {
      return chain;
    },
    maybeSingle() {
      return Promise.resolve(result);
    },
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

const OFF: AutonomyMode = { autonomyEnabled: false, minConfidence: 0.8, autoReply: 'off' };

describe('getAutonomyMode (FAIL-CLOSED — uncertainty resolves to fully off)', () => {
  it('missing org row → fully off', async () => {
    expect(await getAutonomyMode(stubDb({ data: null, error: null }), 'org')).toEqual(OFF);
  });
  it('read error → fully off (never throws, never interprets a failure as "autonomy on")', async () => {
    expect(
      await getAutonomyMode(stubDb({ data: null, error: { message: 'boom' } }), 'org'),
    ).toEqual(OFF);
  });
  it('a fully-populated row is parsed through', async () => {
    const db = stubDb({
      data: { autonomy_enabled: true, auto_send_min_confidence: 0.9, auto_reply_mode: 'draft' },
      error: null,
    });
    expect(await getAutonomyMode(db, 'org')).toEqual({
      autonomyEnabled: true,
      minConfidence: 0.9,
      autoReply: 'draft',
    });
  });
  it('autonomy_enabled is true-strict (anything but an explicit true → off)', async () => {
    const db = stubDb({
      data: { autonomy_enabled: 'yes', auto_send_min_confidence: 0.9, auto_reply_mode: 'send' },
      error: null,
    });
    expect((await getAutonomyMode(db, 'org')).autonomyEnabled).toBe(false);
  });
  it('junk auto_reply_mode → off', async () => {
    const db = stubDb({
      data: { autonomy_enabled: true, auto_send_min_confidence: 0.5, auto_reply_mode: 'wat' },
      error: null,
    });
    expect((await getAutonomyMode(db, 'org')).autoReply).toBe('off');
  });
  it('out-of-range / non-number confidence → safe default 0.8', async () => {
    const high = stubDb({
      data: { autonomy_enabled: true, auto_send_min_confidence: 5, auto_reply_mode: 'send' },
      error: null,
    });
    const nan = stubDb({
      data: { autonomy_enabled: true, auto_send_min_confidence: 'x', auto_reply_mode: 'send' },
      error: null,
    });
    expect((await getAutonomyMode(high, 'org')).minConfidence).toBe(0.8);
    expect((await getAutonomyMode(nan, 'org')).minConfidence).toBe(0.8);
  });
});

describe('decideAutoApproval (auto_send must be EARNED; everything else escalates)', () => {
  const mode = (over: Partial<AutonomyMode> = {}): AutonomyMode => ({
    autonomyEnabled: true,
    minConfidence: 0.8,
    autoReply: 'off',
    ...over,
  });
  const draft = (over: Partial<AutoApprovalDraft> = {}): AutoApprovalDraft => ({
    draftMode: 'personalized',
    confidence: 0.85,
    grounding: { verification: { ok: true } },
    ...over,
  });

  it('personalized + verified + above the floor → auto_send', () => {
    expect(decideAutoApproval(draft(), mode())).toEqual({
      action: 'auto_send',
      reason: 'personalized_verified_high_confidence',
    });
  });
  it('confidence exactly at the floor (>=) → auto_send', () => {
    expect(decideAutoApproval(draft({ confidence: 0.8 }), mode()).action).toBe('auto_send');
  });
  it('TEMPLATE always escalates — even at very high confidence (the "I don\'t know this lead" signal)', () => {
    expect(decideAutoApproval(draft({ draftMode: 'template', confidence: 0.99 }), mode())).toEqual({
      action: 'escalate',
      reason: 'not_personalized',
    });
  });
  it('below the confidence floor → escalate', () => {
    expect(decideAutoApproval(draft({ confidence: 0.79 }), mode())).toEqual({
      action: 'escalate',
      reason: 'below_confidence_threshold',
    });
  });
  it('unverified → escalate (even personalized + high confidence)', () => {
    const d = draft({ confidence: 0.99, grounding: { verification: { ok: false } } });
    expect(decideAutoApproval(d, mode())).toEqual({ action: 'escalate', reason: 'unverified' });
  });
  it('KILL SWITCH: autonomy disabled → escalate regardless of the draft', () => {
    const d = draft({ confidence: 0.99 });
    expect(decideAutoApproval(d, mode({ autonomyEnabled: false }))).toEqual({
      action: 'escalate',
      reason: 'autonomy_disabled',
    });
  });
});
