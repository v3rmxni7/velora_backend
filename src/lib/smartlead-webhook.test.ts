import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  eventToUpdate,
  extractReplyBody,
  extractReplyMessageId,
  extractSentMessageId,
  isHandledEvent,
  verifyPayloadSecret,
  verifySignature,
  verifyUrlToken,
} from './smartlead-webhook.js';

describe('verifyUrlToken (?token= — the Smartlead-recommended mechanism)', () => {
  it('accepts the exact token (tolerating surrounding whitespace)', () => {
    expect(verifyUrlToken('tok_123', 'tok_123')).toBe(true);
    expect(verifyUrlToken('  tok_123  ', 'tok_123')).toBe(true);
  });
  it('rejects a wrong, empty, or missing token — including length mismatches', () => {
    expect(verifyUrlToken('tok_124', 'tok_123')).toBe(false);
    expect(verifyUrlToken('tok_12', 'tok_123')).toBe(false);
    expect(verifyUrlToken('', 'tok_123')).toBe(false);
    expect(verifyUrlToken(undefined, 'tok_123')).toBe(false);
  });
});

describe('verifyPayloadSecret (body secret_key — Smartlead’s documented mechanism)', () => {
  it('accepts a matching secret_key string', () => {
    expect(verifyPayloadSecret('tok_123', 'tok_123')).toBe(true);
  });
  it('rejects wrong / empty / non-string values', () => {
    expect(verifyPayloadSecret('nope', 'tok_123')).toBe(false);
    expect(verifyPayloadSecret('', 'tok_123')).toBe(false);
    expect(verifyPayloadSecret(undefined, 'tok_123')).toBe(false);
    expect(verifyPayloadSecret(123, 'tok_123')).toBe(false);
    expect(verifyPayloadSecret({ key: 'tok_123' }, 'tok_123')).toBe(false);
  });
});

describe('payload extractors (old string shapes + current nested-object shapes)', () => {
  it('extractReplyBody: reply_body → reply_message string → reply_message.text/.html → body → ""', () => {
    expect(extractReplyBody({ reply_body: 'old' })).toBe('old');
    expect(extractReplyBody({ reply_message: 'legacy-string' })).toBe('legacy-string');
    expect(extractReplyBody({ reply_message: { text: 'plain', html: '<p>rich</p>' } })).toBe('plain');
    expect(extractReplyBody({ reply_message: { html: '<p>rich</p>' } })).toBe('<p>rich</p>');
    expect(extractReplyBody({ body: 'fallback' })).toBe('fallback');
    expect(extractReplyBody({})).toBe('');
    // The go-live hazard this guards: an OBJECT must never leak through as the reply body.
    expect(typeof extractReplyBody({ reply_message: { message_id: '<id@x>' } })).toBe('string');
  });
  it('extractReplyMessageId: nested reply_message.message_id first, then deprecated top-level', () => {
    expect(extractReplyMessageId({ reply_message: { message_id: '<r@x>' }, message_id: '<top@x>' })).toBe('<r@x>');
    expect(extractReplyMessageId({ message_id: '<top@x>' })).toBe('<top@x>');
    expect(extractReplyMessageId({})).toBeNull();
  });
  it('extractSentMessageId: top-level first (2.5 behavior), then nested sent_message.message_id', () => {
    expect(extractSentMessageId({ message_id: '<top@x>', sent_message: { message_id: '<s@x>' } })).toBe('<top@x>');
    expect(extractSentMessageId({ sent_message: { message_id: '<s@x>' } })).toBe('<s@x>');
    expect(extractSentMessageId({})).toBeNull();
  });
});

describe('verifySignature (HMAC-SHA256, constant-time)', () => {
  const secret = 'whsec_test';
  const body = '{"event_type":"EMAIL_SENT","campaign_id":42}';
  const good = `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;

  it('accepts a correct signature', () => {
    expect(verifySignature(body, good, secret)).toBe(true);
  });
  it('accepts Smartlead’s raw-hex signature (no sha256= prefix)', () => {
    const rawHex = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    expect(verifySignature(body, rawHex, secret)).toBe(true);
    expect(verifySignature(body, rawHex.toUpperCase(), secret)).toBe(true); // case-insensitive
  });
  it('rejects a wrong signature', () => {
    expect(verifySignature(body, 'sha256=deadbeef', secret)).toBe(false);
  });
  it('rejects a missing header', () => {
    expect(verifySignature(body, undefined, secret)).toBe(false);
  });
  it('rejects when the body was tampered with', () => {
    expect(verifySignature(`${body} `, good, secret)).toBe(false);
  });
  it('rejects when signed with the wrong secret', () => {
    const wrong = `sha256=${createHmac('sha256', 'other').update(body, 'utf8').digest('hex')}`;
    expect(verifySignature(body, wrong, secret)).toBe(false);
  });
});

describe('eventToUpdate (2.5 scope)', () => {
  it('EMAIL_SENT / FIRST_EMAIL_SENT → message sent + enrollment sent', () => {
    expect(eventToUpdate('EMAIL_SENT')).toEqual({ status: 'sent', enrollmentStatus: 'sent' });
    expect(eventToUpdate('FIRST_EMAIL_SENT')?.status).toBe('sent');
  });
  it('open / click → opened / clicked', () => {
    expect(eventToUpdate('EMAIL_OPEN')?.status).toBe('opened');
    expect(eventToUpdate('EMAIL_LINK_CLICK')?.status).toBe('clicked');
  });
  it('reply / bounce / unsubscribe / unknown → null (richer handling in applySmartleadEvent)', () => {
    for (const e of ['EMAIL_REPLY', 'EMAIL_BOUNCE', 'LEAD_UNSUBSCRIBED', 'WHATEVER', undefined]) {
      expect(eventToUpdate(e)).toBeNull();
    }
  });
});

describe('isHandledEvent (2.6 — recognized vs ignored)', () => {
  it('status events + inbound 2.6 events are recognized', () => {
    for (const e of [
      'EMAIL_SENT',
      'FIRST_EMAIL_SENT',
      'EMAIL_OPEN',
      'EMAIL_LINK_CLICK',
      'EMAIL_REPLY',
      'EMAIL_BOUNCE',
      'LEAD_UNSUBSCRIBED',
      'EMAIL_COMPLAINT', // 4.1b — spam complaint
    ]) {
      expect(isHandledEvent(e)).toBe(true);
    }
  });
  it('unknown / missing types are not', () => {
    expect(isHandledEvent('WHATEVER')).toBe(false);
    expect(isHandledEvent(undefined)).toBe(false);
  });
});
