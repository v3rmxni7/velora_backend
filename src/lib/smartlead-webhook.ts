import { createHmac, timingSafeEqual } from 'node:crypto';

// Smartlead webhook verification + event mapping (Phase 2 Slice 2.5).
// Signature: header `X-Smartlead-Signature: sha256=<hex HMAC-SHA256(secret, rawBody)>`.

export function verifySignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false; // timingSafeEqual requires equal lengths
  return timingSafeEqual(a, b);
}

export interface SmartleadEvent {
  event_type?: string;
  campaign_id?: number | string;
  to_email?: string;
  lead_email?: string;
  message_id?: string;
  [k: string]: unknown;
}

export interface MessageUpdate {
  status: 'sent' | 'opened' | 'clicked';
  enrollmentStatus?: 'sent';
}

/**
 * Pure: map a Smartlead event to the message-status update we apply (2.5 scope).
 * Returns null for events 2.5 doesn't handle (replies/bounces/unsubs → 2.6) or unknown types.
 */
export function eventToUpdate(eventType: string | undefined): MessageUpdate | null {
  switch (eventType) {
    case 'EMAIL_SENT':
    case 'FIRST_EMAIL_SENT':
      return { status: 'sent', enrollmentStatus: 'sent' };
    case 'EMAIL_OPEN':
      return { status: 'opened' };
    case 'EMAIL_LINK_CLICK':
      return { status: 'clicked' };
    default:
      return null; // EMAIL_REPLY / EMAIL_BOUNCE / LEAD_UNSUBSCRIBED handled in 2.6
  }
}
