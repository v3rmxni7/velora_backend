import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Phase 4 Slice 4.7 — the OAuth CSRF state token. The public callback (no JWT) must resolve the org
// from OUR data, never the query — so the org rides a SIGNED state (HMAC over the payload). Signature +
// expiry are verified here; SINGLE-USE is enforced separately by storing the `nonce` in
// integration_secrets.oauth_state at connect-time and consuming it at callback (a replayed/used nonce
// is rejected). Mirrors the Smartlead-webhook discipline (authenticity from a server secret).

export interface OAuthStatePayload {
  organizationId: string;
  provider: string;
  nonce: string;
  exp: number; // epoch ms
}

/** Sign a fresh state. Returns the opaque `state` string (for the authorize URL) + the `nonce`/`exp`
 * to persist for single-use consumption. */
export function signState(
  organizationId: string,
  provider: string,
  secret: string,
  ttlMs = 600_000,
): { state: string; nonce: string; exp: number } {
  const nonce = randomBytes(16).toString('base64url');
  const exp = Date.now() + ttlMs;
  const payload: OAuthStatePayload = { organizationId, provider, nonce, exp };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return { state: `${body}.${sig}`, nonce, exp };
}

/** Verify signature + expiry. Returns the payload (incl. the nonce for single-use checking) or null.
 * Single-use is NOT checked here — the caller must match + consume the stored nonce. */
export function verifyState(state: string, secret: string): OAuthStatePayload | null {
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OAuthStatePayload;
  } catch {
    return null;
  }
  if (
    !payload ||
    typeof payload.organizationId !== 'string' ||
    typeof payload.nonce !== 'string' ||
    typeof payload.exp !== 'number' ||
    Date.now() > payload.exp
  ) {
    return null;
  }
  return payload;
}
