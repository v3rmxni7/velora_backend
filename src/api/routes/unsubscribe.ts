import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { env } from '../../config/env.js';
import { getSupabaseAdmin } from '../../db/client.js';
import { recordAuditSafe } from '../../lib/audit.js';
import { verifyUnsubscribe } from '../../lib/unsubscribe.js';

// L1 — the PUBLIC Velora-hosted unsubscribe endpoint (no JWT), the PRIMARY opt-out mechanism embedded
// in every live send's footer. Two routes on the signed per-recipient token:
//   GET  /u/:token → render a confirmation PAGE. NEVER mutates (email link-scanners / anti-virus
//                    prefetch GETs; a bare GET that suppressed would auto-unsubscribe everyone).
//   POST /u/:token → verify the HMAC token, resolve org+email from OUR signature (never the request),
//                    write the suppression_list row that both send chokepoints already gate on, and
//                    render a done page. Synchronous — no dependency on Smartlead's tag or webhook.
// The org is resolved from the signed token, exactly like the pixel/OAuth-callback precedent. Writing
// suppression from a public route requires the service-role client (RLS blocks an anonymous client).
// The secret is injectable (plugin options) so tests exercise it without the frozen env; prod uses env.

interface UnsubscribeOptions {
  secret?: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function page(reply: FastifyReply, status: number, title: string, bodyHtml: string): void {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark}
body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;
display:flex;min-height:100vh;align-items:center;justify-content:center;background:#f8fafc;color:#0f172a}
@media(prefers-color-scheme:dark){body{background:#0b1220;color:#e2e8f0}}
.card{max-width:30rem;margin:1.5rem;padding:2rem;border-radius:12px;background:#fff;
box-shadow:0 1px 3px rgba(16,24,40,.08);text-align:center}
@media(prefers-color-scheme:dark){.card{background:#111a2e}}
h1{font-size:1.25rem;margin:0 0 .75rem}
p{color:#475569;line-height:1.5;margin:.5rem 0}
@media(prefers-color-scheme:dark){p{color:#94a3b8}}
.email{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9rem}
button{margin-top:1.25rem;padding:.7rem 1.4rem;font-size:1rem;border:0;border-radius:8px;
background:#4f46e5;color:#fff;cursor:pointer}
button:hover{background:#4338ca}
</style></head><body><div class="card">${bodyHtml}</div></body></html>`;
  reply
    .header('Content-Type', 'text/html; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .code(status)
    .send(html);
}

export const unsubscribeRoute: FastifyPluginAsync<UnsubscribeOptions> = async (app, opts) => {
  const secret = opts.secret ?? env.UNSUBSCRIBE_SECRET;
  // The token rides in the QUERY string (/u?t=<token>), NOT a path segment. An opaque signed token in
  // a path param trips find-my-way's parametric matcher (long base64url values fail to match /u/:token);
  // a query value has no such parsing constraint and is the standard place for an unsubscribe token.
  const tokenOf = (request: { query: unknown }): string =>
    (request.query as { t?: string }).t ?? '';

  // GET — confirmation page ONLY. No state change (scanner-safe). Invalid/unconfigured → friendly 400.
  app.get('/u', async (request, reply) => {
    const token = tokenOf(request);
    const payload = secret ? verifyUnsubscribe(token, secret) : null;
    if (!payload) {
      return page(
        reply,
        400,
        'Unsubscribe link invalid',
        `<h1>This unsubscribe link isn't valid</h1><p>It may be malformed. If you keep receiving emails you don't want, reply with "unsubscribe" and we'll remove you.</p>`,
      );
    }
    return page(
      reply,
      200,
      'Confirm unsubscribe',
      `<h1>Unsubscribe from these emails?</h1>
<p>Click below and we'll stop emailing <span class="email">${escapeHtml(payload.email)}</span>.</p>
<form method="post" action="/u?t=${escapeHtml(encodeURIComponent(token))}"><button type="submit">Confirm unsubscribe</button></form>`,
    );
  });

  // POST — the ONLY mutating path. Verify → suppress (service-role) → done page. Idempotent.
  app.post('/u', async (request, reply) => {
    const token = tokenOf(request);
    const payload = secret ? verifyUnsubscribe(token, secret) : null;
    if (!payload) {
      return page(
        reply,
        400,
        'Unsubscribe link invalid',
        `<h1>This unsubscribe link isn't valid</h1><p>We couldn't process this request.</p>`,
      );
    }

    const db = getSupabaseAdmin();
    if (!db) {
      return page(
        reply,
        503,
        'Try again',
        `<h1>Something went wrong</h1><p>Please try again in a moment.</p>`,
      );
    }

    // Idempotent upsert on (organization_id, email) — a re-submit or scanner replay is a no-op. Writes
    // the exact suppression the send chokepoints check (reason 'unsubscribe'), so the loop closes.
    const { data, error } = await db
      .from('suppression_list')
      .upsert(
        {
          organization_id: payload.organizationId,
          email: payload.email,
          reason: 'unsubscribe',
          source: 'unsubscribe_link',
        },
        { onConflict: 'organization_id,email', ignoreDuplicates: true },
      )
      .select('id');
    if (error) {
      return page(
        reply,
        503,
        'Try again',
        `<h1>Something went wrong</h1><p>Please try again in a moment.</p>`,
      );
    }
    // Audit only a genuinely NEW suppression (best-effort; a dropped audit never breaks the opt-out).
    if ((data ?? []).length > 0) {
      await recordAuditSafe(db, {
        organizationId: payload.organizationId,
        kind: 'suppression_added',
        args: { reason: 'unsubscribe', via: 'unsubscribe_link' },
        reason: 'unsubscribe',
        source: 'system', // a public self-serve opt-out (not an authed user / webhook / cron)
      });
    }

    return page(
      reply,
      200,
      'Unsubscribed',
      `<h1>You've been unsubscribed</h1><p>We won't email <span class="email">${escapeHtml(payload.email)}</span> anymore. It can take a moment to take effect everywhere.</p>`,
    );
  });
};
