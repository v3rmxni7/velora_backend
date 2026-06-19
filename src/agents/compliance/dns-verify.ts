import { resolveTxt as nodeResolveTxt } from 'node:dns/promises';
import type { SupabaseClient } from '@supabase/supabase-js';

// 4.12 — REAL SPF/DKIM/DMARC verification via Node DNS TXT lookups (no vendor key). Honest by
// construction: 'pass' = a matching record was found; 'fail' = the lookup succeeded but no matching
// record exists (incl. NXDOMAIN/ENODATA — genuinely missing); 'unknown' = the lookup ITSELF errored
// (timeout/SERVFAIL/network) so we can't conclude — we never flip to 'fail' on uncertainty, and never
// fabricate a 'pass'. DKIM needs a selector we don't generically know → 'unknown' unless one is given.

export type AuthStatus = 'unknown' | 'pass' | 'fail';
export type TxtResolver = (hostname: string) => Promise<string[][]>;

export interface DomainAuthResult {
  spf: AuthStatus;
  dkim: AuthStatus;
  dmarc: AuthStatus;
}

// A TXT record is returned as an array of string chunks (long records are split); join before matching.
function joinTxt(record: string[]): string {
  return record.join('');
}

async function checkTxt(
  hostname: string,
  resolve: TxtResolver,
  matches: (txt: string) => boolean,
): Promise<AuthStatus> {
  try {
    const records = await resolve(hostname);
    return (records ?? []).some((r) => matches(joinTxt(r))) ? 'pass' : 'fail';
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    // The name/record genuinely doesn't exist → a real failure. Anything else (timeout/SERVFAIL) is
    // inconclusive → 'unknown' (don't punish a flaky lookup as a misconfiguration).
    if (code === 'ENOTFOUND' || code === 'ENODATA') return 'fail';
    return 'unknown';
  }
}

export async function verifyDomainAuth(
  domain: string,
  opts: { resolve?: TxtResolver; dkimSelector?: string | null } = {},
): Promise<DomainAuthResult> {
  const resolve = opts.resolve ?? nodeResolveTxt;
  const selector = opts.dkimSelector?.trim() || null;

  const [spf, dmarc, dkim] = await Promise.all([
    checkTxt(domain, resolve, (t) => t.toLowerCase().includes('v=spf1')),
    checkTxt(`_dmarc.${domain}`, resolve, (t) => t.toLowerCase().includes('v=dmarc1')),
    selector
      ? checkTxt(`${selector}._domainkey.${domain}`, resolve, (t) => {
          const l = t.toLowerCase();
          return l.includes('v=dkim1') || l.includes('p=');
        })
      : Promise.resolve<AuthStatus>('unknown'), // honest: can't check DKIM without a selector
  ]);

  return { spf, dkim, dmarc };
}

/**
 * Verify a domain's auth and persist the result. `db` is RLS-scoped (the route uses the caller's
 * client → a cross-org domainId returns nothing → null → the route 404s). tracking_status (an ESP
 * CNAME) is left untouched. Returns the updated row, or null when the domain isn't visible.
 */
export async function verifyAndStoreDomainAuth(
  db: SupabaseClient,
  domainId: string,
  opts: { resolve?: TxtResolver; dkimSelector?: string | null } = {},
): Promise<Record<string, unknown> | null> {
  const dom = await db.from('domains').select('id, domain').eq('id', domainId).maybeSingle();
  if (dom.error) throw dom.error;
  if (!dom.data) return null;

  const auth = await verifyDomainAuth(dom.data.domain as string, opts);

  const upd = await db
    .from('domains')
    .update({
      spf_status: auth.spf,
      dkim_status: auth.dkim,
      dmarc_status: auth.dmarc,
      verified_at: new Date().toISOString(),
    })
    .eq('id', domainId)
    .select('*')
    .single();
  if (upd.error) throw upd.error;
  return upd.data;
}
