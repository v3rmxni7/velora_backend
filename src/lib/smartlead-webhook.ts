import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// Smartlead webhook verification + event mapping (Phase 2 Slice 2.5; verification GROUND-TRUTHED at
// go-live). Deep-researched reality (official docs + community receivers + Smartlead support, 2026-07):
// Smartlead does NOT sign webhook deliveries — no signing secret is provisioned anywhere in their UI
// or API, and the `X-Smartlead-Signature` header exists only in their (self-contradictory) docs site.
// The verifiable mechanisms that actually exist are:
//   1. a receiver-chosen TOKEN in the webhook URL query string (Smartlead support's recommendation) —
//      `.../webhooks/smartlead?token=<SMARTLEAD_WEBHOOK_SECRET>`;
//   2. a `secret_key` field Smartlead echoes INSIDE the payload body (their canonical guide:
//      "the secret to identify the webhook is from smartlead") — checked when present;
//   3. the HMAC header — kept as a legacy/bonus path in case it ever really ships.
// The route accepts ANY one proof; all comparisons are timing-safe; no secret configured → fail closed.

/** Timing-safe string equality that never leaks length (compares SHA-256 digests). */
function safeEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}

/** Proof 1 — the URL query token (`?token=…`), the Smartlead-recommended mechanism. */
export function verifyUrlToken(token: string | undefined, secret: string): boolean {
  if (!token) return false;
  return safeEqual(token.trim(), secret);
}

/** Proof 2 — the `secret_key` field Smartlead echoes in the payload body (when configured). */
export function verifyPayloadSecret(secretKey: unknown, secret: string): boolean {
  if (typeof secretKey !== 'string' || secretKey.length === 0) return false;
  return safeEqual(secretKey.trim(), secret);
}

/** Proof 3 (legacy) — HMAC header, if a signed delivery ever actually arrives. */
export function verifySignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header) return false;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  // Tolerate an optional "sha256=" prefix and casing — this normalizes the ENVELOPE only;
  // the HMAC itself must still match exactly, timing-safe.
  const provided = header
    .trim()
    .replace(/^sha256=/i, '')
    .toLowerCase();
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false; // timingSafeEqual requires equal lengths
  return timingSafeEqual(a, b);
}

/** Nested message object in Smartlead's current payload schema ({message_id, html, text, time}). */
export interface SmartleadMessageRef {
  message_id?: string;
  html?: string;
  text?: string;
  time?: string;
  [k: string]: unknown;
}

export interface SmartleadEvent {
  event_type?: string;
  campaign_id?: number | string;
  to_email?: string;
  lead_email?: string; // deprecated by Smartlead in favor of to_email; still read as fallback
  message_id?: string; // deprecated in favor of reply_message.message_id / sent_message.message_id
  // Reply payload — Smartlead's schema evolved: reply_body (deprecated string) →
  // reply_message {message_id, html, text, time} (current object). Read both permissively.
  reply_body?: string;
  reply_message?: string | SmartleadMessageRef;
  sent_message?: SmartleadMessageRef;
  bounce_message?: SmartleadMessageRef;
  body?: string;
  /** Echoed by Smartlead in every payload — "the secret to identify the webhook is from smartlead". */
  secret_key?: string;
  [k: string]: unknown;
}

/** The reply text, across Smartlead's old (string) and current (object) payload shapes. */
export function extractReplyBody(event: SmartleadEvent): string {
  if (typeof event.reply_body === 'string' && event.reply_body) return event.reply_body;
  const rm = event.reply_message;
  if (typeof rm === 'string') return rm;
  if (rm && typeof rm === 'object') {
    if (typeof rm.text === 'string' && rm.text) return rm.text;
    if (typeof rm.html === 'string' && rm.html) return rm.html;
  }
  return typeof event.body === 'string' ? event.body : '';
}

/** The inbound (reply) message id: current nested field first, then the deprecated top-level. */
export function extractReplyMessageId(event: SmartleadEvent): string | null {
  const rm = event.reply_message;
  if (rm && typeof rm === 'object' && rm.message_id) return String(rm.message_id);
  return event.message_id ? String(event.message_id) : null;
}

/** The outbound (sent) message id: deprecated top-level first (2.5 behavior), then the nested field. */
export function extractSentMessageId(event: SmartleadEvent): string | null {
  if (event.message_id) return String(event.message_id);
  const sm = event.sent_message;
  if (sm && typeof sm === 'object' && sm.message_id) return String(sm.message_id);
  return null;
}

/**
 * Spam-complaint events (Slice 4.1b). The exact Smartlead event name is confirmed at go-live (same
 * verified-at-go-live note as sendReply); we recognize the likely variants. Centralized here so a
 * go-live confirmation is a one-line change. A complaint → message 'complained' + suppression,
 * which is what arms the 3.5 anomaly circuit-breaker.
 */
export const COMPLAINT_EVENTS = new Set(['EMAIL_COMPLAINT', 'SPAM_COMPLAINT', 'SPAM_REPORT']);

/** Inbound (2.6+) events that `applySmartleadEvent` handles with richer effects than a status flip. */
const INBOUND_EVENTS = new Set([
  'EMAIL_REPLY',
  'EMAIL_BOUNCE',
  'LEAD_UNSUBSCRIBED',
  ...COMPLAINT_EVENTS,
]);

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
