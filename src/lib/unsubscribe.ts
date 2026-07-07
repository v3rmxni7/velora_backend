import { createHmac, timingSafeEqual } from 'node:crypto';

// L1 compliance — the Velora-HOSTED unsubscribe token (primary opt-out mechanism). Every live send
// embeds a signed per-recipient link (PUBLIC_BASE_URL/u/:token); the public /u route verifies the
// signature and, on a POST confirmation, writes the suppression_list row that the send chokepoints
// already gate on. Self-contained and testable end-to-end — no dependency on Smartlead's unverified
// %unsubscribe-text% tag or the best-effort LEAD_UNSUBSCRIBED webhook (those stay as a secondary net).
//
// The token binds { organizationId, email } and is signed (HMAC-SHA256) with UNSUBSCRIBE_SECRET.
// DELIBERATELY no expiry and no single-use nonce: an unsubscribe must keep working indefinitely (a
// recipient may opt out months after the email), and the only action it can ever trigger is suppressing
// that email for that org — an idempotent, safe operation — so replay carries no risk. The email is
// lower-cased before signing so the token is stable regardless of header casing.

export interface UnsubscribePayload {
  organizationId: string;
  email: string;
}

// body~sig. The separator is '~' (an RFC-3986 UNRESERVED char, safe unencoded in a path segment) and
// NOT '.': the token rides in the URL PATH (/u/:token), and Fastify's find-my-way treats a '.' in a
// parametric segment as an extension delimiter, so a dotted token would 404 the route. '~' is also
// absent from the base64url alphabet (A–Z a–z 0–9 - _), so it unambiguously splits body from sig.
const SEP = '~';

/** Sign an opaque unsubscribe token binding org + email. */
export function signUnsubscribe(organizationId: string, email: string, secret: string): string {
  const payload: UnsubscribePayload = { organizationId, email: email.toLowerCase() };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}${SEP}${sig}`;
}

/** Verify signature + shape. Returns the payload or null (tampered / malformed / wrong secret). */
export function verifyUnsubscribe(token: string, secret: string): UnsubscribePayload | null {
  const parts = token.split(SEP);
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: UnsubscribePayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as UnsubscribePayload;
  } catch {
    return null;
  }
  if (
    !payload ||
    typeof payload.organizationId !== 'string' ||
    typeof payload.email !== 'string' ||
    !payload.organizationId ||
    !payload.email
  ) {
    return null;
  }
  return payload;
}

/** Build the absolute unsubscribe URL embedded in the compliance footer. The token rides in the query
 *  string (?t=…), not a path segment — an opaque token in a path param trips the router's matcher. */
export function buildUnsubscribeUrl(
  baseUrl: string,
  organizationId: string,
  email: string,
  secret: string,
): string {
  const token = signUnsubscribe(organizationId, email, secret);
  return `${baseUrl.replace(/\/+$/, '')}/u?t=${encodeURIComponent(token)}`;
}
