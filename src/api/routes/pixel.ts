import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { sanitizeUrl, validateBeacon } from '../../agents/website-visitors/ingest.js';
import { getSupabaseAdmin } from '../../db/client.js';

// Phase 4 Slice 4.6 — the PUBLIC website-visitor pixel (no JWT). Two GET endpoints:
//   GET /pixel/:siteKey.js          → the tiny tracker script (short-cached)
//   GET /pixel/:siteKey/collect.gif → the beacon; records ONE raw anonymous visit, returns a 1x1 GIF.
// A GET image beacon is deliberately chosen over a fetch/sendBeacon POST: image loads are NOT subject
// to CORS/preflight, so a cross-origin hit from a customer's site works (a POST would be blocked by the
// app's CORS allowlist). Org is resolved server-side from the site_key → OUR website_tracked_domains
// row, NEVER from the request — exactly the Smartlead-webhook precedent. Threat model: the site_key is
// PUBLIC (it ships in page source); we do not pretend otherwise. The guarantee is TINY BLAST RADIUS —
// a spoofed beacon can only write an anonymous visit (no PII, no IP, no identity, no lead, no
// enrollment, no send, no credit); identity only ever comes from the dormant 🔌 resolver. Replays
// collapse via the (tracked_domain_id, event_id) unique. Unknown key → still return the GIF, write
// nothing (fail-closed + opaque). NO raw IP is ever read-into or logged with the visit.

// 1x1 transparent GIF (43 bytes).
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

// Best-effort, PER-INSTANCE rate limit (pilot only — explicitly NOT a security boundary; the real
// guarantee is the tiny blast radius + the dedup key). A durable/shared limiter is deferred hardening.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 600; // hits per site_key per minute per instance
const buckets = new Map<string, { count: number; resetAt: number }>();
function rateAllow(siteKey: string): boolean {
  const now = Date.now();
  const b = buckets.get(siteKey);
  if (!b || now >= b.resetAt) {
    buckets.set(siteKey, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (b.count >= RATE_MAX) return false;
  b.count += 1;
  return true;
}

function sendGif(reply: FastifyReply): void {
  reply
    .header('Content-Type', 'image/gif')
    .header('Cache-Control', 'no-store, no-cache, must-revalidate, private')
    .header('Pragma', 'no-cache')
    .code(200)
    .send(GIF);
}

function requestOrigin(request: FastifyRequest): string {
  const proto =
    (request.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() ??
    request.protocol ??
    'https';
  const host =
    (request.headers['x-forwarded-host'] as string | undefined) ?? request.headers.host ?? '';
  return `${proto}://${host}`;
}

export const pixelRoute: FastifyPluginAsync = async (app) => {
  // The tracker script: mints/reads a first-party anon cookie + a per-pageview event_id nonce, then
  // fires the image beacon. Served from the API so the beacon is same-origin to the script.
  app.get('/pixel/:siteKey.js', async (request, reply) => {
    const { siteKey } = request.params as { siteKey: string };
    const base = requestOrigin(request);
    const safeKey = encodeURIComponent(siteKey);
    const js = `(function(){try{
var K=${JSON.stringify(safeKey)},B=${JSON.stringify(base)};
function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,12);}
var m=document.cookie.match(/(?:^|; )velora_wv=([^;]+)/),vid=m?m[1]:uid();
if(!m){document.cookie="velora_wv="+vid+"; max-age=31536000; path=/; SameSite=Lax";}
var q="vid="+encodeURIComponent(vid)+"&e="+encodeURIComponent(uid())+"&u="+encodeURIComponent(location.href)+"&r="+encodeURIComponent(document.referrer||"");
(new Image()).src=B+"/pixel/"+K+"/collect.gif?"+q;
}catch(e){}})();`;
    reply
      .header('Content-Type', 'application/javascript; charset=utf-8')
      .header('Cache-Control', 'public, max-age=300') // short cache → a rotated/deleted key stops fast
      .code(200)
      .send(js);
  });

  // The beacon. Always returns the GIF (opaque — never leaks whether the key resolved). Records at
  // most one visit per (tracked_domain_id, event_id). Reads no IP into the row.
  app.get('/pixel/:siteKey/collect.gif', async (request, reply) => {
    const { siteKey } = request.params as { siteKey: string };
    const q = request.query as { vid?: string; e?: string; u?: string; r?: string };

    const valid = validateBeacon({ anonVisitorId: q.vid, eventId: q.e });
    if (!valid.ok) return sendGif(reply); // malformed beacon → GIF, no write
    if (!rateAllow(siteKey)) return sendGif(reply); // best-effort flood guard → GIF, no write

    const db = getSupabaseAdmin();
    if (!db) return sendGif(reply);

    // Resolve the org from OUR row via the site_key — never from the request.
    const domain = await db
      .from('website_tracked_domains')
      .select('id, organization_id')
      .eq('site_key', siteKey)
      .maybeSingle();
    if (domain.error || !domain.data) return sendGif(reply); // unknown key → GIF, no write (fail-closed)

    // Persist only minimized, non-PII signal: anon id, the dedup nonce, and query-stripped urls. No IP.
    await db.from('website_visits').upsert(
      {
        organization_id: domain.data.organization_id,
        tracked_domain_id: domain.data.id,
        anon_visitor_id: valid.anonVisitorId,
        event_id: valid.eventId,
        page_url: sanitizeUrl(q.u),
        referrer: sanitizeUrl(q.r),
        status: 'new',
        origin: 'beacon',
      },
      { onConflict: 'tracked_domain_id,event_id', ignoreDuplicates: true },
    );
    return sendGif(reply);
  });
};
