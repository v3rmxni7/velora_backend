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
  // Reply payload — Smartlead uses a few field names across event shapes; read them permissively.
  reply_body?: string;
  reply_message?: string;
  body?: string;
  [k: string]: unknown;
}

/** Inbound (2.6) events that `applySmartleadEvent` handles with richer effects than a status flip. */
const INBOUND_EVENTS = new Set(['EMAIL_REPLY', 'EMAIL_BOUNCE', 'LEAD_UNSUBSCRIBED']);

/** True if we recognize the event at all (status events via eventToUpdate, or an inbound 2.6 event). */
export function isHandledEvent(eventType: string | undefined): boolean {
  return eventToUpdate(eventType) !== null || INBOUND_EVENTS.has(eventType ?? '');
}

export interface MessageUpdate {
  status: 'sent' | 'opened' | 'clicked';
  enrollmentStatus?: 'sent';
}

/**
 * Pure: map a simple Smartlead status event to the outbound message-status update we apply.
 * Returns null for the richer inbound events (reply/bounce/unsub — see applySmartleadEvent) and
 * for unknown types.
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
      return null; // EMAIL_REPLY / EMAIL_BOUNCE / LEAD_UNSUBSCRIBED → applySmartleadEvent (2.6)
  }
}
