import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eventToUpdate, verifySignature } from './smartlead-webhook.js';

describe('verifySignature (HMAC-SHA256, constant-time)', () => {
  const secret = 'whsec_test';
  const body = '{"event_type":"EMAIL_SENT","campaign_id":42}';
  const good = `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;

  it('accepts a correct signature', () => {
    expect(verifySignature(body, good, secret)).toBe(true);
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
  it('reply / bounce / unsubscribe / unknown → null (handled in 2.6)', () => {
    for (const e of ['EMAIL_REPLY', 'EMAIL_BOUNCE', 'LEAD_UNSUBSCRIBED', 'WHATEVER', undefined]) {
      expect(eventToUpdate(e)).toBeNull();
    }
  });
});
