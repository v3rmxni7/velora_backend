import { describe, expect, it } from 'vitest';
import { type TxtResolver, verifyDomainAuth } from './dns-verify.js';

// Build a fake resolver: known hosts return TXT chunk-arrays; unknown hosts throw NXDOMAIN; `errors`
// forces a specific error code (e.g. a timeout) for a host.
function resolver(
  records: Record<string, string[][]>,
  errors: Record<string, string> = {},
): TxtResolver {
  return async (host: string) => {
    const errCode = errors[host];
    if (errCode) {
      const e = new Error('dns') as Error & { code: string };
      e.code = errCode;
      throw e;
    }
    const rec = records[host];
    if (!rec) {
      const e = new Error('nxdomain') as Error & { code: string };
      e.code = 'ENOTFOUND';
      throw e;
    }
    return rec;
  };
}

describe('verifyDomainAuth', () => {
  it('passes SPF + DMARC when records exist; DKIM is unknown without a selector', async () => {
    const r = resolver({
      'acme.com': [['v=spf1 include:_spf.google.com ~all']],
      '_dmarc.acme.com': [['v=DMARC1; p=reject']],
    });
    const res = await verifyDomainAuth('acme.com', { resolve: r });
    expect(res.spf).toBe('pass');
    expect(res.dmarc).toBe('pass');
    expect(res.dkim).toBe('unknown'); // honest: can't check DKIM without a selector
  });

  it('a genuinely-missing record (NXDOMAIN) is a fail; a present-but-wrong record is a fail', async () => {
    const r = resolver({ 'acme.com': [['some unrelated txt']] }); // apex present w/o spf; _dmarc NXDOMAIN
    const res = await verifyDomainAuth('acme.com', { resolve: r });
    expect(res.spf).toBe('fail');
    expect(res.dmarc).toBe('fail');
  });

  it('a network/timeout error is UNKNOWN, never a false fail', async () => {
    const r = resolver({}, { 'acme.com': 'ETIMEOUT', '_dmarc.acme.com': 'ESERVFAIL' });
    const res = await verifyDomainAuth('acme.com', { resolve: r });
    expect(res.spf).toBe('unknown');
    expect(res.dmarc).toBe('unknown');
  });

  it('checks DKIM at <selector>._domainkey when a selector is configured', async () => {
    const r = resolver({ 'sel._domainkey.acme.com': [['v=DKIM1; k=rsa; p=MIGfMA0...']] });
    const res = await verifyDomainAuth('acme.com', { resolve: r, dkimSelector: 'sel' });
    expect(res.dkim).toBe('pass');
  });

  it('joins multi-chunk TXT records before matching', async () => {
    const r = resolver({ 'acme.com': [['v=sp', 'f1 ~all']] });
    expect((await verifyDomainAuth('acme.com', { resolve: r })).spf).toBe('pass');
  });
});
